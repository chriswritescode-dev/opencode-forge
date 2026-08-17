import type { Database } from 'bun:sqlite'
import type { ForgeClient } from '../client/port'
import { createLoopsRepo, createPlanAmendmentsRepo } from '../storage'
import { providersFromProviderList, flattenProviders, getAvailableModelVariants } from '../utils/tui-models'
import { parseModelString } from '../utils/model-fallback'
import { collectDashboardData } from './data'
import { diffAmendmentSnapshots } from './amendment-diff'
import { renderDashboardHtml } from './render'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  forgeDb: Database
  /**
   * Live opencode client. Present only when the dashboard was launched from the
   * TUI (which has an in-process client). Without it the live session routes
   * report 503 and the dashboard stays a read-only view of forge state.
   */
  client?: ForgeClient
  /**
   * Whether `POST /api/loop/message` is allowed. Set only for a loopback bind:
   * the dashboard has no auth, so a reachable bind must not drive the agent.
   */
  allowSend?: boolean
}

// ---------------------------------------------------------------------------
// Live session routes
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 10000

/** The live session the dashboard talks to for a loop, resolved server-side. */
interface LoopTarget {
  sessionId: string
  directory: string
  workspaceId?: string
}

/** Events worth forwarding to the browser for a live transcript. */
const LIVE_EVENT_TYPES = new Set([
  'message.updated',
  'message.part.updated',
  'message.part.removed',
  'message.removed',
  'session.status',
  'session.idle',
  'session.error',
])

function eventSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const props = (event as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return null
  const sessionID = (props as { sessionID?: unknown }).sessionID
  return typeof sessionID === 'string' ? sessionID : null
}

function eventType(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Variants are opaque keys from the provider catalogue; keep them token-shaped. */
const VARIANT_PATTERN = /^[\w.:-]{1,64}$/

type ModelFieldResult = { ok: true; value: string | null | undefined } | { ok: false; error: string }

/**
 * Read one role's model field. `undefined` leaves the role untouched, `null`
 * clears it back to the configured default, and a string must parse as
 * `provider/model`.
 */
function readModelField(raw: unknown, label: string): ModelFieldResult {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string, null, or omitted.` }
  if (!parseModelString(raw)) {
    return { ok: false, error: `${label} must look like "provider/model" (got ${JSON.stringify(raw)}).` }
  }
  return { ok: true, value: raw }
}

function readVariantField(raw: unknown, label: string): ModelFieldResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string or null.` }
  if (!VARIANT_PATTERN.test(raw)) return { ok: false, error: `${label} is not a valid variant key.` }
  return { ok: true, value: raw }
}

/** How often the stream re-checks the stored transcript when no events arrive. */
const TRANSCRIPT_POLL_MS = 4000

/**
 * Cheap fingerprint of a transcript: message and part identity plus the fields
 * that change as a turn progresses (tool status, text length). Compared between
 * polls to detect content the event stream never delivered.
 */
function transcriptSignature(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const entry of messages) {
    const wrapper = entry as { info?: { id?: unknown }; parts?: unknown }
    parts.push(String(wrapper?.info?.id ?? '?'))
    if (!Array.isArray(wrapper?.parts)) continue
    for (const raw of wrapper.parts) {
      const part = raw as { id?: unknown; text?: unknown; state?: { status?: unknown } }
      const text = typeof part?.text === 'string' ? part.text.length : 0
      parts.push(`${String(part?.id ?? '?')}:${String(part?.state?.status ?? '')}:${text}`)
    }
  }
  return parts.join('|')
}

export function createRequestHandler(deps: DashboardDeps): (req: Request) => Promise<Response> {
  const html = renderDashboardHtml()
  const client = deps.client
  const allowSend = deps.allowSend ?? false
  const loopsRepo = createLoopsRepo(deps.forgeDb)
  let amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo> | null = null
  try {
    amendmentsRepo = createPlanAmendmentsRepo(deps.forgeDb)
  } catch {
    amendmentsRepo = null
  }

  /**
   * Resolve the loop's current session. The browser never supplies a session
   * id — it names a loop, and the current session is read from forge state, so
   * a rotated loop cannot be addressed through a stale id.
   */
  function resolveTarget(projectId: string | null, loopName: string | null): LoopTarget | null {
    if (!projectId || !loopName) return null
    const loop = loopsRepo.get(projectId, loopName)
    if (!loop || !loop.currentSessionId) return null
    return {
      sessionId: loop.currentSessionId,
      directory: loop.worktreeDir,
      ...(loop.workspaceId ? { workspaceId: loop.workspaceId } : {}),
    }
  }

  /**
   * Stream one loop session to the browser: a `snapshot` of the transcript as
   * it stands, then the host's own events for that session. Nothing is stored;
   * closing the request tears the upstream subscription down.
   *
   * opencode's event bus is per-process, so a loop being driven by a *different*
   * opencode process emits nothing here even though its transcript (shared
   * storage) keeps advancing. A periodic re-read covers that case: when the
   * stored transcript moves without a matching event, a fresh snapshot is
   * pushed and tagged `poll` so the browser can say it is refreshing rather
   * than streaming.
   */
  function streamSession(req: Request, target: LoopTarget, live: ForgeClient): Response {
    const encoder = new TextEncoder()
    let subscription: { stream: AsyncGenerator<unknown> } | null = null
    let poller: ReturnType<typeof setInterval> | null = null

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true
        let lastEventAt = 0
        let signature = ''
        const send = (event: string, data: unknown): void => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(sseFrame(event, data)))
          } catch {
            open = false
          }
        }
        const stopPolling = (): void => {
          if (poller) clearInterval(poller)
          poller = null
        }
        const close = (): void => {
          stopPolling()
          if (!open) return
          open = false
          try {
            controller.close()
          } catch {
            // already closed by the consumer
          }
        }
        req.signal.addEventListener('abort', () => {
          open = false
          stopPolling()
          void subscription?.stream.return(undefined)
        })

        const readTranscript = async (): Promise<unknown[] | null> => {
          try {
            return await live.session.messages({
              sessionID: target.sessionId,
              directory: target.directory,
            }) as unknown[]
          } catch {
            return null
          }
        }

        try {
          const messages = await live.session.messages({
            sessionID: target.sessionId,
            directory: target.directory,
          })
          signature = transcriptSignature(messages)
          send('snapshot', { sessionId: target.sessionId, messages, reason: 'initial' })
        } catch (err) {
          send('failed', { message: `Could not load the transcript: ${errorMessage(err)}` })
          close()
          return
        }

        poller = setInterval(() => {
          if (!open) return
          // Events are arriving; the stream is authoritative.
          if (Date.now() - lastEventAt < TRANSCRIPT_POLL_MS) return
          void readTranscript().then((messages) => {
            if (!open || messages === null) return
            const next = transcriptSignature(messages)
            if (next === signature) return
            signature = next
            send('snapshot', { sessionId: target.sessionId, messages, reason: 'poll' })
          })
        }, TRANSCRIPT_POLL_MS)

        try {
          // Loop sessions are workspace-bound, and the host's event bus is
          // scoped per workspace: subscribing with the directory alone lands
          // on a bus that never carries this session's events.
          subscription = await live.event.subscribe({
            directory: target.directory,
            ...(target.workspaceId ? { workspace: target.workspaceId } : {}),
          })
          for await (const event of subscription.stream) {
            if (!open || req.signal.aborted) break
            const type = eventType(event)
            if (!type || !LIVE_EVENT_TYPES.has(type)) continue
            if (eventSessionId(event) !== target.sessionId) continue
            lastEventAt = Date.now()
            send('event', event)
          }
        } catch (err) {
          send('failed', { message: `Live stream ended: ${errorMessage(err)}` })
        }
        close()
      },
      cancel() {
        if (poller) clearInterval(poller)
        poller = null
        void subscription?.stream.return(undefined)
      },
    })

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    })
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === '/api/loop/stream') {
      if (req.method !== 'GET') return new Response('Not found', { status: 404 })
      if (!client) {
        return new Response(
          'Live view unavailable: this dashboard was not launched from the opencode TUI.',
          { status: 503 },
        )
      }
      const target = resolveTarget(url.searchParams.get('project'), url.searchParams.get('loop'))
      if (!target) return new Response('Loop has no active session.', { status: 404 })
      return streamSession(req, target, client)
    }

    if (pathname === '/api/loop/message') {
      if (req.method !== 'POST') return new Response('Not found', { status: 404 })
      if (!client) {
        return new Response(
          'Sending is unavailable: this dashboard was not launched from the opencode TUI.',
          { status: 503 },
        )
      }
      if (!allowSend) {
        return new Response(
          'Sending is disabled: the dashboard is bound to a non-loopback address and has no ' +
          'authentication. Open it via localhost to send messages.',
          { status: 403 },
        )
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return new Response('Request body must be valid JSON.', { status: 400 })
      }
      const record = (body ?? {}) as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (!text) return new Response('text must be a non-empty string.', { status: 400 })
      if (text.length > MAX_MESSAGE_LENGTH) {
        return new Response(`text must be at most ${MAX_MESSAGE_LENGTH} characters.`, { status: 400 })
      }
      const target = resolveTarget(
        typeof record.projectId === 'string' ? record.projectId : null,
        typeof record.loopName === 'string' ? record.loopName : null,
      )
      if (!target) return new Response('Loop has no active session.', { status: 404 })

      try {
        await client.session.promptAsync({
          sessionID: target.sessionId,
          directory: target.directory,
          ...(target.workspaceId ? { workspace: target.workspaceId } : {}),
          parts: [{ type: 'text', text }],
        })
      } catch (err) {
        return new Response(`Could not send the message: ${errorMessage(err)}`, { status: 502 })
      }
      return new Response(JSON.stringify({ ok: true, sessionId: target.sessionId }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (pathname === '/api/models') {
      if (req.method !== 'GET') return new Response('Not found', { status: 404 })
      if (!client) {
        return new Response(
          'Model list unavailable: this dashboard was not launched from the opencode TUI.',
          { status: 503 },
        )
      }
      const target = resolveTarget(url.searchParams.get('project'), url.searchParams.get('loop'))
      try {
        const data = await client.provider.list(target ? { directory: target.directory } : undefined)
        const { providers } = providersFromProviderList(data)
        const models = flattenProviders(providers).map(m => ({
          id: m.fullName,
          name: m.name,
          provider: m.providerName,
          variants: getAvailableModelVariants(m).map(v => ({ id: v.id, label: v.label })),
        }))
        return new Response(JSON.stringify({ models }), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch (err) {
        return new Response(`Could not list models: ${errorMessage(err)}`, { status: 502 })
      }
    }

    if (pathname === '/api/loop/models') {
      if (req.method !== 'POST') return new Response('Not found', { status: 404 })
      if (!allowSend) {
        return new Response(
          'Changing models is disabled: the dashboard is bound to a non-loopback address and has ' +
          'no authentication. Open it via localhost to change models.',
          { status: 403 },
        )
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return new Response('Request body must be valid JSON.', { status: 400 })
      }
      const record = (body ?? {}) as Record<string, unknown>
      const projectId = typeof record.projectId === 'string' ? record.projectId : null
      const loopName = typeof record.loopName === 'string' ? record.loopName : null
      if (!projectId || !loopName) {
        return new Response('projectId and loopName are required.', { status: 400 })
      }
      const loop = loopsRepo.get(projectId, loopName)
      if (!loop) return new Response('Loop not found.', { status: 404 })

      const executionModel = readModelField(record.executionModel, 'executionModel')
      if (!executionModel.ok) return new Response(executionModel.error, { status: 400 })
      const auditorModel = readModelField(record.auditorModel, 'auditorModel')
      if (!auditorModel.ok) return new Response(auditorModel.error, { status: 400 })
      const executionVariant = readVariantField(record.executionVariant, 'executionVariant')
      if (!executionVariant.ok) return new Response(executionVariant.error, { status: 400 })
      const auditorVariant = readVariantField(record.auditorVariant, 'auditorVariant')
      if (!auditorVariant.ok) return new Response(auditorVariant.error, { status: 400 })
      if (executionModel.value === undefined && auditorModel.value === undefined) {
        return new Response('Provide executionModel and/or auditorModel.', { status: 400 })
      }

      loopsRepo.setModels(projectId, loopName, {
        ...(executionModel.value !== undefined
          ? { executionModel: executionModel.value, executionVariant: executionVariant.value ?? null }
          : {}),
        ...(auditorModel.value !== undefined
          ? { auditorModel: auditorModel.value, auditorVariant: auditorVariant.value ?? null }
          : {}),
      })

      const updated = loopsRepo.get(projectId, loopName)
      return new Response(JSON.stringify({
        ok: true,
        executionModel: updated?.executionModel ?? null,
        executionVariant: updated?.executionVariant ?? null,
        auditorModel: updated?.auditorModel ?? null,
        auditorVariant: updated?.auditorVariant ?? null,
      }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (req.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    if (pathname === '/') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (pathname === '/api/data') {
      const data = collectDashboardData(deps.forgeDb, {
        projectId: url.searchParams.get('project'),
        loopName: url.searchParams.get('loop'),
      })
      return new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    if (pathname === '/api/amendment') {
      const project = url.searchParams.get('project')
      const loop = url.searchParams.get('loop')
      const rawId = url.searchParams.get('id')
      if (!project || !loop || rawId === null || !/^\d+$/.test(rawId)) {
        return new Response('project, loop and a numeric id are required.', { status: 400 })
      }
      const id = Number(rawId)
      if (!Number.isSafeInteger(id)) {
        return new Response('project, loop and a numeric id are required.', { status: 400 })
      }
      if (!amendmentsRepo) {
        return new Response('Amendment not found.', { status: 404 })
      }
      const row = amendmentsRepo.get(project, loop, id)
      if (!row) {
        return new Response('Amendment not found.', { status: 404 })
      }
      return new Response(JSON.stringify(diffAmendmentSnapshots(row.sectionsBefore, row.sectionsAfter)), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}
