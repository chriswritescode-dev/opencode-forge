import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'fs'
import type { Logger } from '../types'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState, SessionSandboxPreferencesRepo } from '../storage'
import { isHostSandboxWanted } from '../storage/session-sandbox-state'
import { sandboxContextFromActive, type SandboxContext } from './context'
import type { SandboxRuntime } from './msb'
import type { ActiveSandbox, ApplyOverridesOutcome } from './manager'
import { findSessionAncestor } from '../utils/session-ancestry'
import { errorMessage } from '../utils/error-message'
import { canonicalizePath, isSameOrDescendantPath } from './path'

export const DEFAULT_POLL_INTERVAL_MS = 500

export const OWNERSHIP_LOOKUP_TIMEOUT_MS = 5_000

export const FOLDER_SANDBOX_IDLE_TIMEOUT = '30m'

const UNAVAILABLE_SANDBOX_ERROR = 'host-session sandbox is unavailable (sandbox runtime not initialized)'

export interface SessionSandboxLifecycleManager {
  runtime: SandboxRuntime
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
  applyOverrides(worktreeName: string, projectDir: string): Promise<ApplyOverridesOutcome>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
}

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
  hostSessionsDefault: boolean
  getParentSessionId(sessionId: string): Promise<string | null>
  getSessionIdentity(sessionId: string): Promise<{ projectId: string; directory: string } | null>
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
  dispose(): Promise<void>
}

const MAX_SUPERSEDE_ITERATIONS = 8
const MAX_FAST_IDLE_POLLS = 4
const MAX_REMOVAL_RETRY_DELAY_MS = 30_000

export function deriveManagerKey(projectId: string): string {
  const digest = createHash('sha256').update(projectId).digest('hex')
  return `host-session-${digest.slice(0, 12)}`
}

export function deriveFolderManagerKey(projectId: string, projectRoot: string, directory: string): string {
  const rootKey = deriveManagerKey(projectId)
  const folder = canonicalizePath(directory)
  if (isSameOrDescendantPath(folder, canonicalizePath(projectRoot))) return rootKey
  return `${rootKey}-${createHash('sha256').update(folder).digest('hex').slice(0, 12)}`
}

export function isFolderManagerKey(projectId: string, key: string): boolean {
  return key.startsWith(`${deriveManagerKey(projectId)}-`)
}

export function isHostSessionManagerKey(projectId: string, key: string): boolean {
  return key === deriveManagerKey(projectId) || isFolderManagerKey(projectId, key)
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
        timer = setTimeout(() => reject(new Error('session identity lookup timed out')), OWNERSHIP_LOOKUP_TIMEOUT_MS)
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
  const trackedSandboxes = new Map<string, string>()

  let cachedDesired: SessionSandboxDesiredState | null = null
  let lastValidatedRevision: string | null = null
  let recordedFailure: { revision: string; error: string } | null = null
  let hostActive = false
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
      logger.log(`[session-sandbox] change notification failed: ${errorMessage(err)}`)
    }
  }

  function readDesired(): SessionSandboxDesiredState | null {
    const desired = preferences.getDesired(projectId)
    cachedDesired = desired
    return desired
  }

  function writeControllerState(phase: 'loading' | 'ready' | 'failed'): void {
    preferences.setControllerState(projectId, {
      version: 1,
      phase,
      revision: cachedDesired?.revision ?? null,
    })
    notifyChanged()
  }

  function writeApplied(state: SessionSandboxAppliedState): void {
    preferences.setApplied(projectId, state)
    notifyChanged()
  }

  function appliedState(
    revision: string,
    running: boolean,
    error: string | null,
    overrides: SessionSandboxDesiredState['overrides'],
  ): SessionSandboxAppliedState {
    const state: SessionSandboxAppliedState = {
      version: 2,
      revision,
      running,
      error,
      appliedAt: Date.now(),
    }
    if (overrides) state.overrides = overrides
    return state
  }

  function recordFailure(revision: string, error: string): void {
    recordedFailure = { revision, error }
  }

  function clearFailure(): void {
    recordedFailure = null
  }

  function sandboxActive(): boolean {
    if (hostActive) return true
    const keys = new Set<string>([managerKey, ...trackedSandboxes.keys()])
    for (const key of keys) {
      if (sandboxManager.getActive(key) !== null) return true
    }
    return false
  }

  async function stopAllTracked(): Promise<{ stopped: boolean; error: string | null }> {
    const keys = new Set<string>([managerKey, ...trackedSandboxes.keys()])
    let error: string | null = null
    let stopped = true
    for (const key of keys) {
      try {
        await sandboxManager.stop(key)
        trackedSandboxes.delete(key)
      } catch (err) {
        const msg = errorMessage(err)
        logger.log(`[session-sandbox] stop failed for ${key}: ${msg}`)
        error ??= msg
        stopped = false
      }
    }
    if (stopped) hostActive = false
    return { stopped, error }
  }

  async function bestEffortStop(): Promise<boolean> {
    return (await stopAllTracked()).stopped
  }

  async function pruneMissingFolders(): Promise<void> {
    for (const [key, folder] of [...trackedSandboxes]) {
      if (key === managerKey || existsSync(folder)) continue
      try {
        await sandboxManager.stop(key)
      } catch (err) {
        logger.log(`[session-sandbox] stop failed for stale folder sandbox ${key}: ${errorMessage(err)}`)
      }
      trackedSandboxes.delete(key)
    }
  }

  async function removeStaleFolderSandboxes(): Promise<void> {
    try {
      const names = await sandboxManager.runtime.listSandboxesByPrefix(`forge-${managerKey}-`)
      let removed = 0
      for (const name of names) {
        try {
          await sandboxManager.runtime.removeSandbox(name)
          removed += 1
        } catch (err) {
          logger.log(`[session-sandbox] failed to remove leftover folder sandbox ${name}: ${errorMessage(err)}`)
        }
      }
      if (removed > 0) {
        logger.log(`[session-sandbox] removed ${removed} leftover folder sandbox(es)`)
      }
    } catch (err) {
      logger.log(`[session-sandbox] failed to list leftover folder sandboxes: ${errorMessage(err)}`)
    }
  }

  async function applyOverridesToTrackedFolders(): Promise<void> {
    for (const [key, folder] of [...trackedSandboxes]) {
      if (key === managerKey) continue
      try {
        await sandboxManager.applyOverrides(key, folder)
      } catch (err) {
        logger.log(`[session-sandbox] applyOverrides failed for folder sandbox ${key}: ${errorMessage(err)}`)
        try {
          await sandboxManager.stop(key)
        } catch (stopErr) {
          logger.log(`[session-sandbox] stop failed for folder sandbox ${key}: ${errorMessage(stopErr)}`)
        }
        trackedSandboxes.delete(key)
      }
    }
  }

  async function effectiveHostSandboxEnabled(
    desired: SessionSandboxDesiredState,
    sessionId: string,
  ): Promise<boolean> {
    const own = desired.sessions[sessionId]
    if (own !== undefined) return own
    const inherited = await findSessionAncestor(sessionId, deps.getParentSessionId, (ancestorId) => {
      const value = desired.sessions[ancestorId]
      return value === undefined ? null : value
    })
    return inherited ?? deps.hostSessionsDefault
  }

  async function reconcilePair(
    desired: SessionSandboxDesiredState | null,
    applied: SessionSandboxAppliedState | null,
  ): Promise<string | null> {
    if (!desired) {
      if (sandboxActive()) {
        const stopped = await bestEffortStop()
        if (!stopped) return null
      }
      return null
    }

    const want = isHostSandboxWanted(desired, deps.hostSessionsDefault)

    if (applied?.revision === desired.revision) {
      if (want && applied.running && applied.error === null && lastValidatedRevision === desired.revision) {
        clearFailure()
        return desired.revision
      }
      if (want && applied.error !== null && recordedFailure?.revision === desired.revision) {
        return desired.revision
      }
      if (!want && !applied.running && applied.error === null) {
        hostActive = false
        lastValidatedRevision = null
        clearFailure()
        return desired.revision
      }
    }

    if (want) {
      try {
        await sandboxManager.ensureRunning(managerKey, directory)
        await sandboxManager.applyOverrides(managerKey, directory)
      } catch (err) {
        const msg = errorMessage(err)
        lastValidatedRevision = null
        recordFailure(desired.revision, msg)
        const stopped = await bestEffortStop()
        if (!stopped) hostActive = true
        writeApplied(appliedState(desired.revision, false, msg, desired.overrides))
        return desired.revision
      }
      hostActive = true
      trackedSandboxes.set(managerKey, directory)
      await applyOverridesToTrackedFolders()
      lastValidatedRevision = desired.revision
      clearFailure()
      writeApplied(appliedState(desired.revision, true, null, desired.overrides))
      return desired.revision
    }

    const stopOutcome = await stopAllTracked()
    if (!stopOutcome.stopped) {
      const msg = stopOutcome.error ?? 'session sandbox stop failed'
      hostActive = true
      lastValidatedRevision = null
      recordFailure(desired.revision, msg)
      removalRetryRevision = desired.revision
      removalRetryDelayMs = removalRetryDelayMs === 0
        ? pollIntervalMs
        : Math.min(removalRetryDelayMs * 2, MAX_REMOVAL_RETRY_DELAY_MS)
      writeApplied(appliedState(desired.revision, true, msg, undefined))
      return desired.revision
    }
    hostActive = false
    lastValidatedRevision = null
    clearFailure()
    removalRetryDelayMs = 0
    removalRetryRevision = null
    writeApplied(appliedState(desired.revision, false, null, undefined))
    return desired.revision
  }

  async function reconcile(): Promise<void> {
    for (let i = 0; i < MAX_SUPERSEDE_ITERATIONS; i++) {
      const desired = readDesired()
      const applied = preferences.getApplied(projectId)
      const actedRevision = await reconcilePair(desired, applied)
      if (actedRevision === null) return
      const latest = readDesired()
      if (!latest || latest.revision === actedRevision) return
    }
  }

  async function tick(): Promise<void> {
    if (disposed || reconciling) return
    reconciling = true
    try {
      await serialized(async () => {
        await pruneMissingFolders()
        await reconcile()
      })
    } catch (err) {
      logger.error(`[session-sandbox] reconcile failed: ${errorMessage(err)}`)
    } finally {
      reconciling = false
      schedulePoll()
    }
  }

  function schedulePoll(): void {
    if (disposed || pollTimer !== null) return
    const desired = readDesired()
    if (removalRetryDelayMs > 0 && desired?.revision !== removalRetryRevision) {
      removalRetryDelayMs = 0
      removalRetryRevision = null
    }
    const wanted = isHostSandboxWanted(desired, deps.hostSessionsDefault)
    const active = sandboxActive() || (wanted && recordedFailure === null)
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

    const desired = readDesired()
    const enabled = desired
      ? await effectiveHostSandboxEnabled(desired, sessionId)
      : deps.hostSessionsDefault
    if (!enabled) return null
    if (disposed) return null

    let identity: { projectId: string; directory: string } | null
    try {
      identity = await withOwnershipLookupTimeout(() => deps.getSessionIdentity(sessionId))
    } catch {
      identity = null
    }
    if (!identity) {
      throw new Error(
        `Host sandbox session ${sessionId} could not be resolved for host-sandbox routing; refusing to run the command on the host.`,
      )
    }
    if (identity.projectId !== projectId) return null
    if (disposed) return null

    const failure = recordedFailure
    if (failure && desired && failure.revision === desired.revision) {
      throw new Error(
        `Host sandbox unavailable: ${failure.error}. Toggle the sandbox off and on to retry, or set sandbox.hostSessions to false.`,
      )
    }

    const key = deriveFolderManagerKey(projectId, directory, identity.directory)
    const targetDir = key === managerKey ? directory : identity.directory

    return serialized(async () => {
      if (disposed) return null
      try {
        await sandboxManager.ensureRunning(key, targetDir)
      } catch (err) {
        const msg = errorMessage(err)
        logger.log(`[session-sandbox] ensureRunning failed during restore: ${msg}`)
        if (key === managerKey) {
          const current = readDesired()
          lastValidatedRevision = null
          recordFailure(current?.revision ?? desired?.revision ?? '', msg)
          const stopped = await bestEffortStop()
          if (!stopped) hostActive = true
          if (current) {
            writeApplied(appliedState(current.revision, false, msg, current.overrides))
          }
        } else {
          try {
            await sandboxManager.stop(key)
          } catch (stopErr) {
            logger.log(`[session-sandbox] stop failed for folder sandbox ${key}: ${errorMessage(stopErr)}`)
          }
          trackedSandboxes.delete(key)
          throw err
        }
        if (opts?.throwOnRestoreError) throw err
        return null
      }
      trackedSandboxes.set(key, targetDir)
      if (disposed) return null
      const active = sandboxManager.getActive(key)
      if (!active) return null
      return sandboxContextFromActive(sandboxManager.runtime, active)
    })
  }

  return {
    async start(): Promise<void> {
      if (startPromise) return startPromise
      const starting = (async () => {
        try {
          readDesired()
          writeControllerState('loading')
          if (!disposed) {
            const seeded = preferences.updateDesired(projectId, (current) => current ?? {
              version: 2,
              revision: freshRevision(),
              sessions: {},
              requestedAt: Date.now(),
            })
            cachedDesired = seeded
            await serialized(async () => {
              await removeStaleFolderSandboxes()
              await reconcile()
            })
          }
        } catch (err) {
          try {
            writeControllerState('failed')
          } catch (stateErr) {
            logger.log(`[session-sandbox] failed to persist controller failure state: ${errorMessage(stateErr)}`)
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
      return !isHostSandboxWanted(cachedDesired, deps.hostSessionsDefault) && !sandboxActive() && recordedFailure === null
    },

    async dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposed = true
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      disposePromise = serialized(async () => {
        let desired: SessionSandboxDesiredState | null = null
        try {
          desired = readDesired()
        } catch (err) {
          logger.log(`[session-sandbox] failed to read desired state during dispose: ${errorMessage(err)}`)
        }
        let stopped = true
        if (sandboxActive()) {
          const outcome = await stopAllTracked()
          stopped = outcome.stopped
          if (!stopped) {
            logger.log(`[session-sandbox] stop failed during dispose: ${outcome.error ?? 'unknown error'}`)
          }
        }
        if (desired) {
          writeApplied(appliedState(desired.revision, !stopped, null, undefined))
        }
        hostActive = false
        lastValidatedRevision = null
        clearFailure()
      }).then(() => undefined)
      return disposePromise
    },
  }
}
