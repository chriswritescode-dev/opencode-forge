import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'path'
import type { Logger } from '../types'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState, SessionSandboxPreferencesRepo } from '../storage'
import type { SandboxContext } from './context'
import type { SandboxRuntime } from './sbx'
import type { ActiveSandbox } from './manager'

export const DEFAULT_POLL_INTERVAL_MS = 500

/**
 * Cap on a single session-directory lookup during ownership resolution.
 *
 * The lookup is an HTTP call to the OpenCode server, and the startup reconcile that performs it is
 * awaited before the plugin returns its hooks. A persisted desired ON names a session from the
 * previous run, so after a restart the lookup targets a session the freshly-booting server may not
 * answer for; without a bound, plugin initialization blocks forever and the TUI never renders.
 * Exceeding this resolves to `uncertain`, which already fails closed.
 */
export const OWNERSHIP_LOOKUP_TIMEOUT_MS = 5_000

/** Error recorded on the applied row when a host sandbox is refused for an active loop session. */
export const LOOP_SESSION_REFUSED_ERROR = 'host sandbox cannot be enabled for an active loop session'

/**
 * Error used when the host-session sandbox runtime is unavailable (sandbox disabled, manager
 * initialization failed, or no shell shim). A requested ON is acknowledged as OFF with this
 * error and the selected session is blocked fail-closed rather than running on the host.
 */
export const UNAVAILABLE_SANDBOX_ERROR = 'host-session sandbox is unavailable (sandbox runtime not initialized)'

/** Error recorded on the applied row when an ON request carries no session to bind. */
export const MISSING_SESSION_ERROR = 'host sandbox cannot be enabled without a session'

/**
 * Minimum surface of `SandboxManager` the controller relies on. Kept narrow so the
 * reconciler is decoupled from the full manager and easy to fake in tests.
 */
export interface SessionSandboxLifecycleManager {
  runtime: SandboxRuntime
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
}

export type ResolveActiveLoopForSession = (sessionId: string) => Promise<{ active: boolean; sandbox?: boolean } | null>

/**
 * Fail-closed lifecycle manager used when no real sandbox manager exists (sandbox disabled,
 * manager/shims unavailable). Every start attempt fails so a requested ON is acknowledged as
 * OFF with an error and the selected session is blocked from host fallback; stop is a no-op
 * because no container was ever started.
 */
export function createUnavailableSandboxLifecycleManager(runtime: SandboxRuntime): SessionSandboxLifecycleManager {
  return {
    runtime,
    async ensureRunning() {
      throw new Error(UNAVAILABLE_SANDBOX_ERROR)
    },
    async stop() {},
    getActive() {
      return null
    },
  }
}

export interface SessionSandboxControllerDeps {
  projectId: string
  directory: string
  preferences: SessionSandboxPreferencesRepo
  sandboxManager: SessionSandboxLifecycleManager
  getParentSessionId(sessionId: string): Promise<string | null>
  /**
   * Resolves the directory owning a session. Used to gate reconciliation so only the plugin
   * instance that owns the requested session acts on the shared preference rows (loop-worktree
   * child instances share the same project DB but different directories). Optional: when absent
   * every session is treated as owned.
   */
  getSessionDirectory?(sessionId: string): Promise<string | null>
  /**
   * Resolves whether a session belongs to an active loop. Used to refuse binding a host sandbox
   * to a loop session (loop-first resolution ignores the host binding). Optional: when absent
   * loop refusal is skipped.
   */
  resolveActiveLoopForSession?: ResolveActiveLoopForSession
  logger: Logger
  pollIntervalMs?: number
}

export interface ResolveSandboxSessionOpts {
  throwOnRestoreError?: boolean
}

export interface SessionSandboxController {
  start(): Promise<void>
  resolveSandboxForSession(sessionId: string, opts?: ResolveSandboxSessionOpts): Promise<SandboxContext | null>
  getState(): SessionSandboxAppliedState | null
  dispose(): Promise<void>
}

/**
 * Maximum number of ancestor hops to walk when matching a session to the acknowledged
 * root session, mirroring `session-loop-resolver` so deeply nested sub-agents resolve.
 */
const MAX_PARENT_DEPTH = 10

/** Cap on reconcile re-runs within a single tick when the desired revision keeps moving. */
const MAX_SUPERSEDE_ITERATIONS = 8

/**
 * Derives the logical manager key for a project. This is a stable, non-final key passed to
 * `SandboxManager.ensureRunning`/`stop`; `sbx.sandboxContainerName` remains the only place the
 * `forge-` prefix is added. Keyed by project id to match the granularity of the desired/applied
 * preference rows, which are stored per project: one project row therefore maps to exactly one
 * host container even when the project spans several checkout directories. Deterministic so a
 * clean restart resolves to the same underlying container.
 */
export function deriveManagerKey(projectId: string): string {
  const digest = createHash('sha256').update(projectId).digest('hex')
  return `host-session-${digest.slice(0, 12)}`
}

function freshRevision(): string {
  return randomUUID()
}

/**
 * Rejects when `run` has not settled within {@link OWNERSHIP_LOOKUP_TIMEOUT_MS}. The underlying
 * request is not cancellable, so this only stops waiting on it; the timer is always cleared so a
 * pending timeout cannot keep the process alive.
 */
async function withOwnershipLookupTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('session directory lookup timed out')), OWNERSHIP_LOOKUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Owns persisted reconciliation, in-memory acknowledged binding, host-container lifecycle,
 * and descendant matching for one project directory's session sandbox.
 */
export function createSessionSandboxController(deps: SessionSandboxControllerDeps): SessionSandboxController {
  const { projectId, directory, preferences, sandboxManager, logger } = deps
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const managerKey = deriveManagerKey(projectId)

  let acknowledgedSessionId: string | null = null
  /**
   * The applied revision at which `acknowledgedSessionId` was bound ON. Kept alongside the
   * in-memory root so a restore failure is attributed to this binding's own revision, never to the
   * current shared applied row (which may have since moved to another session's acknowledgement).
   */
  let acknowledgedRevision: string | null = null
  let hostActive = false
  let lastApplied: SessionSandboxAppliedState | null = null
  /**
   * The selected session whose host sandbox failed to start (or was refused). Kept distinct from
   * the acknowledged binding so resolution fails closed for that session and its descendants
   * instead of returning null (which integrated hooks would treat as permission for host execution).
   */
  let failedSelection: { sessionId: string; error: string } | null = null
  /**
   * The applied ON revision whose runtime validation (ensureRunning) has already been performed and
   * bound in memory. Lets an already-applied successful ON revision skip container work on idle
   * reconcile ticks, while a fresh instance (null) still validates the runtime on startup.
   */
  let lastValidatedRevision: string | null = null
  /**
   * True while restoring a persisted successful ON (the trusted-ON reconcile branch) before the
   * container lifecycle is confirmed (`hostActive`) or a rollback completes. After an unclean
   * restart a live container may already exist for this manager key, so a startup that aborts
   * (reconcile throws) while this is set must still tear the manager key down during disposal
   * even though `hostActive` was never established.
   */
  let restoringPersistedOn = false
  /**
   * True when a cleanup stop failed and the host container may still be live. Pending cleanup is
   * retried before any further start attempt, so a partially-initialized or orphaned container is
   * never adopted and acknowledged ON. Cleared only once removal is confirmed.
   */
  let pendingCleanup = false
  /**
   * The desired revision whose failed ON start is deferred by `pendingCleanup`. Lets the reconcile
   * settle that specific failure OFF-with-error once removal succeeds, while a superseding desired
   * revision is still processed normally.
   */
  let pendingCleanupRevision: string | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let reconciling = false
  let disposed = false
  let startPromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null

  /**
   * Single serialization point for every lifecycle mutation: reconciliation, disposal, and the
   * container-restore half of resolution. Guarantees these critical sections never interleave, so
   * an in-flight start/stop can never be overridden by a concurrent one.
   */
  let lifecycleTail: Promise<unknown> = Promise.resolve()
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycleTail.then(fn, fn)
    lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function bind(sessionId: string | null, revision: string | null = null): void {
    acknowledgedSessionId = sessionId
    hostActive = sessionId !== null
    acknowledgedRevision = sessionId !== null ? revision : null
  }

  function writeApplied(state: SessionSandboxAppliedState): void {
    preferences.setApplied(projectId, state)
    lastApplied = state
  }

  function restoreFromApplied(applied: SessionSandboxAppliedState, desired: SessionSandboxDesiredState): void {
    lastApplied = applied
    // Success is signalled by an exact `null` error, not a falsy one: an empty-string error (or
    // any non-null error) records a failed start and must remain fail-closed after a restart.
    if (applied.enabled && applied.error === null) {
      bind(applied.sessionId, applied.revision)
      failedSelection = null
      return
    }
    acknowledgedSessionId = null
    hostActive = false
    acknowledgedRevision = null
    // A desired-ON that never successfully applied (failed start or loop refusal) must keep the
    // selected session blocked from host fallback after a restart, where the persisted applied
    // row is the only record of the failure.
    const sid = applied.sessionId ?? desired.sessionId
    failedSelection = desired.enabled && applied.error !== null && sid
      ? { sessionId: sid, error: applied.error }
      : null
  }

  /**
   * Classifies ownership of `sessionId` for this instance: confirmed local, confirmed foreign, or
   * uncertain. Without a `getSessionDirectory` dep every session is local. A session whose
   * directory cannot be resolved (lookup returns null or throws) is `uncertain`, not foreign: in a
   * loop-worktree child instance the directory-scoped lookup returns null for a root session it
   * cannot see, so claiming local ownership would start the wrong sandbox and overwrite the shared
   * acknowledgement — but treating it as confirmed foreign would leave a matching ON row untouched
   * while resolution returns null (host fallback). Uncertain ownership therefore fails closed.
   */
  async function resolveOwnership(sessionId: string | null): Promise<'local' | 'foreign' | 'uncertain'> {
    if (sessionId == null || !deps.getSessionDirectory) return 'local'
    const lookup = deps.getSessionDirectory
    let dir: string | null
    try {
      // Bounded: this runs inside the startup reconcile that plugin initialization awaits, so a
      // lookup that never settles would hang the whole plugin rather than just this decision.
      dir = await withOwnershipLookupTimeout(() => lookup(sessionId))
    } catch {
      return 'uncertain'
    }
    if (!dir) return 'uncertain'
    return resolve(dir) === resolve(directory) ? 'local' : 'foreign'
  }

  /**
   * True when `sessionId` equals `root` or is an ancestor-chain descendant of it. Mirrors the
   * depth cap and cycle guard used by `session-loop-resolver`.
   */
  async function isWithinSession(root: string, sessionId: string): Promise<boolean> {
    if (!root || !sessionId) return false
    if (sessionId === root) return true
    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
      const parent = await deps.getParentSessionId(current)
      if (!parent || seen.has(parent)) break
      seen.add(parent)
      if (parent === root) return true
      current = parent
    }
    return false
  }

  /**
   * Best-effort removal of the host container. Returns true when removal is confirmed; false when
   * it failed and the container may still be live. On false the caller must retain `hostActive`
   * so the next reconcile tick retries the removal rather than orphaning a live container.
   */
  async function bestEffortStop(): Promise<boolean> {
    try {
      await sandboxManager.stop(managerKey)
      // A confirmed successful removal resolves any pending cleanup.
      pendingCleanup = false
      return true
    } catch (err) {
      logger.log(`[session-sandbox] best-effort stop failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * Fails closed when the given session is the acknowledged failed selection or a descendant.
   * Revalidates semantically (by the selected session, not object identity): reconciliation
   * recreates the identical failed-selection object each time it re-records the same failure, so
   * identity changes spuriously during slow parent lookups and would exhaust the retry cap,
   * letting a descendant fall through to host execution. If the selection moves to a different
   * session mid-lookup the match is recomputed; on retry exhaustion the call fails closed.
   */
  async function blockIfFailedSelection(sessionId: string): Promise<void> {
    for (let i = 0; i < MAX_SUPERSEDE_ITERATIONS; i++) {
      const selection = failedSelection
      if (!selection) return
      const matched = await isWithinSession(selection.sessionId, sessionId)
      const current = failedSelection
      if (!current) return
      if (current.sessionId === selection.sessionId) {
        if (matched) {
          throw new Error(`Host sandbox unavailable for the selected session: ${current.error}`)
        }
        return
      }
    }
    throw new Error(`Host sandbox unavailable for the selected session: ${failedSelection?.error ?? 'unknown'}`)
  }

  /**
   * Handles a failed ON start uniformly: clears the binding, records the failure, best-effort-
   * removes any partially-started (or previously running) container, and acknowledges applied
   * OFF-with-error, retaining retryable ownership when the removal fails. Shared by fresh starts
   * and persisted-ON restores so a partial creation is never leaked and a transient removal
   * failure is never acknowledged settled.
   */
  async function handleFailedOnStart(
    desired: SessionSandboxDesiredState | null,
    sessionId: string,
    msg: string,
  ): Promise<void> {
    bind(null)
    lastValidatedRevision = null
    failedSelection = { sessionId, error: msg }
    // A failed start may leave a partially-started (or previously running) container, even on a
    // first start: ensureRunning can create the container and then fail (e.g. env-file
    // generation). Always attempt deterministic-key cleanup; if it fails, retain retryable
    // ownership so the next reconcile tick retries the removal rather than acknowledging the
    // failure settled while a container is still live.
    const stopped = await bestEffortStop()
    if (!stopped) {
      pendingCleanup = true
      pendingCleanupRevision = desired?.revision ?? null
      hostActive = true
      return
    }
    hostActive = false
    restoringPersistedOn = false
    if (desired) {
      writeApplied({
        version: 1,
        revision: desired.revision,
        enabled: false,
        sessionId,
        error: msg,
        appliedAt: Date.now(),
      })
    }
  }

  /**
   * Tears down a binding whose container recovery failed after the desired selection had already
   * moved to a newer binding (e.g. ON(A) superseded by ON(B) while A's container dies). The failed
   * binding's container is removed but no acknowledgement is written: recording this failure at
   * A's (now old) revision would overwrite the newer applied acknowledgement. The caller re-runs
   * reconciliation so the current desired revision is applied.
   */
  async function handleSupersededRestoreFailure(): Promise<void> {
    bind(null)
    lastValidatedRevision = null
    failedSelection = null
    restoringPersistedOn = false
    const stopped = await bestEffortStop()
    if (!stopped) {
      // The failed binding's container could not be removed; it may still be live. Retain retryable
      // ownership so no superseding start adopts or acknowledges it until removal succeeds.
      pendingCleanup = true
      hostActive = true
      return
    }
    hostActive = false
  }

  /**
   * Acts on a single desired/applied pair. Returns the desired revision processed, or null
   * when there is no desired state (controller remains off). Actual SBX start/stop always
   * completes before the matching applied row is written.
   */
  async function reconcilePair(
    desired: SessionSandboxDesiredState | null,
    applied: SessionSandboxAppliedState | null,
  ): Promise<string | null> {
    if (!desired) {
      if (hostActive) {
        const stopped = await bestEffortStop()
        if (!stopped) {
          // Removal failed; the container may still be live. Retain hostActive so the next
          // reconcile tick retries the removal instead of orphaning a live container.
          acknowledgedSessionId = null
          failedSelection = null
          return null
        }
        hostActive = false
      }
      acknowledgedSessionId = null
      failedSelection = null
      return null
    }

    const appliedAtDesiredRevision = applied != null && applied.revision === desired.revision
    const trustedOn =
      appliedAtDesiredRevision &&
      desired.enabled &&
      applied.enabled &&
      applied.error === null &&
      desired.sessionId != null &&
      applied.sessionId != null &&
      desired.sessionId === applied.sessionId

    // Only the plugin instance owning the requested session may act on the shared preference rows
    // or the shared host container. A loop-worktree child instance (same project DB, different
    // directory) must never acknowledge, stop, or supersede the root instance's sandbox, and vice
    // versa. Ownership is resolved before `restoringPersistedOn` is set because that flag makes
    // disposal stop the manager key, which only the owner may do.
    const ownership = await resolveOwnership(desired.sessionId)
    if (ownership !== 'local') {
      // Only remove a container this instance actually started. The manager key is derived from
      // the project id, so every instance of this project resolves the same container: a
      // pre-existing container for that key belongs to whichever instance owns the session, and
      // stopping it here would tear down the owner's sandbox. The owner's own reconcile adopts or
      // removes it instead. A failed stop must not clear lifecycle tracking: the container may
      // still be live, so retain retryable ownership (hostActive true) and let the next reconcile
      // tick retry removal rather than orphaning a container the new owner will never see. The
      // foreign acknowledgement is never overwritten.
      if (hostActive) {
        try {
          await sandboxManager.stop(managerKey)
        } catch (err) {
          logger.log(
            `[session-sandbox] stop failed during ownership transfer: ${err instanceof Error ? err.message : String(err)}`,
          )
          // A failed stop means the container may still be live. Retain retryable ownership and
          // record pending cleanup so no superseding start can adopt or acknowledge it until
          // removal succeeds.
          hostActive = true
          pendingCleanup = true
          lastValidatedRevision = null
          acknowledgedSessionId = null
          acknowledgedRevision = null
          failedSelection = null
          return desired.revision
        }
        hostActive = false
        lastValidatedRevision = null
      }
      bind(null)
      // Uncertain ownership with an ON request must fail closed: this instance could not confirm it
      // owns the selected session (e.g. a transient directory-lookup failure), so blocking host
      // fallback is safer than running tools on the host while the shared ON row is left untouched.
      // Re-evaluated on the next reconcile tick once ownership can be confirmed.
      if (ownership === 'uncertain' && desired.enabled && desired.sessionId) {
        failedSelection = {
          sessionId: desired.sessionId,
          error: 'Host sandbox ownership could not be confirmed for the selected session',
        }
      } else {
        failedSelection = null
      }
      return desired.revision
    }

    // Ownership is confirmed local from here. A matching successful persisted ON (applied at the
    // desired revision) implies a container may already be running for the project's deterministic
    // manager key (e.g. an unclean restart). Track it as potentially owning this key BEFORE the
    // remaining fallible work: if this reconcile returns before the lifecycle is confirmed,
    // disposal must still tear the key down rather than leak a pre-existing container.
    if (trustedOn) {
      restoringPersistedOn = true
    }

    // A previous start/stop left a container that could not be removed. Retry removal before any
    // start attempt so a partially-initialized or orphaned container is never adopted and
    // acknowledged ON. Only once removal is confirmed do we fall through to act on the desired
    // state. Returning the current revision (desired unchanged) makes the next reconcile tick
    // retry the removal.
    if (pendingCleanup) {
      const stopped = await bestEffortStop()
      if (!stopped) return desired.revision
      pendingCleanup = false
      hostActive = false
      lastValidatedRevision = null
      // This pending cleanup is a deferred failed-ON-start acknowledgement (a start failed and the
      // follow-up removal also failed). Now that removal has succeeded, settle that specific
      // failure OFF-with-error rather than falling through to retry the ON start, which could adopt
      // the orphaned container and wrongly acknowledge it ON. Only when the desired intent has since
      // moved to a superseding revision do we fall through to act on the newest state.
      if (desired.enabled && pendingCleanupRevision !== null && desired.revision === pendingCleanupRevision && failedSelection) {
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: failedSelection.sessionId,
          error: failedSelection.error,
          appliedAt: Date.now(),
        })
        pendingCleanupRevision = null
        return desired.revision
      }
      pendingCleanupRevision = null
    }

    // Already applied at this exact revision. A matching revision only proves the applied row
    // corresponds to the same requested intent, not that it is safe to restore: an inconsistent
    // pair (desired OFF but applied ON, a null or mismatched session, or an error under an ON
    // intent) must never start or restore the wrong sandbox, so fall through to re-act the
    // desired state whenever the applied row is not trustworthy.
    if (applied && applied.revision === desired.revision) {
      const trustedOn =
        desired.enabled &&
        applied.enabled &&
        applied.error === null &&
        desired.sessionId != null &&
        applied.sessionId != null &&
        desired.sessionId === applied.sessionId

      if (trustedOn) {
        // `restoringPersistedOn` was already set before the ownership check, so a restore that
        // aborts before `hostActive` is confirmed still tears the manager key down on disposal.
        // Recheck that the selected session has not since entered an active loop. Loop-first
        // resolution ignores the host binding, so a session that started a loop while host SBX was
        // ON must have its host sandbox stopped and the acknowledgement flipped to OFF-with-error;
        // otherwise the container keeps running and the sidebar stays ON while the loop actually
        // runs unsandboxed. This runs on every trusted-ON tick (the cheap lookup, not container
        // work), so a loop membership change is always caught even though the desired revision is
        // unchanged.
        if (deps.resolveActiveLoopForSession) {
          const inLoop = await deps.resolveActiveLoopForSession(desired.sessionId!)
          if (inLoop?.active) {
            const stopped = await bestEffortStop()
            if (!stopped) {
              // Removal failed; the container may still be live. Retain ownership (hostActive stays
              // true) and block the selected session fail-closed so the next tick retries the
              // removal before the refusal is acknowledged settled.
              failedSelection = { sessionId: desired.sessionId!, error: LOOP_SESSION_REFUSED_ERROR }
              return desired.revision
            }
            bind(null)
            lastValidatedRevision = null
            restoringPersistedOn = false
            failedSelection = { sessionId: desired.sessionId!, error: LOOP_SESSION_REFUSED_ERROR }
            writeApplied({
              version: 1,
              revision: desired.revision,
              enabled: false,
              sessionId: desired.sessionId,
              error: LOOP_SESSION_REFUSED_ERROR,
              appliedAt: Date.now(),
            })
            return desired.revision
          }
        }
        // Restoring a persisted successful ON must confirm the current lifecycle manager can
        // actually provide the sandbox. After an unclean restart the manager may be unavailable
        // (initialization failed) even though the applied row still records a matching ON; trusting
        // that row blindly would expose a false ON sidebar while tool restoration fails. Validate
        // the runtime and, when unavailable, acknowledge OFF-with-error and block the session.
        // Validation runs only once per ON revision: an already-validated idle sandbox must not
        // call ensureRunning on every reconcile tick.
        if (lastValidatedRevision !== desired.revision) {
          try {
            await sandboxManager.ensureRunning(managerKey, directory)
            lastValidatedRevision = desired.revision
          } catch (err) {
            // A persisted-ON restore that partially creates the container and then fails must run
            // deterministic-key cleanup and retry a transient removal failure before the OFF
            // acknowledgement is settled, exactly like a fresh start.
            await handleFailedOnStart(desired, desired.sessionId!, err instanceof Error ? err.message : String(err))
            return desired.revision
          }
        }
        restoreFromApplied(applied, desired)
        restoringPersistedOn = false
        return desired.revision
      }

      // Desired ON already acknowledged OFF-with-error at this revision (failed start or loop
      // refusal): never hot-retry the failed start; restore the fail-closed failure state.
      if (desired.enabled && applied.enabled === false && applied.error !== null) {
        restoreFromApplied(applied, desired)
        return desired.revision
      }

      // Desired OFF acknowledged OFF-with-error: a prior stop failed and the container may
      // still be live. Retry removal until it succeeds; a matching OFF with no error is settled,
      // and an OFF-with-error under a desired ON is a failed start (handled above, never hot-retried).
      if (!desired.enabled && applied.enabled === false && applied.error !== null) {
        try {
          await sandboxManager.stop(managerKey)
        } catch (err) {
          // Preserve retryable ownership: the container may still be live, so keep hostActive true
          // and the next reconcile tick retries the removal. The applied OFF-with-error row is left
          // as-is (it already records the failure).
          acknowledgedSessionId = null
          hostActive = true
          failedSelection = desired.sessionId ? { sessionId: desired.sessionId, error: String(err) } : null
          return desired.revision
        }
        hostActive = false
        acknowledgedSessionId = null
        failedSelection = null
        lastValidatedRevision = null
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: desired.sessionId,
          error: null,
          appliedAt: Date.now(),
        })
        return desired.revision
      }

      // Desired OFF settled (applied OFF, no error): restore the settled state and return.
      if (!desired.enabled && applied.enabled === false && applied.error === null) {
        restoreFromApplied(applied, desired)
        return desired.revision
      }

      // Any other matching-revision pair is inconsistent (e.g. desired OFF but applied ON, or an
      // ON intent with a null/mismatched session): fall through to re-act the desired state so the
      // persisted acknowledgement is corrected and no wrong sandbox is started or restored.
    }

    if (desired.enabled) {
      // Reject an ON request that carries no session to bind: starting a container for a null
      // session would orphan it (bind(null) clears ownership, so it could never be used or
      // cleaned up). Acknowledge OFF-with-error instead of starting SBX.
      if (!desired.sessionId) {
        // No container is ever started for a null-session request; only stop a live container from
        // a prior binding (hostActive) to avoid leaking it when the selection becomes session-less.
        if (hostActive) {
          const stopped = await bestEffortStop()
          if (!stopped) {
            // Removal failed; the container may still be live. Retain hostActive so the next tick
            // retries the removal before the null-session state is acknowledged settled.
            acknowledgedSessionId = null
            failedSelection = null
            return desired.revision
          }
          hostActive = false
          lastValidatedRevision = null
        }
        bind(null)
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: null,
          error: MISSING_SESSION_ERROR,
          appliedAt: Date.now(),
        })
        return desired.revision
      }
      // Refuse to bind a host sandbox to an active loop session: loop-first resolution ignores
      // the host binding, so acknowledging ON here would report an SBX state that is never used.
      if (deps.resolveActiveLoopForSession) {
        const inLoop = await deps.resolveActiveLoopForSession(desired.sessionId)
        if (inLoop?.active) {
          acknowledgedSessionId = null
          lastValidatedRevision = null
          // Retain the refused session as a failed selection so it and its descendants remain
          // blocked fail-closed even after the loop terminates (before the next reconciliation
          // tick). Clearing it here would create a window where the loop-first resolver sees no
          // active loop and returns host fallback for a session the user requested be sandboxed.
          failedSelection = { sessionId: desired.sessionId, error: LOOP_SESSION_REFUSED_ERROR }
          // Stop the deterministic key even when hostActive is false: after an unclean restart a
          // stale container for this key can still be live (a prior session's ON survived the
          // crash), and a refused loop session must not leave it running.
          const stopped = await bestEffortStop()
          if (!stopped) {
            // Removal failed; the container may still be live. Retain retryable ownership so the
            // next tick retries before the refusal is acknowledged settled.
            hostActive = true
            return desired.revision
          }
          hostActive = false
          writeApplied({
            version: 1,
            revision: desired.revision,
            enabled: false,
            sessionId: desired.sessionId,
            error: LOOP_SESSION_REFUSED_ERROR,
            appliedAt: Date.now(),
          })
          return desired.revision
        }
      }
      try {
        await sandboxManager.ensureRunning(managerKey, directory)
      } catch (err) {
        await handleFailedOnStart(desired, desired.sessionId, err instanceof Error ? err.message : String(err))
        return desired.revision
      }
      // Persist the applied-ON acknowledgement BEFORE committing the in-memory binding. The
      // resolution matching phase runs off the lifecycle lock, so a binding set before the write
      // would let a concurrent resolution expose an acknowledged root whose ON row is not yet (and
      // may never be) persisted. If the write fails, roll back through handleFailedOnStart, which
      // clears the binding and stops the just-started container, so no unacknowledged sandbox is
      // used and none leaks.
      failedSelection = null
      try {
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: true,
          sessionId: desired.sessionId,
          error: null,
          appliedAt: Date.now(),
        })
      } catch (err) {
        await handleFailedOnStart(desired, desired.sessionId, err instanceof Error ? err.message : String(err))
        return desired.revision
      }
      bind(desired.sessionId, desired.revision)
      lastValidatedRevision = desired.revision
    } else {
      // A failed stop may leave the container live. Acknowledge OFF with the error so the next
      // startup never believes the container is stopped, and so the selected session stays
      // fail-closed while the removal is retried on the next reconcile tick. Preserve hostActive
      // so the retry actually happens (the matching-revision branch re-attempts the stop).
      try {
        await sandboxManager.stop(managerKey)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        acknowledgedSessionId = null
        hostActive = true
        lastValidatedRevision = null
        failedSelection = desired.sessionId ? { sessionId: desired.sessionId, error: msg } : null
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: desired.sessionId,
          error: msg,
          appliedAt: Date.now(),
        })
        return desired.revision
      }
      hostActive = false
      acknowledgedSessionId = null
      failedSelection = null
      lastValidatedRevision = null
      writeApplied({
        version: 1,
        revision: desired.revision,
        enabled: false,
        sessionId: desired.sessionId,
        error: null,
        appliedAt: Date.now(),
      })
    }
    return desired.revision
  }

  /**
   * Full reconciliation: acts on the current desired revision, then re-reads and keeps acting
   * if the desired moved on during an in-flight operation, so the newest revision always wins.
   * Writing the older applied revision in the interim is safe because this loop re-runs.
   */
  async function reconcile(): Promise<void> {
    for (let i = 0; i < MAX_SUPERSEDE_ITERATIONS; i++) {
      const desired = preferences.getDesired(projectId)
      const applied = preferences.getApplied(projectId)
      const actedRevision = await reconcilePair(desired, applied)
      if (actedRevision === null) return
      const latest = preferences.getDesired(projectId)
      if (!latest || latest.revision === actedRevision) return
    }
  }

  async function tick(): Promise<void> {
    if (disposed || reconciling) return
    reconciling = true
    try {
      await serialized(() => reconcile())
    } catch (err) {
      logger.error(`[session-sandbox] reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      reconciling = false
    }
  }

  async function resolveSandboxForSession(
    sessionId: string,
    opts?: ResolveSandboxSessionOpts,
  ): Promise<SandboxContext | null> {
    if (disposed) return null

    // Fail closed: a selected session (or its descendants) whose host sandbox failed to start
    // must never fall through to host execution. Throwing blocks the tool call rather than
    // returning null, which integrated hooks interpret as permission to run on the host.
    // `revalidateFailedSelection` re-checks before each null return because a concurrent
    // reconciliation can record a failure and clear the binding while this resolution is in
    // flight; without it a session whose sandbox start just failed would fall through to host.
    const revalidateFailedSelection = (): Promise<void> => blockIfFailedSelection(sessionId)

    await blockIfFailedSelection(sessionId)

    const root = acknowledgedSessionId
    // The applied revision at which `root` was acknowledged ON, kept on the controller's own
    // binding (not re-read from the shared applied row). An ON(A)->ON(B) rebind that lands during
    // a restore must not attribute A's failure to B's revision, which would overwrite B's
    // acknowledgement and orphan B's container.
    const rootAppliedRevision = acknowledgedRevision
    if (!root) {
      await revalidateFailedSelection()
      return null
    }

    // Read-only matching phase, kept off the lifecycle lock so it never stalls reconciliation.
    const matched = await isWithinSession(root, sessionId)
    if (!matched) {
      await revalidateFailedSelection()
      return null
    }
    if (disposed) return null

    // Container restore and return are serialized with reconciliation/disposal and revalidate that
    // the acknowledged root is still the root this session matched against, so an OFF, a disposal,
    // or an ON(A)->ON(B) transition that wins during the async work makes this return null without
    // exposing another root's sandbox.
    return serialized(async () => {
      if (disposed) return null
      if (acknowledgedSessionId !== root) {
        await revalidateFailedSelection()
        return null
      }
      try {
        await sandboxManager.ensureRunning(managerKey, directory)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.log(`[session-sandbox] ensureRunning failed during restore: ${msg}`)
        // A container-restore failure (e.g. env-file generation) can leave a partially-created or
        // orphaned container and a stale applied-ON row. Route through the same cleanup and
        // OFF-with-error transition as a failed start so the live container is removed, the stale
        // acknowledgement is corrected, and the selected session stays fail-closed. Attribute the
        // failure to the binding being recovered (root, at its own applied revision) so a
        // superseding desired revision is processed normally instead of being marked failed. But
        // only when the current desired revision still belongs to this binding: if the selection
        // has since moved on (ON(A) superseded by ON(B) while A's recovery fails), recording this
        // failure at A's old revision would overwrite B's newer applied acknowledgement.
        const desiredNow = preferences.getDesired(projectId)
        const stillCurrent = desiredNow != null && desiredNow.revision === rootAppliedRevision
        if (stillCurrent) {
          await handleFailedOnStart(
            {
              version: 1,
              revision: rootAppliedRevision ?? freshRevision(),
              enabled: true,
              sessionId: root,
              requestedAt: Date.now(),
            },
            root,
            msg,
          )
        } else {
          // The selection moved on while this binding's recovery failed. Tear this binding's
          // container down without overwriting the newer applied acknowledgement, then re-run
          // reconciliation so the current desired revision is applied. The failed binding's
          // session is no longer selected, so it is not recorded as a failed selection.
          await handleSupersededRestoreFailure()
          try {
            await reconcile()
          } catch (reconcileErr) {
            logger.log(
              `[session-sandbox] reconcile after superseded restore failure failed: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`,
            )
          }
        }
        if (opts?.throwOnRestoreError) throw err
        return null
      }
      if (disposed) return null
      if (acknowledgedSessionId !== root) {
        await revalidateFailedSelection()
        return null
      }
      const active = sandboxManager.getActive(managerKey)
      if (!active) return null
      return {
        runtime: sandboxManager.runtime,
        containerName: active.containerName,
        hostDir: active.projectDir,
        mounts: active.mounts ?? [{ hostDir: active.projectDir, containerDir: active.projectDir }],
        envFile: active.envFile,
      }
    })
  }

  return {
    async start(): Promise<void> {
      // Single-flight: concurrent or repeated calls share one start, so exactly one interval is
      // ever installed and every caller waits for the initial reconciliation to complete.
      if (startPromise) return startPromise
      startPromise = (async () => {
        // Startup reconciliation must not swallow errors: if persisted desired state cannot be
        // reconciled (e.g. a transient DB or session-lookup failure), the caller (plugin startup)
        // fails closed rather than returning with an ON indicator but no restored runtime binding,
        // which would leave selected tools executing host-side. Steady-state ticks below swallow
        // errors and retry on the next interval.
        if (!disposed) await serialized(() => reconcile())
        if (disposed) return
        if (intervalId === null) {
          intervalId = setInterval(() => {
            void tick()
          }, pollIntervalMs)
        }
      })()
      return startPromise
    },

    resolveSandboxForSession,

    getState(): SessionSandboxAppliedState | null {
      return lastApplied
    },

    async dispose(): Promise<void> {
      // Single-flight: concurrent shutdown paths all await the same cleanup, so the sandbox is
      // stopped and applied OFF is persisted before any caller resolves.
      if (disposePromise) return disposePromise
      // Mark disposed eagerly (before the serialized body) so any in-flight resolution or
      // reconciliation revalidates against it and returns null rather than restoring a container.
      disposed = true
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
      disposePromise = serialized(async () => {
        // Stop this controller's own container before any fallible bookkeeping, so a transient DB
        // or ownership-lookup failure can never skip container removal. The selection may have
        // rebounded to another instance's session before this instance reconciled; disposal must
        // still tear down the container it started rather than leaking it. `restoringPersistedOn`
        // covers a startup that aborted mid-restore of a persisted ON, where an unclean restart may
        // have left a live container even though `hostActive` was never set.
        if (hostActive || restoringPersistedOn) {
          try {
            await sandboxManager.stop(managerKey)
            hostActive = false
            restoringPersistedOn = false
            lastValidatedRevision = null
          } catch (err) {
            // A failed stop means the container may still be live. Record the failure so cleanup
            // never falsely acknowledges completion: applied OFF with a null error would tell the
            // next startup the sandbox is stopped when it is not. Only write when this instance
            // owns the current desired session so a non-owner cannot overwrite another instance's
            // shared acknowledgement; the actual owner observes the live container on its own poll.
            const msg = err instanceof Error ? err.message : String(err)
            let desired: SessionSandboxDesiredState | null = null
            let owned = false
            try {
              desired = preferences.getDesired(projectId)
              owned = desired != null && (await resolveOwnership(desired.sessionId)) === 'local'
            } catch {
              // A failed read must not mask the stop failure; we simply skip the failure write.
            }
            if (owned && desired) {
              writeApplied({
                version: 1,
                revision: desired.enabled ? freshRevision() : desired.revision,
                enabled: false,
                sessionId: desired.sessionId,
                error: msg,
                appliedAt: Date.now(),
              })
            }
            bind(null)
            failedSelection = null
            return
          }
        }
        // Write OFF at the current desired revision so a TUI request still awaiting its own
        // acknowledgement observes the OFF result (a fresh revision would be ignored as stale).
        // Desired is left ON, so the next startup re-applies it: a matching-revision desired ON with
        // a settled applied OFF is re-acted to start the container and acknowledge ON again. Skip
        // the write when this instance does not own the requested session so it cannot overwrite
        // another instance's acknowledgement for a shared project DB.
        let desired: SessionSandboxDesiredState | null = null
        let owned = false
        try {
          desired = preferences.getDesired(projectId)
          owned = desired != null && (await resolveOwnership(desired.sessionId)) === 'local'
        } catch {
          // A transient bookkeeping failure after the container is confirmed stopped must not
          // abort disposal; the container is already removed, so the applied row is left as-is.
        }
        if (owned && desired) {
          writeApplied({
            version: 1,
            revision: desired.revision,
            enabled: false,
            sessionId: desired.sessionId,
            error: null,
            appliedAt: Date.now(),
          })
        }
        bind(null)
        failedSelection = null
      }).then(() => undefined)
      return disposePromise
    },
  }
}

