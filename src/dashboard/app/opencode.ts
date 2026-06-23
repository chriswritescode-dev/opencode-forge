import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type {
  OpencodeSessionRow,
  OpencodeSessionsPayload,
  OpencodeTranscriptPayload,
  TranscriptEntry,
  OpencodeActivityEvent,
} from './opencode-types'

const SESSIONS_LIMIT = 50
const MAX_TRANSCRIPTS = 10
const SESSION_COMPARE_FIELDS: (keyof OpencodeSessionRow)[] = [
  'id', 'title', 'directory', 'projectName', 'worktree', 'agent',
  'modelId', 'providerId', 'cost',
  'tokensInput', 'tokensOutput', 'tokensReasoning',
  'tokensCacheRead', 'tokensCacheWrite',
  'timeCreated', 'timeUpdated',
]

/** Shallow-compare two session arrays on the fields that affect grouping/list display. */
function sessionsEqual(a: OpencodeSessionRow[], b: OpencodeSessionRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]
    const sb = b[i]
    for (const field of SESSION_COMPARE_FIELDS) {
      if (sa[field] !== sb[field]) return false
    }
  }
  return true
}

export interface OpencodeStore {
  sessions: () => OpencodeSessionRow[]
  sessionsAvailable: () => boolean
  sessionsLoading: () => boolean
  sessionsError: () => string | null
  loadSessions: () => Promise<void>
  transcripts: { [sessionId: string]: TranscriptEntry[] }
  loadTranscript: (sessionId: string) => Promise<void>
  sessionsGeneratedAt: () => number
  /**
   * Session ids currently running (`session.status` of `busy`/`retry`). Drives
   * the live activity indicator; cleared on `idle`/`deleted`.
   */
  busySessionIds: () => Set<string>
  /**
   * Open (or re-scope) the live SSE feed. Session-level events always arrive;
   * pass the open session id to also receive its transcript part events.
   */
  connectActivity: (sessionId: string | null) => void
  disconnectActivity: () => void
}

/**
 * Reactive store for opencode sessions/transcripts. The DB-backed endpoints
 * (`/api/opencode/...`) seed the initial list and transcript and serve search
 * / historical browsing; after that the live SSE feed drives all updates:
 * `session.*` events upsert the list and `message.part.*` events (scoped to the
 * open session) upsert its transcript. There is no timer-based polling.
 */
export function createOpencodeStore(): OpencodeStore {
  const [sessions, setSessions] = createSignal<OpencodeSessionRow[]>([])
  const [sessionsAvailable, setSessionsAvailable] = createSignal(false)
  const [sessionsLoading, setSessionsLoading] = createSignal(false)
  const [sessionsError, setSessionsError] = createSignal<string | null>(null)
  const [sessionsGeneratedAt, setSessionsGeneratedAt] = createSignal(0)

  const [transcripts, setTranscripts] = createStore<{ [sessionId: string]: TranscriptEntry[] }>({})

  // Session ids currently running, derived from `session.status` events.
  const [busySessionIds, setBusySessionIds] = createSignal<Set<string>>(new Set())
  // Per-session message metadata (role + model) used to label transcript
  // sections. Non-reactive: it only feeds role/model onto reactive entries.
  const messageMeta = new Map<string, Map<string, { role: string | null; model: string | null }>>()
  let activityEs: EventSource | null = null
  let activityConnected = false
  // The session scope of the current SSE connection; `undefined` means no
  // connection. `null` means connected but unscoped (list view, no transcript).
  let currentSessionFilter: string | null | undefined = undefined

  const loadSessions = async () => {
    setSessionsLoading(true)
    try {
      const res = await fetch('/api/opencode/sessions?limit=' + SESSIONS_LIMIT, { cache: 'no-store' })
      const json: OpencodeSessionsPayload = await res.json()
      if (json.available) {
        if (!sessionsEqual(sessions(), json.sessions)) {
          setSessions(json.sessions)
        }
        setSessionsAvailable(true)
        setSessionsGeneratedAt(json.generatedAt)
        setSessionsError(null)
      } else {
        setSessions([])
        setSessionsAvailable(false)
        setSessionsError(null)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSessionsError('Failed to load sessions: ' + msg)
      setSessionsAvailable(false)
    } finally {
      setSessionsLoading(false)
    }
  }

  const loadTranscript = async (sessionId: string) => {
    // Return early if already cached — the initial DB fetch happens once; live
    // events keep the cached transcript current thereafter.
    if (transcripts[sessionId]) return
    try {
      const res = await fetch('/api/opencode/sessions/' + encodeURIComponent(sessionId), { cache: 'no-store' })
      const json: OpencodeTranscriptPayload = await res.json()
      if (json.available) {
        setTranscripts(sessionId, json.entries)
        // Seed message metadata (role/model) from the DB-loaded entries so live
        // parts arriving before their message.updated event are labelled.
        const meta = new Map<string, { role: string | null; model: string | null }>()
        for (const e of json.entries) {
          if (!meta.has(e.messageId)) meta.set(e.messageId, { role: e.role, model: e.model })
        }
        messageMeta.set(sessionId, meta)
        // Cap transcript cache to MAX_TRANSCRIPTS entries (insertion-order eviction)
        const keys = Object.keys(transcripts)
        if (keys.length > MAX_TRANSCRIPTS) {
          const toEvict = keys.slice(0, keys.length - MAX_TRANSCRIPTS)
          for (const k of toEvict) messageMeta.delete(k)
          setTranscripts(prev => {
            const next = { ...prev }
            for (const k of toEvict) {
              delete next[k]
            }
            return next
          })
        }
      }
    } catch {
      // Silently fail — transcript is optional detail data
    }
  }

  // ── Event reducers ────────────────────────────────────────────────────────

  /** Upsert/remove a session row and keep the list ordered by `timeUpdated`. */
  const applySessionEvent = (event: OpencodeActivityEvent) => {
    const id = event.sessionId
    if (!id) return

    if (event.type === 'session.deleted') {
      setSessions(prev => prev.filter(s => s.id !== id))
      return
    }

    // session.idle / session.error carry no session info — list ordering is
    // unaffected, so there is nothing to apply beyond the activity feed.
    const incoming = event.session
    if (!incoming) return

    // Receiving a live session row implies the sessions surface is available
    // even if the initial DB load reported otherwise.
    setSessionsAvailable(true)
    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === id)
      let next: OpencodeSessionRow[]
      if (idx === -1) {
        next = [incoming, ...prev]
      } else {
        // Merge: events carry title/directory/time but not cost/tokens/model,
        // so preserve those fields from the existing (DB-sourced) row.
        const cur = prev[idx]
        next = prev.slice()
        next[idx] = {
          ...cur,
          title: incoming.title,
          directory: incoming.directory ?? cur.directory,
          projectName: cur.projectName ?? incoming.projectName,
          timeCreated: incoming.timeCreated ?? cur.timeCreated,
          timeUpdated: incoming.timeUpdated ?? cur.timeUpdated,
        }
      }
      next.sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0))
      if (next.length > SESSIONS_LIMIT) next.length = SESSIONS_LIMIT
      return next
    })
  }

  /** Upsert/remove a transcript part for an already-loaded (open) session. */
  const applyTranscriptPart = (event: OpencodeActivityEvent) => {
    const part = event.part
    if (!part) return
    const sid = part.sessionId
    // Only maintain transcripts already loaded into the cache (the open
    // session). Parts for other sessions are ignored.
    if (!(sid in transcripts)) return

    if (event.type === 'message.part.removed' || part.entry === null) {
      setTranscripts(sid, arr => arr.filter(e => e.partId !== part.partId))
      return
    }

    // Label the entry with role/model from known message metadata so live
    // parts render under the right section header.
    const meta = messageMeta.get(sid)?.get(part.entry.messageId)
    const entry = meta ? { ...part.entry, role: meta.role, model: meta.model } : part.entry
    setTranscripts(sid, arr => {
      const idx = arr.findIndex(e => e.partId === entry.partId)
      if (idx === -1) return [...arr, entry]
      const next = arr.slice()
      next[idx] = entry
      return next
    })
  }

  /** Record message role/model and backfill any already-rendered entries. */
  const applyMessageMeta = (event: OpencodeActivityEvent) => {
    const m = event.messageMeta
    if (!m) return
    const sid = m.sessionId
    if (!(sid in transcripts)) return
    let map = messageMeta.get(sid)
    if (!map) {
      map = new Map()
      messageMeta.set(sid, map)
    }
    map.set(m.messageId, { role: m.role, model: m.model })
    setTranscripts(sid, arr => {
      let changed = false
      const next = arr.map(e => {
        if (e.messageId === m.messageId && (e.role !== m.role || e.model !== m.model)) {
          changed = true
          return { ...e, role: m.role, model: m.model }
        }
        return e
      })
      return changed ? next : arr
    })
  }

  /** Add/remove a session id from the busy set, preserving identity on no-op. */
  const setBusy = (sessionId: string, busy: boolean) => {
    setBusySessionIds(prev => {
      if (busy === prev.has(sessionId)) return prev
      const next = new Set(prev)
      if (busy) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  /** Track run status from a `session.status` event (busy/retry vs idle). */
  const applySessionStatus = (event: OpencodeActivityEvent) => {
    const id = event.sessionId
    if (!id) return
    setBusy(id, event.sessionStatus === 'busy' || event.sessionStatus === 'retry')
  }

  const handleActivityEvent = (event: OpencodeActivityEvent) => {
    if (event.type.startsWith('message.part.')) {
      applyTranscriptPart(event)
      return
    }
    if (event.type === 'message.updated') {
      applyMessageMeta(event)
      return
    }
    if (event.type === 'session.status') {
      applySessionStatus(event)
      return
    }
    // A finished or removed session is no longer running.
    if (event.sessionId && (event.type === 'session.idle' || event.type === 'session.deleted')) {
      setBusy(event.sessionId, false)
    }
    applySessionEvent(event)
  }

  // ── SSE lifecycle ───────────────────────────────────────────────────────

  const closeStream = () => {
    if (activityEs) {
      activityEs.close()
      activityEs = null
    }
  }

  const connectActivity = (sessionId: string | null) => {
    if (typeof EventSource === 'undefined') return
    // Already connected with the same scope — nothing to do.
    if (activityConnected && currentSessionFilter === sessionId) return
    // Re-scope: tear down the existing connection before opening a new one so
    // the server begins/stops forwarding the open session's part events.
    closeStream()
    activityConnected = true
    currentSessionFilter = sessionId
    const url = sessionId
      ? '/api/opencode/events?session=' + encodeURIComponent(sessionId)
      : '/api/opencode/events'
    activityEs = new EventSource(url)
    activityEs.onmessage = (e: MessageEvent) => {
      try {
        handleActivityEvent(JSON.parse(e.data) as OpencodeActivityEvent)
      } catch {
        // ignore parse errors
      }
    }
  }

  const disconnectActivity = () => {
    activityConnected = false
    currentSessionFilter = undefined
    closeStream()
  }

  return {
    sessions,
    sessionsAvailable,
    sessionsLoading,
    sessionsError,
    loadSessions,
    transcripts,
    loadTranscript,
    sessionsGeneratedAt,
    busySessionIds,
    connectActivity,
    disconnectActivity,
  }
}
