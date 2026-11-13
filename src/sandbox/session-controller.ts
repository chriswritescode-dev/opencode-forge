import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'path'
import type { Logger } from '../types'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState, SessionSandboxPreferencesRepo } from '../storage'
import { sandboxContextFromActive, type SandboxContext } from './context'
import type { SandboxRuntime } from './msb'
import type { ActiveSandbox, ApplyOverridesOutcome } from './manager'
import { findSessionAncestor } from '../utils/session-ancestry'
import { isWithinDir } from '../workspace/forge-naming'

export const DEFAULT_POLL_INTERVAL_MS = 500

export const OWNERSHIP_LOOKUP_TIMEOUT_MS = 5_000

const LOOP_SESSION_REFUSED_ERROR = 'host sandbox cannot be enabled for an active loop session'

const UNAVAILABLE_SANDBOX_ERROR = 'host-session sandbox is unavailable (sandbox runtime not initialized)'

const MISSING_SESSION_ERROR = 'host sandbox cannot be enabled without a session'

export interface SessionSandboxLifecycleManager {
  runtime: SandboxRuntime
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
  applyOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
}

export type ResolveActiveLoopForSession = (sessionId: string) => Promise<{ active: boolean; sandbox?: boolean } | null>

export function createUnavailableSandboxLifecycleManager(runtime: SandboxRuntime): SessionSandboxLifecycleManager {
  return {
    runtime,
    async ensureRunning() {
      throw new Error(UNAVAILABLE_SANDBOX_ERROR)
    },
    async applyOverrides() {
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
  getSessionIdentity?(sessionId: string): Promise<{ projectId: string; directory: string } | null>
  getSessionDirectory?(sessionId: string): Promise<string | null>
  resolveActiveLoopForSession?: ResolveActiveLoopForSession
  onChange?: () => void
  logger: Logger
  pollIntervalMs?: number
}

export interface ResolveSandboxSessionOpts {
  throwOnRestoreError?: boolean
}

export interface SessionSandboxController {
  start(): Promise<void>
  resolveSandboxForSession(sessionId: string, opts?: ResolveSandboxSessionOpts): Promise<SandboxContext | null>
  isIdle(): boolean
  getState(): SessionSandboxAppliedState | null
  dispose(): Promise<void>
}

const MAX_SUPERSEDE_ITERATIONS = 8
const MAX_FAST_IDLE_POLLS = 4
const MAX_REMOVAL_RETRY_DELAY_MS = 30_000

export function deriveManagerKey(projectId: string): string {
  const digest = createHash('sha256').update(projectId).digest('hex')
  return `host-session-${digest.slice(0, 12)}`
}

function freshRevision(): string {
  return randomUUID()
}

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

export function createSessionSandboxController(deps: SessionSandboxControllerDeps): SessionSandboxController {
  const { projectId, directory, preferences, sandboxManager, logger } = deps
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const managerKey = deriveManagerKey(projectId)

  let acknowledgedSessionId: string | null = null
  let acknowledgedRevision: string | null = null
  let hostActive = false
  let lastApplied: SessionSandboxAppliedState | null = null
  let failedSelection: { sessionId: string; error: string } | null = null
  let lastValidatedRevision: string | null = null
  let restoringPersistedOn = false
  let pendingCleanup = false
  let pendingCleanupRevision: string | null = null
  let selectedProjectDirectory: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let idlePolls = 0
  let removalRetryDelayMs = 0
  let removalRetryRevision: string | null = null
  let reconciling = false
  let disposed = false
  let startPromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null

  let lifecycleTail: Promise<unknown> = Promise.resolve()
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycleTail.then(fn, fn)
    lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function notifyChanged(): void {
    try {
      deps.onChange?.()
    } catch (err) {
      logger.log(`[session-sandbox] change notification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function writeControllerState(phase: 'loading' | 'ready' | 'failed'): void {
    const desired = preferences.getDesired(projectId)
    preferences.setControllerState(projectId, {
      version: 1,
      phase,
      revision: desired?.revision ?? null,
      sessionId: desired?.sessionId ?? null,
    })
    notifyChanged()
  }

  function bind(sessionId: string | null, revision: string | null = null): void {
    acknowledgedSessionId = sessionId
    hostActive = sessionId !== null
    acknowledgedRevision = sessionId !== null ? revision : null
  }

  function writeApplied(state: SessionSandboxAppliedState): void {
    preferences.setApplied(projectId, state)
    lastApplied = state
    notifyChanged()
  }

  function restoreFromApplied(applied: SessionSandboxAppliedState, desired: SessionSandboxDesiredState): void {
    lastApplied = applied
    if (applied.enabled && applied.error === null) {
      bind(applied.sessionId, applied.revision)
      failedSelection = null
      return
    }
    acknowledgedSessionId = null
    hostActive = false
    acknowledgedRevision = null
    const sid = applied.sessionId ?? desired.sessionId
    failedSelection = desired.enabled && applied.error !== null && sid
      ? { sessionId: sid, error: applied.error }
      : null
  }

  async function resolveOwnership(sessionId: string | null): Promise<'local' | 'foreign' | 'uncertain'> {
    if (sessionId == null) return 'local'
    if (deps.getSessionIdentity) {
      try {
        const identity = await withOwnershipLookupTimeout(() => deps.getSessionIdentity!(sessionId))
        if (!identity) return 'uncertain'
        if (identity.projectId !== projectId) return 'foreign'
        selectedProjectDirectory = identity.directory
        return 'local'
      } catch {
        return 'uncertain'
      }
    }
    if (!deps.getSessionDirectory) return 'local'
    const lookup = deps.getSessionDirectory
    let dir: string | null
    try {
      dir = await withOwnershipLookupTimeout(() => lookup(sessionId))
    } catch {
      return 'uncertain'
    }
    if (!dir) return 'uncertain'
    const local = isWithinDir(resolve(directory), resolve(dir))
    if (local) selectedProjectDirectory = dir
    return local ? 'local' : 'foreign'
  }

  async function readLocallyOwnedDesired(): Promise<SessionSandboxDesiredState | null> {
    try {
      const desired = preferences.getDesired(projectId)
      return desired && (await resolveOwnership(desired.sessionId)) === 'local' ? desired : null
    } catch {
      return null
    }
  }

  async function isWithinSession(root: string, sessionId: string): Promise<boolean> {
    if (!root || !sessionId) return false
    if (sessionId === root) return true
    return (await findSessionAncestor(sessionId, deps.getParentSessionId, (parentId) => (
      parentId === root ? true : null
    ))) ?? false
  }

  async function bestEffortStop(): Promise<boolean> {
    try {
      await sandboxManager.stop(managerKey)
      pendingCleanup = false
      return true
    } catch (err) {
      logger.log(`[session-sandbox] best-effort stop failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

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

  async function handleFailedOnStart(
    desired: SessionSandboxDesiredState | null,
    sessionId: string,
    msg: string,
  ): Promise<void> {
    bind(null)
    lastValidatedRevision = null
    failedSelection = { sessionId, error: msg }
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

  async function handleSupersededRestoreFailure(): Promise<void> {
    bind(null)
    lastValidatedRevision = null
    failedSelection = null
    restoringPersistedOn = false
    const stopped = await bestEffortStop()
    if (!stopped) {
      pendingCleanup = true
      hostActive = true
      return
    }
    hostActive = false
  }

  async function reconcilePair(
    desired: SessionSandboxDesiredState | null,
    applied: SessionSandboxAppliedState | null,
  ): Promise<string | null> {
    if (!desired) {
      if (hostActive) {
        const stopped = await bestEffortStop()
        if (!stopped) {
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

    const ownership = await resolveOwnership(desired.sessionId)
    if (ownership !== 'local') {
      if (deps.getSessionIdentity) {
        const stopped = await bestEffortStop()
        hostActive = !stopped
        pendingCleanup = !stopped
        pendingCleanupRevision = !stopped ? desired.revision : null
        lastValidatedRevision = null
        acknowledgedSessionId = null
        acknowledgedRevision = null
        const ownershipError = ownership === 'foreign'
          ? 'Host sandbox session belongs to a different project'
          : 'Host sandbox session could not be resolved for this project'
        const error = desired.enabled || !stopped ? ownershipError : null
        failedSelection = desired.enabled && desired.sessionId
          ? { sessionId: desired.sessionId, error: ownershipError }
          : null
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: desired.sessionId,
          error,
          appliedAt: Date.now(),
        })
        return desired.revision
      }
      const uncertainFailedSelection =
        ownership === 'uncertain' && desired.enabled && desired.sessionId
          ? {
              sessionId: desired.sessionId,
              error: 'Host sandbox ownership could not be confirmed for the selected session',
            }
          : null
      if (hostActive) {
        try {
          await sandboxManager.stop(managerKey)
        } catch (err) {
          logger.log(
            `[session-sandbox] stop failed during ownership transfer: ${err instanceof Error ? err.message : String(err)}`,
          )
          hostActive = true
          pendingCleanup = true
          lastValidatedRevision = null
          acknowledgedSessionId = null
          acknowledgedRevision = null
          failedSelection = uncertainFailedSelection
          return desired.revision
        }
        hostActive = false
        lastValidatedRevision = null
      }
      bind(null)
      failedSelection = uncertainFailedSelection
      return desired.revision
    }

    if (
      desired.enabled &&
      desired.sessionId != null &&
      applied?.enabled &&
      applied.sessionId != null &&
      applied.sessionId !== desired.sessionId
    ) {
      const stopped = await bestEffortStop()
      hostActive = !stopped
      pendingCleanup = !stopped
      pendingCleanupRevision = !stopped ? desired.revision : null
      lastValidatedRevision = null
      acknowledgedSessionId = null
      acknowledgedRevision = null
      if (!stopped) {
        const error = 'Failed to remove the previous host sandbox before switching sessions'
        failedSelection = desired.sessionId ? { sessionId: desired.sessionId, error } : null
        writeApplied({
          version: 1,
          revision: desired.revision,
          enabled: false,
          sessionId: desired.sessionId,
          error,
          appliedAt: Date.now(),
        })
        return desired.revision
      }
    }

    if (trustedOn) {
      restoringPersistedOn = true
    }

    if (pendingCleanup) {
      const stopped = await bestEffortStop()
      if (!stopped) return desired.revision
      pendingCleanup = false
      hostActive = false
      lastValidatedRevision = null
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

    if (applied && applied.revision === desired.revision) {
      const trustedOn =
        desired.enabled &&
        applied.enabled &&
        applied.error === null &&
        desired.sessionId != null &&
        applied.sessionId != null &&
        desired.sessionId === applied.sessionId

      if (trustedOn) {
        if (deps.resolveActiveLoopForSession) {
          const inLoop = await deps.resolveActiveLoopForSession(desired.sessionId!)
          if (inLoop?.active) {
            const stopped = await bestEffortStop()
            if (!stopped) {
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
        if (lastValidatedRevision !== desired.revision) {
          try {
            await sandboxManager.ensureRunning(managerKey, selectedProjectDirectory ?? directory)
            await sandboxManager.applyOverrides(managerKey, selectedProjectDirectory ?? directory)
            lastValidatedRevision = desired.revision
          } catch (err) {
            await handleFailedOnStart(desired, desired.sessionId!, err instanceof Error ? err.message : String(err))
            return desired.revision
          }
        }
        restoreFromApplied(applied, desired)
        restoringPersistedOn = false
        return desired.revision
      }

      if (desired.enabled && applied.enabled === false && applied.error !== null) {
        restoreFromApplied(applied, desired)
        return desired.revision
      }

      if (!desired.enabled && applied.enabled === false && applied.error !== null) {
        try {
          await sandboxManager.stop(managerKey)
        } catch (err) {
          acknowledgedSessionId = null
          hostActive = true
          failedSelection = desired.sessionId ? { sessionId: desired.sessionId, error: String(err) } : null
          removalRetryRevision = desired.revision
          removalRetryDelayMs = removalRetryDelayMs === 0
            ? pollIntervalMs
            : Math.min(removalRetryDelayMs * 2, MAX_REMOVAL_RETRY_DELAY_MS)
          return desired.revision
        }
        removalRetryDelayMs = 0
        removalRetryRevision = null
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

      if (!desired.enabled && applied.enabled === false && applied.error === null) {
        restoreFromApplied(applied, desired)
        return desired.revision
      }

    }

    if (desired.enabled) {
      if (!desired.sessionId) {
        if (hostActive) {
          const stopped = await bestEffortStop()
          if (!stopped) {
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
      if (deps.resolveActiveLoopForSession) {
        const inLoop = await deps.resolveActiveLoopForSession(desired.sessionId)
        if (inLoop?.active) {
          acknowledgedSessionId = null
          lastValidatedRevision = null
          failedSelection = { sessionId: desired.sessionId, error: LOOP_SESSION_REFUSED_ERROR }
          const stopped = await bestEffortStop()
          if (!stopped) {
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
        await sandboxManager.ensureRunning(managerKey, selectedProjectDirectory ?? directory)
        await sandboxManager.applyOverrides(managerKey, selectedProjectDirectory ?? directory)
      } catch (err) {
        await handleFailedOnStart(desired, desired.sessionId, err instanceof Error ? err.message : String(err))
        return desired.revision
      }
      failedSelection = null
      try {
        const applied: SessionSandboxAppliedState = {
          version: 1,
          revision: desired.revision,
          enabled: true,
          sessionId: desired.sessionId,
          error: null,
          appliedAt: Date.now(),
        }
        if (desired.overrides) applied.overrides = desired.overrides
        writeApplied(applied)
      } catch (err) {
        await handleFailedOnStart(desired, desired.sessionId, err instanceof Error ? err.message : String(err))
        return desired.revision
      }
      bind(desired.sessionId, desired.revision)
      lastValidatedRevision = desired.revision
    } else {
      try {
        await sandboxManager.stop(managerKey)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        acknowledgedSessionId = null
        hostActive = true
        lastValidatedRevision = null
        failedSelection = desired.sessionId ? { sessionId: desired.sessionId, error: msg } : null
        removalRetryRevision = desired.revision
        removalRetryDelayMs = removalRetryDelayMs === 0
          ? pollIntervalMs
          : Math.min(removalRetryDelayMs * 2, MAX_REMOVAL_RETRY_DELAY_MS)
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
      removalRetryDelayMs = 0
      removalRetryRevision = null
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
      schedulePoll()
    }
  }

  function schedulePoll(): void {
    if (disposed || pollTimer !== null) return
    const desired = preferences.getDesired(projectId)
    if (removalRetryDelayMs > 0 && desired?.revision !== removalRetryRevision) {
      removalRetryDelayMs = 0
      removalRetryRevision = null
    }
    const active = hostActive || pendingCleanup || (desired?.enabled === true && failedSelection === null)
    if (active) idlePolls = 0
    const fast = active || idlePolls < MAX_FAST_IDLE_POLLS
    if (!active) idlePolls += 1
    const delay = removalRetryDelayMs > 0 ? removalRetryDelayMs : (fast ? pollIntervalMs : pollIntervalMs * 10)
    pollTimer = setTimeout(() => {
      pollTimer = null
      void tick()
    }, delay)
  }

  async function resolveSandboxForSession(
    sessionId: string,
    opts?: ResolveSandboxSessionOpts,
  ): Promise<SandboxContext | null> {
    if (disposed) return null

    const revalidateFailedSelection = (): Promise<void> => blockIfFailedSelection(sessionId)

    await blockIfFailedSelection(sessionId)

    const root = acknowledgedSessionId
    const rootAppliedRevision = acknowledgedRevision
    if (!root) {
      await revalidateFailedSelection()
      return null
    }

    const matched = await isWithinSession(root, sessionId)
    if (!matched) {
      await revalidateFailedSelection()
      return null
    }
    if (disposed) return null

    return serialized(async () => {
      if (disposed) return null
      if (acknowledgedSessionId !== root) {
        await revalidateFailedSelection()
        return null
      }
      try {
        await sandboxManager.ensureRunning(managerKey, selectedProjectDirectory ?? directory)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.log(`[session-sandbox] ensureRunning failed during restore: ${msg}`)
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
      return sandboxContextFromActive(sandboxManager.runtime, active)
    })
  }

  return {
    async start(): Promise<void> {
      if (startPromise) return startPromise
      const starting = (async () => {
        try {
          writeControllerState('loading')
          if (!disposed) await serialized(() => reconcile())
        } catch (err) {
          try {
            writeControllerState('failed')
          } catch (stateErr) {
            logger.log(`[session-sandbox] failed to persist controller failure state: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`)
          }
          throw err
        }
        if (disposed) return
        writeControllerState('ready')
        schedulePoll()
      })()
      startPromise = starting
      void starting.catch(() => {
        if (startPromise === starting) startPromise = null
      })
      return starting
    },

    resolveSandboxForSession,

    isIdle(): boolean {
      return acknowledgedSessionId === null && failedSelection === null
    },

    getState(): SessionSandboxAppliedState | null {
      return lastApplied
    },

    async dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposed = true
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      disposePromise = serialized(async () => {
        if (hostActive || restoringPersistedOn) {
          try {
            await sandboxManager.stop(managerKey)
            hostActive = false
            restoringPersistedOn = false
            lastValidatedRevision = null
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const desired = await readLocallyOwnedDesired()
            if (desired) {
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
        const desired = await readLocallyOwnedDesired()
        if (desired) {
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
