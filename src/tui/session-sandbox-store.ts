import { FORGE_HOST_SANDBOX_DISABLED_ERROR } from '../host/forge-rpc'
import type {
  SessionSandboxAppliedState,
  SessionSandboxControllerState,
  SessionSandboxDesiredState,
} from '../storage/repos/session-sandbox-preferences-repo'

export interface SessionSandboxPreference {
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller?: SessionSandboxControllerState | null
  activeLoopSandboxes?: Record<string, boolean>
  /**
   * True when the preference read could not reach the server or the server could
   * not resolve it. This lets callers distinguish "no persisted state" from "the
   * read failed" so they can keep polling instead of permanently treating a
   * transient failure as OFF.
   */
  unavailable?: boolean
  /** Why the read was unavailable, for the failure toast. */
  unavailableReason?: string
}

/**
 * Returns a blocking reason when the toggle must not write desired state, or
 * null to proceed. When sandboxing is disabled by configuration the server
 * never constructs a reconciler, so a persisted request could never be
 * acknowledged and would linger until it is unexpectedly applied after
 * sandboxing is re-enabled.
 */
export function hostSandboxToggleBlocked(configEnabled: boolean): string | null {
  if (!configEnabled) return FORGE_HOST_SANDBOX_DISABLED_ERROR
  return null
}

/**
 * Returns the trusted applied state for a preference pair, or null. ON is trusted
 * only when the desired and applied revisions match, both target the same session,
 * desired is enabled, and the applied row carries no error. Stale or mismatched
 * revisions always derive to null so a late or superseded acknowledgement never
 * falsely reports ON.
 */
export function deriveSessionSandboxAcknowledged(
  pref: SessionSandboxPreference,
): SessionSandboxAppliedState | null {
  const { desired, applied } = pref
  if (
    desired &&
    applied &&
    desired.revision === applied.revision &&
    desired.enabled &&
    applied.enabled &&
    desired.sessionId === applied.sessionId &&
    applied.error == null
  ) {
    return applied
  }
  return null
}

/**
 * Returns true when the preference pair has reached a terminal state and no
 * further polling is needed: either no desired state is persisted, or the
 * applied row carries the desired revision (regardless of enabled/error). A
 * pair is pending only while a desired state awaits its matching applied
 * acknowledgement.
 */
export function isSessionSandboxPreferenceSettled(pref: SessionSandboxPreference): boolean {
  const { desired, applied } = pref
  if (!desired) return true
  if (!applied) return false
  return applied.revision === desired.revision
}

export type SessionSandboxDisplayStatus = 'enabled' | 'disabled' | 'loading' | 'failed'

export function deriveSandboxPollDelayMs(pref: SessionSandboxPreference): number {
  if (pref.unavailable) return 5000
  if (!isSessionSandboxPreferenceSettled(pref)) return 1500
  return pref.desired ? 10_000 : 5000
}

export function deriveSessionSandboxDisplayStatus(
  pref: SessionSandboxPreference | null,
  sessionId?: string,
): SessionSandboxDisplayStatus {
  if (!pref || !sessionId) return 'disabled'
  if (pref.activeLoopSandboxes && Object.hasOwn(pref.activeLoopSandboxes, sessionId)) {
    return pref.activeLoopSandboxes[sessionId] ? 'enabled' : 'disabled'
  }
  const controller = pref.controller
  if (
    controller &&
    controller.revision === pref.desired?.revision &&
    controller.sessionId === sessionId
  ) {
    if (controller.phase === 'loading' && pref.desired?.enabled) return 'loading'
    if (controller.phase === 'failed') return 'failed'
  }
  const acknowledged = deriveSessionSandboxAcknowledged(pref)
  if (acknowledged?.sessionId === sessionId) return 'enabled'
  if (
    pref.desired?.sessionId === sessionId &&
    pref.desired.enabled &&
    isSessionSandboxPreferenceSettled(pref)
  ) {
    return 'failed'
  }
  if (pref.desired?.sessionId === sessionId && !isSessionSandboxPreferenceSettled(pref)) return 'loading'
  return 'disabled'
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sandbox state request cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Sandbox state request cancelled'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Polls the async reader until the applied row carries the requested revision.
 * Returns the applied state. Throws on a matching `error`, on timeout, or when
 * cancelled via `signal`. Stale applied revisions are ignored.
 */
export async function awaitSessionSandboxState(
  read: () => Promise<SessionSandboxPreference>,
  revision: string,
  opts: { timeoutMs: number; pollMs: number; signal?: AbortSignal },
): Promise<SessionSandboxAppliedState> {
  const start = Date.now()
  while (true) {
    // Check cancellation before each read so an already-aborted waiter never returns an existing
    // acknowledgement; cancellation is only meaningful at read boundaries, not only while sleeping.
    if (opts.signal?.aborted) throw new Error('Sandbox state request cancelled')
    const { applied } = await read()
    if (applied && applied.revision === revision) {
      // A non-null error — including an empty string — rejects the request.
      if (applied.error !== null) throw new Error(applied.error)
      return applied
    }
    // Read before declaring timeout so any matching acknowledgement present by the deadline
    // (including one that arrives during the final sleep) resolves successfully.
    const elapsed = Date.now() - start
    if (elapsed >= opts.timeoutMs) break
    await abortableSleep(Math.min(opts.pollMs, opts.timeoutMs - elapsed), opts.signal)
  }
  throw new Error(`Timed out waiting for sandbox acknowledgement after ${opts.timeoutMs}ms`)
}
