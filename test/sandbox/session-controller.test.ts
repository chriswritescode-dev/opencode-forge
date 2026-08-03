import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createSessionSandboxController,
  createUnavailableSandboxLifecycleManager,
  deriveManagerKey,
  DEFAULT_POLL_INTERVAL_MS,
  OWNERSHIP_LOOKUP_TIMEOUT_MS,
  type SessionSandboxLifecycleManager,
} from '../../src/sandbox/session-controller'
import { createSessionSandboxPreferencesRepo } from '../../src/storage'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState, SessionSandboxPreferencesRepo } from '../../src/storage'
import type { ActiveSandbox } from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT = 'project-a'
const DIRECTORY = '/abs/path/to/worktree'
const ROOT_SESSION = 'session-root'
const MANAGER_KEY = deriveManagerKey(PROJECT)

function makeDesired(overrides: Partial<SessionSandboxDesiredState> = {}): SessionSandboxDesiredState {
  return { version: 1, revision: 'rev-1', enabled: true, sessionId: ROOT_SESSION, requestedAt: 1000, ...overrides }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakeManager extends SessionSandboxLifecycleManager {
  ensureRunningCalls: string[]
  stopCalls: string[]
  active: ActiveSandbox | null
  setEnsureRunningImpl(fn: (key: string, dir: string) => Promise<string>): void
  setActive(active: ActiveSandbox | null): void
}

function createFakeManager(): FakeManager {
  const runtime = createMockSandboxRuntime()
  const manager: FakeManager = {
    runtime,
    ensureRunningCalls: [],
    stopCalls: [],
    active: null,
    ensureRunning: async () => '',
    stop: async (key: string) => {
      manager.stopCalls.push(key)
      manager.active = null
    },
    getActive: () => manager.active,
    setEnsureRunningImpl(fn) {
      manager.ensureRunning = async (key: string, dir: string) => {
        manager.ensureRunningCalls.push(key)
        const name = await fn(key, dir)
        manager.active = { containerName: name, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
        return name
      }
    },
    setActive(active) {
      manager.active = active
    },
  }
  manager.setEnsureRunningImpl(async (key: string) => `forge-${key}`)
  return manager
}

describe('SessionSandboxController', () => {
  let db: Database
  let repo: ReturnType<typeof createSessionSandboxPreferencesRepo>
  let tempDir: string
  let manager: FakeManager
  let logger: ReturnType<typeof createMockLogger>

  function createController(overrides: {
    pollIntervalMs?: number
    directory?: string
    preferences?: SessionSandboxPreferencesRepo
    getSessionDirectory?: (sid: string) => Promise<string | null>
    resolveActiveLoopForSession?: (sid: string) => Promise<{ active: boolean; sandbox?: boolean } | null>
    getParentSessionId?: (sid: string) => Promise<string | null>
  } = {}) {
    return createSessionSandboxController({
      projectId: PROJECT,
      directory: overrides.directory ?? DIRECTORY,
      preferences: overrides.preferences ?? repo,
      sandboxManager: manager,
      getParentSessionId: overrides.getParentSessionId ?? (async () => null),
      ...(overrides.getSessionDirectory ? { getSessionDirectory: overrides.getSessionDirectory } : {}),
      ...(overrides.resolveActiveLoopForSession ? { resolveActiveLoopForSession: overrides.resolveActiveLoopForSession } : {}),
      logger,
      ...(overrides.pollIntervalMs ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
    })
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-sandbox-controller-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    repo = createSessionSandboxPreferencesRepo(db)
    manager = createFakeManager()
    logger = createMockLogger()
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  test('start with no desired state stays off and writes nothing', async () => {
    const controller = createController()
    await controller.start()
    expect(manager.ensureRunningCalls).toEqual([])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toBeNull()
    expect(controller.getState()).toBeNull()
    await controller.dispose()
  })

  test('persisted desired ON starts the host and writes applied ON', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-on' }))
    const controller = createController()
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.ensureRunningCalls[0]).not.toMatch(/^forge-/)
    expect(manager.ensureRunningCalls[0]).toMatch(/^host-session-/)
    expect(manager.stopCalls).toEqual([])

    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-on')
    expect(applied?.enabled).toBe(true)
    expect(applied?.sessionId).toBe(ROOT_SESSION)
    expect(applied?.error).toBeNull()
    expect(controller.getState()).toEqual(applied)
    await controller.dispose()
  })

  test('desired OFF stops the host and writes applied OFF without error', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-off', enabled: false }))
    const controller = createController()
    await controller.start()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    expect(manager.ensureRunningCalls).toEqual([])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-off')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    await controller.dispose()
  })

  test('failed start is acknowledged as OFF with an error and exposes no host fallback', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-fail' }))
    manager.setEnsureRunningImpl(async () => {
      throw new Error('sbx daemon is not running')
    })
    const controller = createController()
    await controller.start()

    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-fail')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/sbx daemon is not running/)

    // A failed start must never expose a host fallback for the selected session: resolution
    // fails closed (throws) rather than returning null (which hooks treat as host permission).
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/sbx daemon is not running/)
    await controller.dispose()
  })

  test('an applied-ON write failure rolls back the binding and stops the started container', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-write-fail' }))
    // The container starts successfully, but persisting the applied-ON acknowledgement fails (e.g.
    // SQLite is locked). The controller must roll back the in-memory binding and stop the started
    // container so no unacknowledged sandbox is used or leaked, and it must fail closed.
    const wrappedRepo: SessionSandboxPreferencesRepo = {
      getDesired: (p) => repo.getDesired(p),
      setDesired: (p, s) => repo.setDesired(p, s),
      getApplied: (p) => repo.getApplied(p),
      setApplied: (p, s) => {
        if (s.enabled) throw new Error('SQLITE_BUSY: database is locked')
        repo.setApplied(p, s)
      },
      getControllerState: (p) => repo.getControllerState(p),
      setControllerState: (p, s) => repo.setControllerState(p, s),
      getPair: (p) => repo.getPair(p),
    }
    const controller = createController({ preferences: wrappedRepo })
    await controller.start()

    // The container was started but then stopped; nothing remains live.
    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.stopCalls).toEqual([MANAGER_KEY])

    // No sandbox resolves after the failed write: the selected session fails closed rather than
    // falling through to host execution or exposing an unacknowledged container.
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/SQLITE_BUSY/)
    await controller.dispose()
  })

  test('startup restoration reapplies a persisted desired ON across a fresh instance', async () => {
    // First server run: apply desired ON, then shut down (dispose writes applied OFF).
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-persist' }))
    const first = createController()
    await first.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
    await first.dispose()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(false)
    // dispose acknowledges OFF at the desired revision so a pending TUI request observes it; desired
    // stays ON so the next startup re-applies it.
    expect(repo.getApplied(PROJECT)?.revision).toBe('r-persist')

    // New server instance reading the same persisted rows re-applies desired ON.
    const second = createController()
    await second.start()
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-persist')
    expect(applied?.enabled).toBe(true)
    expect(manager.ensureRunningCalls).toContain(MANAGER_KEY)
    await second.dispose()
  })

  test('an already-applied successful ON revision is restored after validating the runtime', async () => {
    // Persisted applied ON already matches desired (e.g. prior run that was not disposed).
    const applied: SessionSandboxAppliedState = {
      version: 1,
      revision: 'r-match',
      enabled: true,
      sessionId: ROOT_SESSION,
      error: null,
      appliedAt: Date.now(),
    }
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-match' }))
    repo.setApplied(PROJECT, applied)
    const controller = createController()
    await controller.start()

    // The matching-revision restore validates the runtime before trusting the persisted ON; with a
    // healthy manager this is a cheap ensureRunning (not a full restart).
    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.stopCalls).toEqual([])
    expect(controller.getState()).toEqual(applied)

    // Binding is restored, so the acknowledged root resolves to a context.
    const ctx = await controller.resolveSandboxForSession(ROOT_SESSION)
    expect(ctx).not.toBeNull()
    expect(ctx?.containerName).toBe(`forge-${MANAGER_KEY}`)
    await controller.dispose()
  })

  test('matching persisted ON is not trusted when the lifecycle manager is unavailable', async () => {
    // A prior run left applied ON at the same revision as desired, but after an unclean restart
    // the lifecycle manager is unavailable (initialization failed). The persisted ON must not be
    // restored: startup acknowledges OFF-with-error and the selected session fails closed.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-unavail' }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-unavail',
      enabled: true,
      sessionId: ROOT_SESSION,
      error: null,
      appliedAt: Date.now(),
    })
    const unavailable = createUnavailableSandboxLifecycleManager(createMockSandboxRuntime())
    const controller = createSessionSandboxController({
      projectId: PROJECT,
      directory: DIRECTORY,
      preferences: repo,
      sandboxManager: unavailable,
      getParentSessionId: async () => null,
      logger,
    })
    await controller.start()

    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-unavail')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeTruthy()
    // Startup never exposes applied ON for an unavailable runtime.
    expect(controller.getState()?.enabled).toBe(false)
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow()
    await controller.dispose()
  })

  test('persisted-ON restore that partially creates the container cleans up before acknowledging OFF', async () => {
    // A prior run left applied ON at the same revision as desired. On restart the restore
    // validation must run deterministic-key cleanup if ensureRunning creates the container and
    // then fails (e.g. env-file generation), so the partially-created container is not leaked
    // while OFF-with-error is acknowledged.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-restore-partial' }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-restore-partial',
      enabled: true,
      sessionId: ROOT_SESSION,
      error: null,
      appliedAt: Date.now(),
    })
    manager.setEnsureRunningImpl(async (key, dir) => {
      manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
      throw new Error('env file generation failed during restore')
    })
    const controller = createController()
    await controller.start()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-restore-partial')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/env file generation failed during restore/)
    // No live container remains to expose.
    expect(manager.active).toBeNull()
    await controller.dispose()
  })

  test('persisted-ON restore cleanup is retried when the removal fails transiently', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-restore-retry' }))
      repo.setApplied(PROJECT, {
        version: 1,
        revision: 'r-restore-retry',
        enabled: true,
        sessionId: ROOT_SESSION,
        error: null,
        appliedAt: Date.now(),
      })
      manager.setEnsureRunningImpl(async (key, dir) => {
        manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
        throw new Error('start failed after creation during restore')
      })
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()

      // First cleanup attempt fails; ownership is retained and no settled OFF-with-error is written
      // (the persisted ON row is left untouched until the removal succeeds).
      expect(manager.stopCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      // The pending cleanup resolves (stop 2) and the failure is settled OFF-with-error; the
      // still-ON desired is never re-attempted, so the failed start is not retried.
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/start failed after creation during restore/)
      expect(manager.active).toBeNull()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an inconsistent desired-OFF / applied-ON pair at the same revision is never restored', async () => {
    // Desired says OFF but a (schema-valid) applied row still records ON at the same revision.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-inconsistent', enabled: false, sessionId: ROOT_SESSION }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-inconsistent',
      enabled: true,
      sessionId: ROOT_SESSION,
      error: null,
      appliedAt: Date.now(),
    })
    const controller = createController()
    await controller.start()

    // The inconsistent ON is not restored or started; the desired OFF is re-acted (stopped).
    expect(manager.ensureRunningCalls).toEqual([])
    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    expect(controller.getState()?.enabled).toBe(false)
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.toBeNull()
    await controller.dispose()
  })

  test('an inconsistent applied-ON with a null session is never restored as a bound sandbox', async () => {
    // Desired is a valid ON for ROOT_SESSION but the applied row records a null session.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-null-applied', sessionId: ROOT_SESSION }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-null-applied',
      enabled: true,
      sessionId: null,
      error: null,
      appliedAt: Date.now(),
    })
    const controller = createController()
    await controller.start()

    // The mismatched row is never trusted; desired is re-acted and bound to the real session.
    expect(repo.getApplied(PROJECT)?.sessionId).toBe(ROOT_SESSION)
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
    await controller.dispose()
  })

  test('an inconsistent applied-ON for a different session is corrected, not restored as the wrong sandbox', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-mismatch', sessionId: ROOT_SESSION }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-mismatch',
      enabled: true,
      sessionId: 'session-other',
      error: null,
      appliedAt: Date.now(),
    })
    const controller = createController()
    await controller.start()

    // The wrong-session applied row is never trusted; desired is re-acted for ROOT_SESSION.
    expect(repo.getApplied(PROJECT)?.sessionId).toBe(ROOT_SESSION)
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
    await controller.dispose()
  })

  test('superseding revisions: newest desired wins while an older operation is in flight', async () => {
    const gate = deferred<string>()
    manager.setEnsureRunningImpl(() => gate.promise)

    repo.setDesired(PROJECT, makeDesired({ revision: 'r1', enabled: true }))
    const controller = createController()
    const starting = controller.start()

    // Desired moves to OFF while the r1 start is still in flight.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r2', enabled: false }))
    gate.resolve(`forge-${MANAGER_KEY}`)
    await starting

    // The newest revision wins: applied records r2 OFF.
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r2')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    expect(manager.stopCalls).toContain(MANAGER_KEY)
    await controller.dispose()
  })

  test('resolveSandboxForSession matches the acknowledged root or a descendant', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-desc', sessionId: ROOT_SESSION }))
    const parents: Record<string, string | null> = {
      'session-sub': ROOT_SESSION,
      'session-deep': 'session-sub',
    }
    const controller = createSessionSandboxController({
      projectId: PROJECT,
      directory: DIRECTORY,
      preferences: repo,
      sandboxManager: manager,
      getParentSessionId: async (sid: string) => parents[sid] ?? null,
      logger,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    })
    await controller.start()

    // Root session resolves.
    const rootCtx = await controller.resolveSandboxForSession(ROOT_SESSION)
    expect(rootCtx).not.toBeNull()
    expect(rootCtx?.containerName).toBe(`forge-${MANAGER_KEY}`)

    // Direct descendant and a multi-hop descendant resolve.
    expect(await controller.resolveSandboxForSession('session-sub')).not.toBeNull()
    expect(await controller.resolveSandboxForSession('session-deep')).not.toBeNull()

    // An unrelated session (no ancestor chain to the root) does not resolve.
    await expect(controller.resolveSandboxForSession('session-unrelated')).resolves.toBeNull()
    await controller.dispose()
  })

  test('resolveSandboxForSession returns null when the sandbox is off', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-off', enabled: false }))
    const controller = createController()
    await controller.start()
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.toBeNull()
    await controller.dispose()
  })

  test('throwOnRestoreError surfaces an ensureRunning failure for a bound session', async () => {
    // Bring the sandbox up and bind the acknowledged root with a working manager.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-restore-fail' }))
    const controller = createController()
    await controller.start()
    expect(await controller.resolveSandboxForSession(ROOT_SESSION)).not.toBeNull()

    // The acknowledged container dies; recovery now fails.
    manager.setEnsureRunningImpl(async () => {
      throw new Error('cannot recover container')
    })
    await expect(
      controller.resolveSandboxForSession(ROOT_SESSION, { throwOnRestoreError: true }),
    ).rejects.toThrow('cannot recover container')
    await controller.dispose()
  })

  test('polling is non-overlapping', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<string>()
      manager.setEnsureRunningImpl(() => gate.promise)

      // Start with no desired so the initial reconcile resolves quickly and the
      // interval is installed.
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()

      repo.setDesired(PROJECT, makeDesired({ revision: 'r-nonoverlap' }))

      // First interval tick starts a slow reconcile.
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.ensureRunningCalls).toHaveLength(1)

      // Subsequent ticks while the first is in flight must not start a second reconcile.
      await vi.advanceTimersByTimeAsync(200)
      expect(manager.ensureRunningCalls).toHaveLength(1)

      gate.resolve(`forge-${MANAGER_KEY}`)
      await vi.advanceTimersByTimeAsync(1)

      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
      expect(manager.ensureRunningCalls).toHaveLength(1)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispose is idempotent, stops the container, and acknowledges OFF', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-idem' }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    await controller.dispose()
    await controller.dispose()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    expect(applied?.revision).toBe('r-idem')
    expect(controller.getState()).toEqual(applied)
  })

  test('dispose acknowledges OFF at the desired revision so a pending TUI request observes it', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-pending-on' }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    await controller.dispose()

    // The applied OFF is written at the desired revision, so a TUI still waiting on that exact
    // revision observes the OFF acknowledgement instead of timing out on an unrelated revision.
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    expect(applied?.revision).toBe('r-pending-on')

    // Desired is left ON; a fresh instance re-applies it on startup.
    const second = createController()
    await second.start()
    const reapplied = repo.getApplied(PROJECT)
    expect(reapplied?.enabled).toBe(true)
    expect(reapplied?.revision).toBe('r-pending-on')
    await second.dispose()
  })

  test('dispose does not record successful applied OFF when stopping fails', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-dispose-fail' }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    // Container removal fails during cleanup; the sandbox may still be live.
    manager.stop = async () => {
      throw new Error('container removal failed')
    }
    await controller.dispose()

    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/container removal failed/)
    // A successful OFF (error: null) must never be recorded after a failed stop, so the next
    // startup cannot falsely believe the container is stopped.
    expect(applied?.error).not.toBeNull()
  })

  test('polling is fully stopped during disposal', async () => {
    vi.useFakeTimers()
    try {
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()

      await controller.dispose()

      // A new desired ON must not be acted on after disposal: interval is cleared.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-after-dispose' }))
      await vi.advanceTimersByTimeAsync(500)
      expect(manager.ensureRunningCalls).toEqual([])
      expect(repo.getApplied(PROJECT)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispose waits for in-flight reconciliation and cannot be overridden by a late ensureRunning', async () => {
    const gate = deferred<string>()
    manager.setEnsureRunningImpl(() => gate.promise)
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-race-dispose', enabled: true }))
    const controller = createController()

    const starting = controller.start()
    const disposing = controller.dispose()
    gate.resolve(`forge-${MANAGER_KEY}`)
    await starting
    await disposing

    // After dispose returns the pending start cannot leave the sandbox ON.
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    expect(manager.stopCalls).toContain(MANAGER_KEY)
    expect(controller.getState()?.enabled).toBe(false)
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.toBeNull()
  })

  test('resolve returns null when disposal clears the binding during a deferred parent lookup', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-race-parent', sessionId: ROOT_SESSION }))
    const parentGate = deferred<string | null>()
    const controller = createSessionSandboxController({
      projectId: PROJECT,
      directory: DIRECTORY,
      preferences: repo,
      sandboxManager: manager,
      getParentSessionId: async () => parentGate.promise,
      logger,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    })
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    const resolving = controller.resolveSandboxForSession('session-sub')
    await controller.dispose()
    parentGate.resolve(ROOT_SESSION)
    await expect(resolving).resolves.toBeNull()

    // Disposal won; no extra container restore and the sandbox stays off.
    expect(repo.getApplied(PROJECT)?.enabled).toBe(false)
    expect(manager.ensureRunningCalls).toHaveLength(1)
  })

  test('resolve does not leave a live sandbox when disposal wins during a deferred restore', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-race-restore', sessionId: ROOT_SESSION }))
    const gate = deferred<string>()
    let calls = 0
    manager.setEnsureRunningImpl(async () => {
      calls++
      if (calls === 1) return `forge-${MANAGER_KEY}`
      return gate.promise
    })
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    const resolving = controller.resolveSandboxForSession(ROOT_SESSION)
    await controller.dispose()
    gate.resolve(`forge-${MANAGER_KEY}`)
    await expect(resolving).resolves.toBeNull()

    // The deferred restore returned null and disposal finalized OFF with no live sandbox.
    expect(repo.getApplied(PROJECT)?.enabled).toBe(false)
    expect(manager.stopCalls).toContain(MANAGER_KEY)
  })

  test('ON(A)->ON(B) transition never exposes B sandbox to an A descendant during a deferred parent lookup', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-A' }))
      const parentGate = deferred<string | null>()
      const controller = createSessionSandboxController({
        projectId: PROJECT,
        directory: DIRECTORY,
        preferences: repo,
        sandboxManager: manager,
        getParentSessionId: async () => parentGate.promise,
        logger,
        pollIntervalMs: 20,
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.sessionId).toBe('session-A')

      // A descendant of A begins resolving; its parent lookup is deferred.
      const resolving = controller.resolveSandboxForSession('descendant-of-A')

      // Reconciliation moves the selected root from A to B while the lookup is in flight.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-B' }))
      await vi.advanceTimersByTimeAsync(20)
      expect(repo.getApplied(PROJECT)?.sessionId).toBe('session-B')

      parentGate.resolve('session-A')
      // A's descendant must not receive B's sandbox: root no longer matches the acknowledged root.
      // The two starts are the legitimate ON(A) and ON(B) reconciliations; the deferred descendant
      // resolution adds no third restore.
      await expect(resolving).resolves.toBeNull()
      expect(manager.ensureRunningCalls).toHaveLength(2)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('repeated concurrent start installs one interval and every caller awaits initial reconciliation', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<string>()
      manager.setEnsureRunningImpl(() => gate.promise)
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-single-start' }))
      const controller = createController({ pollIntervalMs: 20 })

      const s1 = controller.start()
      const s2 = controller.start()
      const s3 = controller.start()

      let resolved = false
      s1.then(() => {
        resolved = true
      })
      s2.then(() => {
        resolved = true
      })
      s3.then(() => {
        resolved = true
      })

      // No caller resolves until the initial (gated) reconciliation completes; only one starts.
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)
      expect(manager.ensureRunningCalls).toHaveLength(1)
      expect(repo.getControllerState(PROJECT)).toEqual({
        version: 1,
        phase: 'loading',
        revision: 'r-single-start',
        sessionId: ROOT_SESSION,
      })

      gate.resolve(`forge-${MANAGER_KEY}`)
      await Promise.all([s1, s2, s3])
      expect(resolved).toBe(true)
      expect(manager.ensureRunningCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
      expect(repo.getControllerState(PROJECT)?.phase).toBe('ready')

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a rejected start can be retried without creating a second controller', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-retry-start' }))
    let failLoadingWrite = true
    const wrappedRepo: SessionSandboxPreferencesRepo = {
      getDesired: (p) => repo.getDesired(p),
      setDesired: (p, s) => repo.setDesired(p, s),
      getApplied: (p) => repo.getApplied(p),
      setApplied: (p, s) => repo.setApplied(p, s),
      getControllerState: (p) => repo.getControllerState(p),
      setControllerState: (p, s) => {
        if (s.phase === 'loading' && failLoadingWrite) {
          failLoadingWrite = false
          throw new Error('SQLITE_BUSY: database is locked')
        }
        repo.setControllerState(p, s)
      },
      getPair: (p) => repo.getPair(p),
    }
    const controller = createController({ preferences: wrappedRepo })

    await expect(controller.start()).rejects.toThrow(/SQLITE_BUSY/)
    expect(repo.getControllerState(PROJECT)?.phase).toBe('failed')

    await expect(controller.start()).resolves.toBeUndefined()
    expect(repo.getControllerState(PROJECT)?.phase).toBe('ready')
    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])

    await controller.dispose()
  })

  test('concurrent dispose calls await the same cleanup and stop the container once', async () => {
    const gate = deferred<string>()
    manager.setEnsureRunningImpl(() => gate.promise)
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-conc-dispose', enabled: true }))
    const controller = createController()

    const starting = controller.start()
    const d1 = controller.dispose()
    const d2 = controller.dispose()
    const d3 = controller.dispose()
    gate.resolve(`forge-${MANAGER_KEY}`)
    await starting
    await Promise.all([d1, d2, d3])

    // Single cleanup: one stop, applied OFF persisted before any dispose caller resolves.
    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(controller.getState()?.enabled).toBe(false)
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.toBeNull()
  })

  test('a failed selection blocks descendants too but leaves unrelated sessions unaffected', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-fail-desc', sessionId: ROOT_SESSION }))
    manager.setEnsureRunningImpl(async () => {
      throw new Error('startup failed')
    })
    const parents: Record<string, string | null> = { 'session-sub': ROOT_SESSION }
    const controller = createController({ getParentSessionId: async (sid) => parents[sid] ?? null })
    await controller.start()

    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/startup failed/)
    await expect(controller.resolveSandboxForSession('session-sub')).rejects.toThrow(/startup failed/)
    // An unrelated session has no acknowledged binding and is not blocked: host fallback is allowed.
    await expect(controller.resolveSandboxForSession('session-unrelated')).resolves.toBeNull()
    await controller.dispose()
  })

  test('failed selection blocking is restored across a fresh instance from the persisted error row', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-persist-fail', sessionId: ROOT_SESSION }))
    // A prior failed start already acknowledged as OFF with an error at the same revision.
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-persist-fail',
      enabled: false,
      sessionId: ROOT_SESSION,
      error: 'container died',
      appliedAt: Date.now(),
    })
    const controller = createController()
    await controller.start()
    // Desired is still ON and never successfully applied: the selected session stays blocked.
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/container died/)
    await controller.dispose()
  })

  test('an empty-string error on a persisted applied row remains fail-closed after restart', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-empty-err', sessionId: ROOT_SESSION }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-empty-err',
      enabled: false,
      sessionId: ROOT_SESSION,
      error: '',
      appliedAt: Date.now(),
    })
    const controller = createController()
    await controller.start()
    // An empty-string error still records a failed start: the selected session must not run on host.
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/unavailable/)
    await controller.dispose()
  })

  test('concurrent failed-selection replacement never returns host fallback for the newly selected root or descendants', async () => {
    vi.useFakeTimers()
    try {
      manager.setEnsureRunningImpl(async () => {
        throw new Error('start failed')
      })
      const gates: Array<ReturnType<typeof deferred<string | null>>> = []
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-A' }))
      const controller = createSessionSandboxController({
        projectId: PROJECT,
        directory: DIRECTORY,
        preferences: repo,
        sandboxManager: manager,
        getParentSessionId: async () => {
          const g = deferred<string | null>()
          gates.push(g)
          return g.promise
        },
        logger,
        pollIntervalMs: 20,
      })
      await controller.start()
      // Desired ON for A failed at startup: failedSelection = { session-A }.
      await expect(controller.resolveSandboxForSession('session-A')).rejects.toThrow(/start failed/)

      // A descendant of A begins resolving; its parent lookup is deferred.
      const resolving = controller.resolveSandboxForSession('desc-A')
      await vi.advanceTimersByTimeAsync(0)
      expect(gates).toHaveLength(1)

      // A superseding request for B fails while the descendant lookup is in flight.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-B' }))
      await vi.advanceTimersByTimeAsync(20)
      expect(repo.getApplied(PROJECT)?.revision).toBe('r-b')

      // Resolve the descendant's first parent lookup to the old failed root (A): the retry must
      // re-match against the NEW failed selection (B) so the descendant still fails closed.
      gates[0].resolve('session-A')
      await vi.advanceTimersByTimeAsync(0)
      expect(gates.length).toBeGreaterThanOrEqual(2)
      gates[1].resolve('session-B')
      await expect(resolving).rejects.toThrow(/start failed/)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an identical recreated failed selection does not exhaust the retry cap during a slow lookup', async () => {
    vi.useFakeTimers()
    try {
      manager.setEnsureRunningImpl(async () => {
        throw new Error('start failed')
      })
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-fail', sessionId: 'session-X' }))
      const gates: Array<ReturnType<typeof deferred<string | null>>> = []
      const controller = createSessionSandboxController({
        projectId: PROJECT,
        directory: DIRECTORY,
        preferences: repo,
        sandboxManager: manager,
        getParentSessionId: async () => {
          const g = deferred<string | null>()
          gates.push(g)
          return g.promise
        },
        logger,
        pollIntervalMs: 20,
      })
      await controller.start()
      // Start failed: failedSelection = session-X (applied OFF-with-error).
      await expect(controller.resolveSandboxForSession('session-X')).rejects.toThrow(/start failed/)

      // A descendant's parent lookup is slow and gated.
      const resolving = controller.resolveSandboxForSession('desc-X')
      await vi.advanceTimersByTimeAsync(0)
      expect(gates).toHaveLength(1)

      // Reconcile keeps re-recording the IDENTICAL failure (new object identity, same session) on
      // idle ticks while the descendant lookup is in flight.
      await vi.advanceTimersByTimeAsync(100)

      // The lookup resolves to the same failed root: the selection did not change, so the session
      // fails closed immediately without re-matching through (and exhausting) the retry cap.
      gates[0].resolve('session-X')
      await expect(resolving).rejects.toThrow(/start failed/)
      expect(gates).toHaveLength(1)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a deferred restore failure is attributed to the recovered binding, not a superseding desired revision', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-A' }))
      const controller = createController({
        pollIntervalMs: 20,
        getParentSessionId: async (sid) => (sid === 'desc-A' ? 'session-A' : null),
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // The acknowledged container dies; the first restore attempt is gated and then fails.
      const recoveryGate = deferred<string>()
      let gateFirst = true
      manager.setEnsureRunningImpl(async (key, dir) => {
        if (gateFirst) {
          gateFirst = false
          await recoveryGate.promise
          throw new Error('restore failed')
        }
        return `forge-${key}`
      })

      // A descendant of A triggers a container restore; its ensureRunning await is gated, holding
      // the lifecycle lock so the pending rebind's reconcile is blocked.
      const resolving = controller.resolveSandboxForSession('desc-A', { throwOnRestoreError: true })
      await vi.advanceTimersByTimeAsync(0)

      // The user rebinds to B while A's recovery is in flight (desired moves to a new revision).
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-B' }))

      // A's recovery fails.
      recoveryGate.resolve('')
      await expect(resolving).rejects.toThrow(/restore failed/)

      // The failure was attributed to A (the binding being recovered), never to B: once the blocked
      // reconcile runs, B is attempted and acknowledged ON instead of being marked failed.
      await vi.advanceTimersByTimeAsync(20)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(true)
      expect(applied?.sessionId).toBe('session-B')
      expect(applied?.revision).toBe('r-b')
      expect(applied?.error).toBeNull()
      await expect(controller.resolveSandboxForSession('session-B')).resolves.not.toBeNull()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an instance that does not own the requested session neither starts nor acknowledges it', async () => {
    const OTHER_DIR = '/abs/path/other-worktree'
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-other', sessionId: 'session-other' }))
    const nonOwner = createController({
      getSessionDirectory: async (sid) => (sid === 'session-other' ? OTHER_DIR : DIRECTORY),
    })
    await nonOwner.start()
    expect(manager.ensureRunningCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toBeNull()
    // Disposal must not overwrite a shared acknowledgement for a session it does not own.
    await nonOwner.dispose()
    expect(repo.getApplied(PROJECT)).toBeNull()
  })

  test('an instance whose directory lookup cannot resolve a session does not claim it', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-unresolved', sessionId: 'session-unresolved' }))
    // The directory-scoped lookup returns null because this instance cannot see the session (e.g.
    // a loop-worktree child resolving a root session). It must be treated as not owned: no sandbox
    // is started and no acknowledgement is written.
    const controller = createController({
      getSessionDirectory: async () => null,
    })
    await controller.start()
    expect(manager.ensureRunningCalls).toEqual([])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toBeNull()
    await controller.dispose()
    expect(repo.getApplied(PROJECT)).toBeNull()
  })

  test('a previous owner stops and clears its binding when the selection moves to another instance', async () => {
    vi.useFakeTimers()
    try {
      const ROOT_DIR = DIRECTORY
      const WORKTREE_DIR = '/abs/path/loop-worktree'
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-root' }))
      const ownerA = createController({
        pollIntervalMs: 20,
        getSessionDirectory: async (sid) => (sid === 'session-root' ? ROOT_DIR : WORKTREE_DIR),
      })
      await ownerA.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
      expect(await ownerA.resolveSandboxForSession('session-root')).not.toBeNull()

      // Selection rebinds to a session owned by another instance (in a different directory).
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-wt' }))

      // ownerA's next poll reconciles the moved selection: it must NOT acknowledge r-b (it does not
      // own session-wt), but must stop its own container and clear its binding so only one active
      // binding remains once the selection moves away.
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toContain(MANAGER_KEY)
      expect(repo.getApplied(PROJECT)?.revision).toBe('r-a')
      // The previously selected root session no longer resolves.
      await expect(ownerA.resolveSandboxForSession('session-root')).resolves.toBeNull()
      await ownerA.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('two instances sharing a project DB cannot acknowledge or overwrite each other\'s sandbox', async () => {
    const ROOT_DIR = DIRECTORY
    const WORKTREE_DIR = '/abs/path/loop-worktree'
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-root', sessionId: 'session-root' }))

    // The root instance owns the root session and starts its own directory-derived sandbox.
    const root = createController({
      directory: ROOT_DIR,
      getSessionDirectory: async (sid) => (sid === 'session-root' ? ROOT_DIR : WORKTREE_DIR),
    })
    await root.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    // A worktree child instance shares the same preference DB but a different directory. It must
    // not start its own sandbox or overwrite the root's acknowledgement for the root session.
    const child = createController({
      directory: WORKTREE_DIR,
      getSessionDirectory: async (sid) => (sid === 'session-root' ? ROOT_DIR : WORKTREE_DIR),
    })
    await child.start()
    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])

    // Child disposal must not stop the root's acknowledged sandbox or overwrite its applied row.
    await child.dispose()
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(true)
    expect(applied?.sessionId).toBe('session-root')
    expect(applied?.revision).toBe('r-root')
    await root.dispose()
  })

  test('an active sandbox loop session cannot receive a host-sandbox ON acknowledgement', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-sandbox', sessionId: 'session-loop' }))
    const controller = createController({
      resolveActiveLoopForSession: async (sid) => (sid === 'session-loop' ? { active: true, sandbox: true } : null),
    })
    await controller.start()
    expect(manager.ensureRunningCalls).toEqual([])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.sessionId).toBe('session-loop')
    expect(applied?.error).toMatch(/active loop session/)
    await controller.dispose()
  })

  test('an active worktree-only loop session cannot receive a host-sandbox ON acknowledgement', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-worktree', sessionId: 'session-wt' }))
    const controller = createController({
      resolveActiveLoopForSession: async (sid) => (sid === 'session-wt' ? { active: true, worktree: true } : null),
    })
    await controller.start()
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/active loop session/)
    await controller.dispose()
  })

  test('a loop-refused session stays blocked after the loop terminates before the next tick', async () => {
    vi.useFakeTimers()
    try {
      let inLoop = true
      const parents: Record<string, string | null> = { 'session-sub': ROOT_SESSION }
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-refuse', sessionId: ROOT_SESSION }))
      const controller = createController({
        pollIntervalMs: 500,
        getParentSessionId: async (sid) => parents[sid] ?? null,
        resolveActiveLoopForSession: async () => (inLoop ? { active: true, sandbox: true } : null),
      })
      await controller.start()

      // Refusal acknowledged OFF with the loop error.
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/active loop session/)

      // The loop terminates before the next 500ms reconciliation tick. The unified resolver now
      // sees no active loop and falls through to the host controller; the refused session and its
      // descendants must still be blocked fail-closed rather than returning host fallback.
      inLoop = false
      await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/active loop session/)
      await expect(controller.resolveSandboxForSession('session-sub')).rejects.toThrow(/active loop session/)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispose stops its active container even when desired rebinds to a non-owned session', async () => {
    const OTHER_DIR = '/abs/path/other-worktree'
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: ROOT_SESSION }))
    const controller = createController({
      getSessionDirectory: async (sid) => (sid === ROOT_SESSION ? DIRECTORY : OTHER_DIR),
    })
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
    expect(manager.stopCalls).toEqual([])

    // Desired rebinds to a session owned by another instance before this instance reconciles.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-other' }))

    // Disposal must still tear down the container this controller started (no leak), but must not
    // write an applied acknowledgement for the non-owned desired session.
    await controller.dispose()
    expect(manager.stopCalls).toContain(MANAGER_KEY)
    expect(repo.getApplied(PROJECT)?.revision).toBe('r-a')
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
  })

  test('resolution fails closed when a failure is recorded mid-resolution', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: ROOT_SESSION }))
      const parentGate = deferred<string | null>()
      const controller = createSessionSandboxController({
        projectId: PROJECT,
        directory: DIRECTORY,
        preferences: repo,
        sandboxManager: manager,
        getParentSessionId: async (sid) => (sid === 'session-sub' ? parentGate.promise : null),
        logger,
        pollIntervalMs: 20,
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // A descendant of the acknowledged root begins resolving; its parent lookup is deferred.
      const resolving = controller.resolveSandboxForSession('session-sub')

      // While the lookup is in flight, a reconciliation records a failed start for the root session
      // (a superseded desired ON fails ensureRunning): the binding is cleared and the root becomes
      // null, so the in-flight resolution would otherwise fall through to host execution.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-fail', sessionId: ROOT_SESSION }))
      manager.setEnsureRunningImpl(async () => {
        throw new Error('start failed')
      })
      await vi.advanceTimersByTimeAsync(20)
      expect(repo.getApplied(PROJECT)?.enabled).toBe(false)
      expect(repo.getApplied(PROJECT)?.error).toMatch(/start failed/)

      parentGate.resolve(ROOT_SESSION)
      // The descendant must not fall through to host (null); it must fail closed instead.
      await expect(resolving).rejects.toThrow(/start failed/)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a transient parent lookup failure rejects resolution instead of falling back to host', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-on', sessionId: ROOT_SESSION }))
    const controller = createController({
      pollIntervalMs: 500,
      // The acknowledged root resolves fine, but the subagent's parent lookup hits a transient
      // failure. This mirrors createParentSessionLookup propagating a connection error rather than
      // caching a false "not a descendant".
      getParentSessionId: async (sid) => {
        if (sid === ROOT_SESSION) return null
        throw new Error('Unable to connect')
      },
    })
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    // The transient failure must reject (fail closed) so bash/glob/grep do not run host-side for
    // the descendant, rather than returning null which hooks treat as host permission.
    await expect(controller.resolveSandboxForSession('session-sub')).rejects.toThrow(/Unable to connect/)
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.not.toBeNull()
    await controller.dispose()
  })

  test('a failed stop is retried on the next reconcile until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-off-up', enabled: true, sessionId: ROOT_SESSION }))
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Desired moves OFF and the stop fails transiently.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-off-retry', enabled: false, sessionId: ROOT_SESSION }))
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)

      // The failed stop is acknowledged OFF-with-error and ownership is preserved for retry.
      let applied = repo.getApplied(PROJECT)
      expect(applied?.revision).toBe('r-off-retry')
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/transient removal failure/)

      // The removal now succeeds; the next reconcile retries and settles OFF without error.
      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      applied = repo.getApplied(PROJECT)
      expect(applied?.revision).toBe('r-off-retry')
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toBeNull()
      expect(manager.stopCalls).toHaveLength(2)

      await controller.dispose()
      expect(manager.stopCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed stop during absent-desired teardown is retried until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-absent-up', sessionId: ROOT_SESSION }))
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // The desired row is removed entirely; the teardown stop fails transiently.
      db.run('DELETE FROM tui_preferences WHERE project_id = ? AND key = ?', [PROJECT, 'session-sandbox.desired'])
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      // The failed teardown stop retains ownership: it is retried, never settled while live.
      expect(manager.stopCalls).toHaveLength(1)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.toBeNull()

      await controller.dispose()
      expect(manager.stopCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed stop during a null-session transition is retried until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-ns-up', sessionId: ROOT_SESSION }))
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Desired rebinds to a null session; the transition stop fails transiently.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-ns', enabled: true, sessionId: null }))
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(1)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/without a session/)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed stop during a loop-refusal transition is retried until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      let inLoop = false
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-up', sessionId: ROOT_SESSION }))
      const controller = createController({
        pollIntervalMs: 20,
        resolveActiveLoopForSession: async () => ({ active: inLoop, sandbox: true }),
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // The session becomes part of an active loop; the refusal stop fails transiently.
      inLoop = true
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop', sessionId: ROOT_SESSION }))
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(1)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/active loop session/)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed stop during failed-start cleanup is retried until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-fs-up', sessionId: ROOT_SESSION }))
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // A new start attempt fails and the cleanup stop fails transiently.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-fs', sessionId: ROOT_SESSION }))
      manager.setEnsureRunningImpl(async () => {
        throw new Error('start failed')
      })
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(1)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      // Pending cleanup resolves (stop 2) and the failure is settled OFF-with-error; the still-ON
      // desired is never re-attempted, so the failed start is not retried.
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/start failed/)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed stop during ownership transfer is retried until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      const ROOT_DIR = DIRECTORY
      const WORKTREE_DIR = '/abs/path/loop-worktree'
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-root' }))
      const ownerA = createController({
        pollIntervalMs: 20,
        getSessionDirectory: async (sid) => (sid === 'session-root' ? ROOT_DIR : WORKTREE_DIR),
      })
      await ownerA.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Selection rebinds to a session owned by another instance; the transfer stop fails.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-wt' }))
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transfer removal failed')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      // The non-owner never acknowledges r-b, and a failed stop preserves ownership for retry.
      expect(repo.getApplied(PROJECT)?.revision).toBe('r-a')
      expect(manager.stopCalls).toHaveLength(1)

      // The removal now succeeds; the transfer completes without leaking the container.
      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      await expect(ownerA.resolveSandboxForSession('session-root')).resolves.toBeNull()

      await ownerA.dispose()
      expect(manager.stopCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a restarted instance leaves the shared container to its owner when ownership is foreign', async () => {
    vi.useFakeTimers()
    try {
      const WORKTREE_DIR = '/abs/path/loop-worktree'
      // Instance A binds ON to a local session and starts its container, then "crashes" without
      // disposing, leaving the container live at the deterministic manager key.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-root' }))
      const first = createController({
        pollIntervalMs: 20,
        getSessionDirectory: async (sid) => (sid === 'session-root' ? DIRECTORY : WORKTREE_DIR),
      })
      await first.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
      expect(manager.stopCalls).toEqual([])
      expect(manager.getActive(MANAGER_KEY)).not.toBeNull()

      // The preference is rebound to a session another instance owns before A restarts.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-wt' }))

      // A restarts: the desired session is foreign to its directory and hostActive is false after
      // restart. The manager key is derived from the project id and is therefore shared by every
      // instance of this project, so the live container now belongs to whichever instance owns the
      // selected session. A must leave it alone: stopping it here would tear down the owner's
      // sandbox. It is not leaked, because the owner reconciles the very same key.
      const restarted = createController({
        pollIntervalMs: 20,
        getSessionDirectory: async (sid) => (sid === 'session-root' ? DIRECTORY : WORKTREE_DIR),
      })
      await restarted.start()
      expect(manager.stopCalls).not.toContain(MANAGER_KEY)
      expect(manager.getActive(MANAGER_KEY)).not.toBeNull()
      // The foreign acknowledgement is never overwritten.
      expect(repo.getApplied(PROJECT)?.revision).toBe('r-a')
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      await restarted.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('the container key follows the project id, not the instance directory', async () => {
    // The desired/applied preference rows are stored per project, so the container must be keyed at
    // the same granularity. A second checkout of the same project has to resolve the very same
    // container instead of starting a competing one against the single shared preference row.
    const OTHER_CHECKOUT = '/abs/path/to/another-checkout'
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-key', sessionId: ROOT_SESSION }))
    const controller = createController({
      directory: OTHER_CHECKOUT,
      getSessionDirectory: async () => OTHER_CHECKOUT,
    })
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(MANAGER_KEY).toBe(deriveManagerKey(PROJECT))
    expect(MANAGER_KEY).not.toBe(deriveManagerKey(OTHER_CHECKOUT))

    await controller.dispose()
  })

  test('an idle acknowledged sandbox does not re-run ensureRunning on every poll', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-idle', sessionId: ROOT_SESSION }))
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()
      // Initial reconcile validated the runtime exactly once.
      expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])

      // Many idle polls must not call ensureRunning again (no repeated work for the applied revision).
      await vi.advanceTimersByTimeAsync(1000)
      expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])

      // Resolution still returns the acknowledged sandbox; its liveness restore is separate and
      // legitimate (one extra ensureRunning for the explicit tool-path recovery).
      await expect(controller.resolveSandboxForSession(ROOT_SESSION)).resolves.not.toBeNull()
      expect(manager.ensureRunningCalls).toHaveLength(2)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an ON request without a session is acknowledged OFF-with-error and never starts SBX', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-null-session', enabled: true, sessionId: null }))
    const controller = createController()
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([])
    expect(manager.stopCalls).toEqual([])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-null-session')
    expect(applied?.enabled).toBe(false)
    expect(applied?.sessionId).toBeNull()
    expect(applied?.error).toMatch(/without a session/)
    await controller.dispose()
  })

  test('a persisted null-session ON request is refused again on a fresh instance', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-null-persist', enabled: true, sessionId: null }))
    const first = createController()
    await first.start()
    expect(repo.getApplied(PROJECT)?.error).toMatch(/without a session/)
    await first.dispose()

    // A fresh instance re-reads the same persisted desired ON (with no session) and refuses it
    // again rather than starting an orphaned container.
    const second = createController()
    await second.start()
    expect(manager.ensureRunningCalls).toEqual([])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/without a session/)
    await second.dispose()
  })

  test('a fresh-start partial-creation failure always cleans up the container it created', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-partial', sessionId: ROOT_SESSION }))
    // ensureRunning creates the container (env file) and then fails: a first start with no prior
    // binding must still run deterministic-key cleanup so the created container is not leaked.
    manager.setEnsureRunningImpl(async (key, dir) => {
      manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
      throw new Error('env file generation failed')
    })
    const controller = createController()
    await controller.start()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-partial')
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/env file generation failed/)
    // No live container remains to expose.
    expect(manager.active).toBeNull()
    await controller.dispose()
  })

  test('fresh-start partial-creation cleanup is retried when the cleanup stop fails transiently', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-partial-retry', sessionId: ROOT_SESSION }))
      manager.setEnsureRunningImpl(async (key, dir) => {
        manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
        throw new Error('start failed after creation')
      })
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()

      // First cleanup attempt fails; ownership is retained and no settled OFF-with-error is written.
      expect(manager.stopCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)).toBeNull()

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      // Pending cleanup resolves (stop 2) and the failure is settled OFF-with-error; the still-ON
      // start is never re-attempted, so no extra cleanup runs.
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/start failed after creation/)
      expect(manager.active).toBeNull()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed-start cleanup stop is retried before any start can adopt the live partial container', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-adopt', sessionId: ROOT_SESSION }))
      // The first start creates the container and then fails (env-file setup). A subsequent
      // ensureRunning would now SUCCEED: without a pending-cleanup guard the next reconcile tick
      // would adopt the partially-initialized container and wrongly acknowledge ON.
      let startCount = 0
      manager.setEnsureRunningImpl(async (key, dir) => {
        startCount++
        if (startCount === 1) {
          manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
          throw new Error('start failed after creation')
        }
        return `forge-${key}`
      })
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      const controller = createController({ pollIntervalMs: 20 })
      await controller.start()

      // First cleanup attempt fails; ownership is retained and no applied row is written yet.
      expect(manager.stopCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)).toBeNull()

      // While removal keeps failing, the retry must retry REMOVAL, not start: even though a fresh
      // ensureRunning would succeed, the live partial container must not be adopted and
      // acknowledged ON.
      await vi.advanceTimersByTimeAsync(60)
      expect(manager.stopCalls).toHaveLength(4)
      expect(startCount).toBe(1)
      expect(repo.getApplied(PROJECT)).toBeNull()

      // Removal now succeeds; the failed start is settled OFF-with-error rather than re-attempting
      // the ON start, so the live partial container is never adopted.
      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(startCount).toBe(1)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/start failed after creation/)

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('tool-path restore failure stops the container and replaces stale applied ON with OFF-with-error', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-restore-fail2', sessionId: ROOT_SESSION }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
    expect(await controller.resolveSandboxForSession(ROOT_SESSION)).not.toBeNull()

    // The acknowledged container dies; recovery recreates it but fails during env-file setup,
    // leaving a partially-created container and a stale applied-ON row.
    manager.setEnsureRunningImpl(async (key, dir) => {
      manager.active = { containerName: `forge-${key}`, projectDir: dir, startedAt: new Date().toISOString(), mounts: [] }
      throw new Error('env setup failed during restore')
    })
    await expect(
      controller.resolveSandboxForSession(ROOT_SESSION, { throwOnRestoreError: true }),
    ).rejects.toThrow(/env setup failed during restore/)

    // The stale applied-ON is replaced with OFF-with-error and the live container is removed.
    const applied = repo.getApplied(PROJECT)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toMatch(/env setup failed during restore/)
    expect(manager.active).toBeNull()
    // The selected session stays fail-closed rather than falling back to the host.
    await expect(controller.resolveSandboxForSession(ROOT_SESSION)).rejects.toThrow(/env setup failed during restore/)
    await controller.dispose()
  })

  test('a session that enters an active loop after ON is settled has its host sandbox stopped and OFF acknowledged', async () => {
    vi.useFakeTimers()
    try {
      let inLoop = false
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-later', sessionId: ROOT_SESSION }))
      const controller = createController({
        pollIntervalMs: 20,
        resolveActiveLoopForSession: async () => ({ active: inLoop, sandbox: true }),
      })
      await controller.start()
      // Not in a loop yet: the host sandbox is ON and acknowledged, and nothing was stopped.
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)
      expect(manager.stopCalls).toEqual([])

      // The selected session enters an active loop WITHOUT changing the desired revision.
      inLoop = true
      await vi.advanceTimersByTimeAsync(20)

      // The host sandbox is stopped and the acknowledgement is flipped to OFF-with-error for the
      // same revision, so the sidebar no longer reports ON and no container is leaked.
      expect(manager.stopCalls).toContain(MANAGER_KEY)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.revision).toBe('r-loop-later')
      expect(applied?.error).toMatch(/active loop session/)
      expect(controller.getState()?.enabled).toBe(false)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a session that enters an active loop stays fail-closed until its removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      let inLoop = false
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-later-retry', sessionId: ROOT_SESSION }))
      const controller = createController({
        pollIntervalMs: 20,
        resolveActiveLoopForSession: async () => ({ active: inLoop, sandbox: true }),
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      inLoop = true
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      // A failed removal retains ownership: no settled OFF-with-error is written yet.
      expect(manager.stopCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/active loop session/)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('start rejects when the initial reconciliation fails, failing closed instead of restoring stale ON', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-start-fail' }))
    const controller = createController({
      resolveActiveLoopForSession: async () => {
        throw new Error('session lookup failed')
      },
    })
    // Startup reconciliation must not swallow errors: a transient session-lookup failure must fail
    // the plugin startup rather than return with an ON indicator and no restored runtime binding.
    await expect(controller.start()).rejects.toThrow(/session lookup failed/)
    expect(manager.ensureRunningCalls).toEqual([])
  })

  test('dispose tears down a pre-existing container when startup restore aborts on a lookup failure', async () => {
    // An unclean restart left the container running and the applied row ON at the desired revision.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-restore-abort' }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-restore-abort',
      enabled: true,
      sessionId: ROOT_SESSION,
      error: null,
      appliedAt: Date.now(),
    })
    manager.setActive({ containerName: `forge-${MANAGER_KEY}`, projectDir: DIRECTORY, startedAt: new Date().toISOString(), mounts: [] })
    const controller = createController({
      resolveActiveLoopForSession: async () => {
        throw new Error('session lookup failed')
      },
    })
    // Startup fails closed: the persisted-ON restore cannot validate the session membership.
    await expect(controller.start()).rejects.toThrow(/session lookup failed/)
    expect(manager.ensureRunningCalls).toEqual([])

    // Cleanup must still tear down the pre-existing container even though hostActive was never set.
    await controller.dispose()
    expect(manager.stopCalls).toContain(MANAGER_KEY)
    expect(manager.active).toBeNull()
  })

  test('uncertain ownership of an ON request fails closed instead of exposing host fallback', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-uncertain', sessionId: 'session-x' }))
    // The directory-scoped lookup cannot resolve the session: ownership is uncertain, not confirmed
    // foreign, so the controller must neither claim it nor leave host fallback exposed.
    const controller = createController({
      getSessionDirectory: async () => null,
    })
    await controller.start()
    expect(manager.ensureRunningCalls).toEqual([])
    // No acknowledgement is written (ownership cannot be confirmed), but the selected session must
    // still be blocked fail-closed rather than falling through to host execution.
    expect(repo.getApplied(PROJECT)).toBeNull()
    await expect(
      controller.resolveSandboxForSession('session-x', { throwOnRestoreError: true }),
    ).rejects.toThrow(/ownership could not be confirmed/)
    await controller.dispose()
  })

  test('a session lookup that never settles cannot hang controller readiness', async () => {
    vi.useFakeTimers()
    try {
      // A persisted desired ON names a session from the previous run. If the lookup for that
      // session never answers, an unbounded await would block every host sandbox resolution.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-hang', sessionId: 'session-gone' }))
      const controller = createController({
        // Polling is pushed out of the way so this exercises the startup reconcile alone; steady
        // state ticks would each open another bounded lookup.
        pollIntervalMs: OWNERSHIP_LOOKUP_TIMEOUT_MS * 1000,
        getSessionDirectory: () => new Promise<string | null>(() => {}),
      })

      let settled = false
      const started = controller.start().then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(OWNERSHIP_LOOKUP_TIMEOUT_MS - 1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(2)
      await started
      expect(settled).toBe(true)

      // The timed-out lookup is uncertain ownership, which fails closed: nothing was started, and
      // the selected session is recorded as a failed selection rather than left to run host-side.
      expect(manager.ensureRunningCalls).toEqual([])
      expect(repo.getApplied(PROJECT)).toBeNull()

      // Not disposed: disposal serializes behind the reconcile chain, and the never-settling lookup
      // would need further timer advancement to drain. Nothing was started, and restoring real
      // timers discards the poll interval, so there is no resource to release.
      expect(manager.stopCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispose leaves a pre-existing container to its owner when ownership is uncertain for a persisted ON', async () => {
    // An unclean restart left the container running and the applied row ON at the desired revision,
    // but the directory-scoped ownership lookup cannot resolve the session (uncertain, not foreign),
    // so reconciliation returns before confirming the container lifecycle.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-uncertain-on', sessionId: 'session-x' }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-uncertain-on',
      enabled: true,
      sessionId: 'session-x',
      error: null,
      appliedAt: Date.now(),
    })
    manager.setActive({ containerName: `forge-${MANAGER_KEY}`, projectDir: DIRECTORY, startedAt: new Date().toISOString(), mounts: [] })
    const controller = createController({
      getSessionDirectory: async () => null,
    })
    // Reconciliation does not confirm ownership, so it never confirms (or starts) the container.
    await controller.start()
    expect(manager.stopCalls).toEqual([])
    // The manager key is derived from the project id and is shared by every instance of this
    // project. Uncertain ownership cannot confirm this instance owns the selected session, and
    // hostActive was never set, so this instance never started the container. Stopping it on
    // disposal could tear down another instance's live sandbox, so it is left for its owner to
    // reconcile.
    await controller.dispose()
    expect(manager.stopCalls).not.toContain(MANAGER_KEY)
    expect(manager.active).not.toBeNull()
  })

  test('dispose stops the container even when preference bookkeeping fails', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-dispose-book' }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

    // A transient bookkeeping failure (applied-row read throws) after the container is stopped must
    // not abort disposal before container removal.
    const getDesiredSpy = vi.spyOn(repo, 'getDesired').mockImplementation(() => {
      throw new Error('sqlite read failed')
    })
    await controller.dispose()
    getDesiredSpy.mockRestore()

    // The container must still have been stopped even though the OFF bookkeeping failed.
    expect(manager.stopCalls).toContain(MANAGER_KEY)
  })

  test("a superseded restore failure does not overwrite the newer applied acknowledgement", async () => {
    const OTHER_SESSION = 'session-b'
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: ROOT_SESSION }))
    const controller = createController({ pollIntervalMs: 60_000 })
    await controller.start()
    expect(await controller.resolveSandboxForSession(ROOT_SESSION)).not.toBeNull()
    expect(repo.getApplied(PROJECT)?.revision).toBe('r-a')

    // Desired supersedes to B while A is still the acknowledged root. B's applied acknowledgement
    // is already recorded as the newer shared state this controller must not clobber.
    repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: OTHER_SESSION }))
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'r-b',
      enabled: true,
      sessionId: OTHER_SESSION,
      error: null,
      appliedAt: 5000,
    })

    // A's container dies and the restore now fails (only the first recovery attempt fails).
    let failFirst = true
    manager.setEnsureRunningImpl(async (key, dir) => {
      if (failFirst) {
        failFirst = false
        throw new Error('cannot recover container')
      }
      return `forge-${key}`
    })

    await expect(
      controller.resolveSandboxForSession(ROOT_SESSION, { throwOnRestoreError: true }),
    ).rejects.toThrow('cannot recover container')

    // A's failure must not overwrite B's newer applied acknowledgement: B's revision stays applied
    // and the reconcile after the superseded failure re-validates B instead of recording A's error.
    const applied = repo.getApplied(PROJECT)
    expect(applied?.revision).toBe('r-b')
    expect(applied?.enabled).toBe(true)
    expect(applied?.error).toBeNull()
    await controller.dispose()
  })

  test('startup loop refusal stops a stale deterministic-key container left by a crashed ON', async () => {
    vi.useFakeTimers()
    try {
      // A prior run left the container live (unclean crash) and the applied row ON at an OLD
      // revision, while desired has since moved to a NEW loop-refused revision. On restart the
      // fresh instance has hostActive=false, yet the refusal must still stop the stale container.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-loop-new', sessionId: ROOT_SESSION }))
      repo.setApplied(PROJECT, {
        version: 1,
        revision: 'r-old',
        enabled: true,
        sessionId: ROOT_SESSION,
        error: null,
        appliedAt: Date.now(),
      })
      manager.setActive({
        containerName: `forge-${MANAGER_KEY}`,
        projectDir: DIRECTORY,
        startedAt: new Date().toISOString(),
        mounts: [],
      })
      const controller = createController({
        pollIntervalMs: 20,
        resolveActiveLoopForSession: async () => ({ active: true, sandbox: true }),
      })
      await controller.start()
      // The stale container is removed before the refusal is acknowledged OFF, even though
      // hostActive was false after the fresh restart.
      expect(manager.stopCalls).toContain(MANAGER_KEY)
      expect(manager.active).toBeNull()
      const applied = repo.getApplied(PROJECT)
      expect(applied?.revision).toBe('r-loop-new')
      expect(applied?.enabled).toBe(false)
      expect(applied?.error).toMatch(/active loop session/)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed ownership-transfer stop blocks a superseding local start until removal succeeds', async () => {
    vi.useFakeTimers()
    try {
      const ROOT_DIR = DIRECTORY
      const WORKTREE_DIR = '/abs/path/loop-worktree'
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-root' }))
      const ownerA = createController({
        pollIntervalMs: 20,
        getSessionDirectory: async (sid) => (sid === 'session-root' ? ROOT_DIR : WORKTREE_DIR),
      })
      await ownerA.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Selection rebinds to a foreign session; the transfer stop fails, leaving the container live.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-wt' }))
      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transfer removal failed')
        manager.active = null
      }
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(1)

      // Selection rebinds back to the local root session while the container is still live. The
      // failed transfer must not be forgotten: no superseding start adopts the live container.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-c', sessionId: 'session-root' }))
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.ensureRunningCalls).toHaveLength(1)
      expect(manager.stopCalls).toHaveLength(2)

      // Removal now succeeds; the next reconcile retries the local start and acknowledges ON.
      stopFails = false
      await vi.advanceTimersByTimeAsync(20)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.revision).toBe('r-c')
      expect(applied?.enabled).toBe(true)
      expect(applied?.sessionId).toBe('session-root')
      await ownerA.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a superseded restore failure with a failed cleanup never adopts the superseding container', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-a', sessionId: 'session-A' }))
      const controller = createController({
        pollIntervalMs: 20,
        getParentSessionId: async (sid) => (sid === 'desc-A' ? 'session-A' : null),
      })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Desired supersedes to B (applied ON already recorded) while A is still the acknowledged root.
      repo.setDesired(PROJECT, makeDesired({ revision: 'r-b', sessionId: 'session-B' }))
      repo.setApplied(PROJECT, {
        version: 1,
        revision: 'r-b',
        enabled: true,
        sessionId: 'session-B',
        error: null,
        appliedAt: Date.now(),
      })

      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('cleanup removal failed')
        manager.active = null
      }
      manager.setEnsureRunningImpl(async () => {
        throw new Error('cannot recover A container')
      })
      // A's container recovery fails and is superseded by B; the follow-up cleanup also fails.
      await expect(
        controller.resolveSandboxForSession('desc-A', { throwOnRestoreError: true }),
      ).rejects.toThrow(/cannot recover A container/)

      // The failed cleanup retained pending ownership: while removal keeps failing the blocked
      // reconcile retries removal and never starts/adopts the superseding container.
      const startsBefore = manager.ensureRunningCalls.length
      await vi.advanceTimersByTimeAsync(40)
      expect(manager.ensureRunningCalls.length).toBe(startsBefore)
      expect(repo.getApplied(PROJECT)?.enabled).toBe(true)

      // Removal now succeeds; the blocked reconcile retries and acknowledges B ON.
      stopFails = false
      manager.setEnsureRunningImpl(async () => `forge-${MANAGER_KEY}`)
      await vi.advanceTimersByTimeAsync(20)
      const applied = repo.getApplied(PROJECT)
      expect(applied?.revision).toBe('r-b')
      expect(applied?.enabled).toBe(true)
      expect(applied?.sessionId).toBe('session-B')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
