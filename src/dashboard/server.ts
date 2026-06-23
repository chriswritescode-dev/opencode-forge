import type { Database } from 'bun:sqlite'
import type { OpencodeDataSource } from '../observability/data-source'
import type {
  OpencodeActivityEvent,
  OpencodeSessionsPayload,
  OpencodeTranscriptPayload,
} from '../observability/types'
import { collectDashboardData } from './data'
import { renderDashboardHtml } from './render'
import type { EventBroadcaster } from './event-broadcaster'
export type { EventBroadcaster }

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Interval between SSE heartbeat comments, in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 25_000

export interface DashboardDeps {
  forgeDb: Database
  opencode?: OpencodeDataSource | null
  events?: EventBroadcaster | null
}

// ---------------------------------------------------------------------------
// Limit-query helper
// ---------------------------------------------------------------------------

/**
 * Parse and clamp a `limit` query parameter.
 *
 * Returns `options.defaultValue` when:
 * - `raw` is null (param absent)
 * - `raw` cannot be parsed as a finite number (NaN, Infinity, garbage)
 *
 * Finite values are rounded and clamped to `[options.min, options.max]`.
 */
function parseLimit(
  raw: string | null,
  options: { min: number; max: number; defaultValue: number },
): number {
  if (raw === null) return options.defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n)) return options.defaultValue
  return Math.max(options.min, Math.min(options.max, Math.round(n)))
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function sessionsPayload(deps: DashboardDeps, limit: number): OpencodeSessionsPayload {
  return {
    generatedAt: Date.now(),
    available: deps.opencode?.available ?? false,
    sessions: deps.opencode?.listRecentSessions(limit) ?? [],
  }
}

function transcriptPayload(
  deps: DashboardDeps,
  sessionId: string,
  limit: number,
): OpencodeTranscriptPayload {
  return {
    generatedAt: Date.now(),
    available: deps.opencode?.available ?? false,
    sessionId,
    entries: deps.opencode?.getSessionTranscript(sessionId, limit) ?? [],
  }
}

// ---------------------------------------------------------------------------
// Request handler factory
// ---------------------------------------------------------------------------

export function createRequestHandler(deps: DashboardDeps): (req: Request) => Response {
  const html = renderDashboardHtml()
  return (req: Request): Response => {
    if (req.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    const url = new URL(req.url)
    const pathname = url.pathname

    // ── Static routes ────────────────────────────────────────────────────

    if (pathname === '/') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (pathname === '/api/data') {
      const data = collectDashboardData(deps.forgeDb)
      return new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    // ── OpenCode sessions list ───────────────────────────────────────────

    if (pathname === '/api/opencode/sessions') {
      const limit = parseLimit(url.searchParams.get('limit'), {
        min: 1, max: 200, defaultValue: 50,
      })
      return new Response(JSON.stringify(sessionsPayload(deps, limit)), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    // ── OpenCode activity events (SSE) ───────────────────────────────────

    if (pathname === '/api/opencode/events') {
      if (!deps.events) {
        return new Response(null, { status: 204 })
      }

      let unsub: (() => void) | null = null
      let heartbeat: ReturnType<typeof setInterval> | null = null
      const encoder = new TextEncoder()

      function teardown(): void {
        unsub?.()
        unsub = null
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
      }

      const stream = new ReadableStream({
        start(controller) {
          // SSE connection-establishment comment
          controller.enqueue(encoder.encode(': connected\n\n'))

          // Replay recent events so late joiners see recent activity
          for (const event of deps.events!.recent()) {
            const line = `data: ${JSON.stringify(event)}\n\n`
            controller.enqueue(encoder.encode(line))
          }

          // Subscribe for future events
          unsub = deps.events!.subscribe((event: OpencodeActivityEvent) => {
            try {
              const line = `data: ${JSON.stringify(event)}\n\n`
              controller.enqueue(encoder.encode(line))
            } catch {
              // Stream may already be closed; ignore enqueue errors.
            }
          })

          // Periodic heartbeat keeps the connection alive through any
          // intermediaries and surfaces dead clients so we can clean up.
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'))
            } catch {
              teardown()
            }
          }, HEARTBEAT_INTERVAL_MS)
        },
        cancel() {
          teardown()
        },
      })

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        },
      })
    }

    // ── OpenCode session transcript ──────────────────────────────────────

    const transcriptMatch = pathname.match(/^\/api\/opencode\/sessions\/(.+)$/)
    if (transcriptMatch) {
      const sessionId = decodeURIComponent(transcriptMatch[1])
      const limit = parseLimit(url.searchParams.get('limit'), {
        min: 1, max: 2000, defaultValue: 500,
      })
      return new Response(JSON.stringify(transcriptPayload(deps, sessionId, limit)), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}
