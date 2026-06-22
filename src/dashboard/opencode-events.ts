import type { OpencodeActivityEvent } from '../observability/types'
import type { DashboardEventSource } from '../types'
import { ForgeClientError, type ForgeClient, type GlobalActivityEvent } from '../client/port'

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

/** Default curated set kept small so the feed is not flooded by part updates. */
export const CURATED_EVENT_TYPES = [
  'session.idle',
  'session.created',
  'session.updated',
  'session.error',
] as const

/**
 * Extract the activity fields (`sessionId`, `title`, `directory`) shared by the
 * TUI-bus and server-global event shapes. `directoryOverride` takes precedence
 * over `info.directory` and is supplied by the global stream's wrapper, which
 * is authoritative.
 */
function extractActivity(
  raw: unknown,
  directoryOverride?: string | null,
): Pick<OpencodeActivityEvent, 'sessionId' | 'title' | 'directory'> {
  const props: Record<string, unknown> = isRecord(raw) && isRecord(raw.properties) ? raw.properties : {}
  const info: Record<string, unknown> = isRecord(props.info) ? props.info : {}
  const infoDirectory = typeof info.directory === 'string' ? info.directory : null
  return {
    sessionId:
      typeof info.id === 'string'
        ? info.id
        : typeof props.sessionID === 'string'
          ? props.sessionID
          : null,
    title: typeof info.title === 'string' ? info.title : null,
    directory: directoryOverride && directoryOverride.length > 0 ? directoryOverride : infoDirectory,
  }
}

function normalizeEvent(type: string, raw: unknown, directoryOverride?: string | null): OpencodeActivityEvent {
  return { type, ...extractActivity(raw, directoryOverride), time: Date.now() }
}

/** Read the `type` field from a raw OpenCode event payload, or '' when absent. */
function payloadType(payload: unknown): string {
  return isRecord(payload) && typeof payload.type === 'string' ? payload.type : ''
}

// ---------------------------------------------------------------------------
// Forwarders
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

/**
 * Subscribe to the OpenCode server's global event stream (all projects/sessions
 * on that server) via the forge client port and forward each allowlisted event
 * through `publish` as a normalised `OpencodeActivityEvent`.
 *
 * The wrapper's `directory` is authoritative and used as the activity
 * directory. Events whose type is not in `types` (default
 * {@link CURATED_EVENT_TYPES}) are dropped to keep the feed focused.
 *
 * Returns a detach function that aborts the underlying subscription.
 */
export function forwardGlobalEvents(
  client: ForgeClient,
  publish: (event: OpencodeActivityEvent) => void,
  opts?: { types?: readonly string[]; onError?: (err: unknown) => void },
): () => void {
  const allow = new Set<string>(opts?.types ?? CURATED_EVENT_TYPES)
  return client.events.subscribeGlobal(
    (event: GlobalActivityEvent) => {
      const type = payloadType(event.payload)
      if (!allow.has(type)) return
      publish(normalizeEvent(type, event.payload, event.directory))
    },
    { onError: opts?.onError },
  )
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

/** Resolved configuration for the dashboard activity feed source. */
export interface ActivityForwardingConfig {
  /** Event source; defaults to `server`. */
  source?: DashboardEventSource
  /** Event type allowlist (server source only). */
  types?: readonly string[]
}

/** Runtime dependencies available at the call site for forwarding. */
export interface ActivityForwardingDeps {
  publish: (event: OpencodeActivityEvent) => void
  /** In-process or server-targeted forge client (server source). */
  client?: ForgeClient | null
  /** TUI event bus (tui source, or server fallback). */
  eventBus?: EventBus | null
  /** Observed errors from the underlying subscription. */
  onError?: (err: unknown) => void
}

/**
 * Single decision point for wiring the dashboard live activity feed. Selects
 * the event source from config and returns a detach function.
 *
 * - `none`: no feed.
 * - `tui`: subscribe to the in-process TUI event bus (when present).
 * - `server` (default): subscribe to the server global stream via `client`.
 *   If the host SDK lacks the global endpoint, falls back to the TUI bus when
 *   one is available; otherwise yields no feed.
 */
export function startActivityForwarding(
  config: ActivityForwardingConfig,
  deps: ActivityForwardingDeps,
): () => void {
  const source: DashboardEventSource = config.source ?? 'server'
  const { publish, client, eventBus } = deps

  if (source === 'none') return () => {}

  if (source === 'tui') {
    return eventBus ? forwardOpencodeEvents(eventBus, publish) : () => {}
  }

  // source === 'server'
  if (!client) {
    // No client to subscribe to; use the TUI bus when available as a fallback.
    return eventBus ? forwardOpencodeEvents(eventBus, publish) : () => {}
  }

  let fallbackDetach: (() => void) | null = null
  const detachGlobal = forwardGlobalEvents(client, publish, {
    types: config.types,
    onError: (err) => {
      deps.onError?.(err)
      // When the global endpoint is unavailable, fall back to the TUI bus once.
      const unavailable = err instanceof ForgeClientError && err.kind === 'unavailable'
      if (unavailable && eventBus && !fallbackDetach) {
        fallbackDetach = forwardOpencodeEvents(eventBus, publish)
      }
    },
  })

  return () => {
    detachGlobal()
    fallbackDetach?.()
  }
}
