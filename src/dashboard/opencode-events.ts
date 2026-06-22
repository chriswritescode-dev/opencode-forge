import type { OpencodeActivityEvent } from '../observability/types'

// ---------------------------------------------------------------------------
// Minimal structural interface (compatible with TuiEventBus from
// @opencode-ai/plugin/tui but avoids a hard dependency on its type).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface EventBus {
  on(type: string, handler: (event: unknown) => void): () => void
}

// ---------------------------------------------------------------------------
// Event normalisation
// ---------------------------------------------------------------------------

const CURATED_EVENT_TYPES = [
  'session.idle',
  'session.created',
  'session.updated',
  'session.error',
] as const

function normalizeEvent(type: string, raw: unknown): OpencodeActivityEvent {
  const props: Record<string, unknown> = isRecord(raw) && isRecord(raw.properties) ? raw.properties : {}
  const info: Record<string, unknown> = isRecord(props.info) ? props.info : {}
  return {
    type,
    sessionId: typeof info.id === 'string' ? info.id : typeof props.sessionID === 'string' ? props.sessionID : null,
    title: typeof info.title === 'string' ? info.title : null,
    directory: typeof info.directory === 'string' ? info.directory : null,
    time: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Forwarder
// ---------------------------------------------------------------------------

/**
 * Subscribe to a curated set of OpenCode activity events and forward each one
 * through the supplied `publish` function as a normalised `OpencodeActivityEvent`.
 *
 * Returns a detach function that unsubscribes every subscription.  Each
 * unsubscribe is wrapped in its own try/catch so a single throwing unsubscribe
 * does not prevent the rest from running.
 */
export function forwardOpencodeEvents(
  eventBus: EventBus,
  publish: (event: OpencodeActivityEvent) => void,
): () => void {
  const unsubscribes: (() => void)[] = []

  for (const type of CURATED_EVENT_TYPES) {
    const unsub = eventBus.on(type, (event: unknown) => {
      publish(normalizeEvent(type, event))
    })
    unsubscribes.push(unsub)
  }

  return () => {
    for (const unsub of unsubscribes) {
      try {
        unsub()
      } catch {
        // individual unsubscribe errors must not prevent the rest from running
      }
    }
  }
}
