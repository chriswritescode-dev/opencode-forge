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
const ACTIVITY_MAX = 100
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
  activity: () => OpencodeActivityEvent[]
  connectActivity: () => void
  disconnectActivity: () => void
}

export function createOpencodeStore(): OpencodeStore {
  const [sessions, setSessions] = createSignal<OpencodeSessionRow[]>([])
  const [sessionsAvailable, setSessionsAvailable] = createSignal(false)
  const [sessionsLoading, setSessionsLoading] = createSignal(false)
  const [sessionsError, setSessionsError] = createSignal<string | null>(null)
  const [sessionsGeneratedAt, setSessionsGeneratedAt] = createSignal(0)

  const [transcripts, setTranscripts] = createStore<{ [sessionId: string]: TranscriptEntry[] }>({})

  const [activity, setActivity] = createSignal<OpencodeActivityEvent[]>([])
  let activityEs: EventSource | null = null
  let activityConnected = false

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
    // Return early if already cached — avoids unnecessary refetching
    if (transcripts[sessionId]) return
    try {
      const res = await fetch('/api/opencode/sessions/' + encodeURIComponent(sessionId), { cache: 'no-store' })
      const json: OpencodeTranscriptPayload = await res.json()
      if (json.available) {
        setTranscripts(sessionId, json.entries)
        // Cap transcript cache to MAX_TRANSCRIPTS entries (insertion-order eviction)
        const keys = Object.keys(transcripts)
        if (keys.length > MAX_TRANSCRIPTS) {
          const toEvict = keys.slice(0, keys.length - MAX_TRANSCRIPTS)
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

  const connectActivity = () => {
    if (activityConnected) return
    if (typeof EventSource === 'undefined') return
    activityConnected = true
    activityEs = new EventSource('/api/opencode/events')
    activityEs.onmessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as OpencodeActivityEvent
        setActivity(prev => {
          const next = [event, ...prev]
          if (next.length > ACTIVITY_MAX) next.length = ACTIVITY_MAX
          return next
        })
      } catch {
        // ignore parse errors
      }
    }
  }

  const disconnectActivity = () => {
    activityConnected = false
    if (activityEs) {
      activityEs.close()
      activityEs = null
    }
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
    activity,
    connectActivity,
    disconnectActivity,
  }
}
