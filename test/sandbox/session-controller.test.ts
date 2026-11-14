import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSessionSandboxController,
  createUnavailableSandboxLifecycleManager,
  deriveManagerKey,
  DEFAULT_POLL_INTERVAL_MS,
  OWNERSHIP_LOOKUP_TIMEOUT_MS,
  type SessionSandboxController,
  type SessionSandboxLifecycleManager,
} from '../../src/sandbox/session-controller'
import { createSessionSandboxPreferencesRepo } from '../../src/storage'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState, SessionSandboxPreferencesRepo } from '../../src/storage'
import type { ActiveSandbox } from '../../src/sandbox/manager'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'
import { createTestDb } from '../helpers/test-db'

const PROJECT = 'project-a'
const DIRECTORY = '/abs/path/to/project-root'
const MANAGER_KEY = deriveManagerKey(PROJECT)

function makeDesired(overrides: Partial<SessionSandboxDesiredState> = {}): SessionSandboxDesiredState {
  return { version: 2, revision: 'rev-1', sessions: {}, requestedAt: 1000, ...overrides }
}

function makeApplied(overrides: Partial<SessionSandboxAppliedState> = {}): SessionSandboxAppliedState {
  return { version: 2, revision: 'rev-1', running: true, error: null, appliedAt: 2000, ...overrides }
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
  applyOverridesCalls: string[]
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
    applyOverridesCalls: [],
    stopCalls: [],
    active: null,
    ensureRunning: async () => '',
    applyOverrides: async (key: string) => {
      manager.applyOverridesCalls.push(key)
      return 'unchanged'
    },
    stop: async (key: string) => {
      manager.stopCalls.push(key)
      manager.active = null
    },
    getActive: () => manager.active,
    setEnsureRunningImpl(fn) {
      manager.ensureRunning = async (key: string, dir: string) => {
        manager.ensureRunningCalls.push(key)
        const name = await fn(key, dir)
        manager.active = { containerName: name, projectDir: dir, startedAt: new Date().toISOString(), mounts: [], instanceId: `instance-${name}` }
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
  let testDb: ReturnType<typeof createTestDb>
  let repo: ReturnType<typeof createSessionSandboxPreferencesRepo>
  let manager: FakeManager
  let logger: ReturnType<typeof createMockLogger>
  let controllers: SessionSandboxController[]

  function trackController(controller: SessionSandboxController): SessionSandboxController {
    controllers.push(controller)
    return controller
  }

  function createController(overrides: {
    pollIntervalMs?: number
    directory?: string
    preferences?: SessionSandboxPreferencesRepo
    hostSessionsDefault?: boolean
    getParentSessionId?: (sid: string) => Promise<string | null>
    getSessionIdentity?: (sid: string) => Promise<{ projectId: string; directory: string } | null>
    onChange?: () => void
  } = {}) {
    return trackController(createSessionSandboxController({
      projectId: PROJECT,
      directory: overrides.directory ?? DIRECTORY,
      preferences: overrides.preferences ?? repo,
      sandboxManager: manager,
      hostSessionsDefault: overrides.hostSessionsDefault ?? true,
      getParentSessionId: overrides.getParentSessionId ?? (async () => null),
      getSessionIdentity: overrides.getSessionIdentity ?? (async () => ({ projectId: PROJECT, directory: DIRECTORY })),
      ...(overrides.onChange ? { onChange: overrides.onChange } : {}),
      logger,
      ...(overrides.pollIntervalMs ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
    }))
  }

  beforeEach(() => {
    testDb = createTestDb()
    repo = createSessionSandboxPreferencesRepo(testDb.db)
    manager = createFakeManager()
    logger = createMockLogger()
    controllers = []
  })

  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      await controller.dispose().catch(() => {})
    }
    testDb.cleanup()
  })

  test('default on starts one shared sandbox and every session of the project resolves to it', async () => {
    const overrides = { resources: { cpus: '6' }, allowLan: true }
    repo.setDesired(PROJECT, makeDesired({ overrides }))
    const parents: Record<string, string | null> = { 'session-child': 'session-parent' }
    const controller = createController({ getParentSessionId: async (sid) => parents[sid] ?? null })

    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.applyOverridesCalls).toEqual([MANAGER_KEY])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', running: true, error: null, overrides })

    const contexts = await Promise.all([
      controller.resolveSandboxForSession('session-one'),
      controller.resolveSandboxForSession('session-two'),
      controller.resolveSandboxForSession('session-child'),
    ])
    for (const context of contexts) {
      expect(context).not.toBeNull()
      expect(context?.containerName).toBe(`forge-${MANAGER_KEY}`)
      expect(context?.hostDir).toBe(DIRECTORY)
    }

    expect(manager.ensureRunningCalls.every((key) => key === MANAGER_KEY)).toBe(true)
    expect(manager.applyOverridesCalls).toHaveLength(1)
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', running: true })
    await controller.dispose()
  })

  test('start seeds a desired row so the default-on sandbox runs with no stored preference', async () => {
    const controller = createController()
    await controller.start()

    const desired = repo.getDesired(PROJECT)
    expect(desired).toMatchObject({ version: 2, sessions: {} })
    expect(desired?.revision).toBeTruthy()
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: desired?.revision, running: true, error: null })
    await controller.dispose()
  })

  test('an opted-out session and its child resolve to the host while other sessions keep the sandbox', async () => {
    repo.setDesired(PROJECT, makeDesired({ sessions: { 'session-optout': false } }))
    const parents: Record<string, string | null> = { 'session-optout-child': 'session-optout' }
    const controller = createController({ getParentSessionId: async (sid) => parents[sid] ?? null })
    await controller.start()
    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])

    await expect(controller.resolveSandboxForSession('session-optout')).resolves.toBeNull()
    await expect(controller.resolveSandboxForSession('session-optout-child')).resolves.toBeNull()
    expect(await controller.resolveSandboxForSession('session-other')).not.toBeNull()

    expect(repo.getApplied(PROJECT)?.running).toBe(true)
    expect(manager.stopCalls).toEqual([])
    await controller.dispose()
  })

  test('default off with one opt-in session runs the sandbox for that session and its child only', async () => {
    repo.setDesired(PROJECT, makeDesired({ sessions: { 'session-in': true } }))
    const parents: Record<string, string | null> = { 'session-in-child': 'session-in' }
    const controller = createController({
      hostSessionsDefault: false,
      getParentSessionId: async (sid) => parents[sid] ?? null,
    })
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', running: true, error: null })
    expect(await controller.resolveSandboxForSession('session-in')).not.toBeNull()
    expect(await controller.resolveSandboxForSession('session-in-child')).not.toBeNull()
    await expect(controller.resolveSandboxForSession('session-out')).resolves.toBeNull()
    await controller.dispose()
  })

  test('removing the last opt-in with default off stops the sandbox', async () => {
    repo.setDesired(PROJECT, makeDesired({ sessions: { 'session-in': true } }))
    const controller = createController({ hostSessionsDefault: false, pollIntervalMs: 10 })
    await controller.start()
    expect(repo.getApplied(PROJECT)?.running).toBe(true)

    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-2', sessions: {} }))
    await vi.waitFor(() => expect(repo.getApplied(PROJECT)?.revision).toBe('rev-2'))

    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-2', running: false, error: null })
    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    await expect(controller.resolveSandboxForSession('session-in')).resolves.toBeNull()
    await controller.dispose()
  })

  test('a session in another directory or another project resolves to the host', async () => {
    const controller = createController({
      getSessionIdentity: async (sid) => {
        if (sid === 'session-other-dir') return { projectId: PROJECT, directory: '/abs/path/other-checkout' }
        if (sid === 'session-other-project') return { projectId: 'project-b', directory: DIRECTORY }
        return { projectId: PROJECT, directory: `${DIRECTORY}/nested` }
      },
    })
    await controller.start()

    await expect(controller.resolveSandboxForSession('session-other-dir')).resolves.toBeNull()
    await expect(controller.resolveSandboxForSession('session-other-project')).resolves.toBeNull()
    expect(await controller.resolveSandboxForSession('session-nested')).not.toBeNull()
    expect(manager.ensureRunningCalls).toHaveLength(2)
    await controller.dispose()
  })

  test('an identity lookup that fails or resolves nothing refuses the command instead of running it on the host', async () => {
    const controller = createController({
      getSessionIdentity: async (sid) => {
        if (sid === 'session-throws') throw new Error('connection refused')
        return null
      },
    })
    await controller.start()

    await expect(controller.resolveSandboxForSession('session-throws')).rejects.toThrow(/could not be resolved/)
    await expect(controller.resolveSandboxForSession('session-null')).rejects.toThrow(/could not be resolved/)
    await controller.dispose()
  })

  test('an identity lookup that never settles is bounded by the ownership timeout', async () => {
    vi.useFakeTimers()
    try {
      const controller = createController({
        pollIntervalMs: OWNERSHIP_LOOKUP_TIMEOUT_MS * 1000,
        getSessionIdentity: () => new Promise(() => {}),
      })
      await controller.start()

      const resolving = controller.resolveSandboxForSession('session-slow')
      const assertion = expect(resolving).rejects.toThrow(/could not be resolved/)
      await vi.advanceTimersByTimeAsync(OWNERSHIP_LOOKUP_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed start fails wanting sessions closed and a new desired revision retries', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-fail', sessions: { 'session-optout': false } }))
    manager.setEnsureRunningImpl(async () => {
      throw new Error('msb create failed')
    })
    const controller = createController({ pollIntervalMs: 10 })
    await controller.start()

    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-fail', running: false })
    expect(repo.getApplied(PROJECT)?.error).toMatch(/msb create failed/)
    await expect(controller.resolveSandboxForSession('session-in')).rejects.toThrow(
      /Host sandbox unavailable: msb create failed/,
    )
    await expect(controller.resolveSandboxForSession('session-optout')).resolves.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.ensureRunningCalls).toHaveLength(1)

    manager.setEnsureRunningImpl(async (key: string) => `forge-${key}`)
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-retry', sessions: { 'session-optout': false } }))
    await vi.waitFor(() => expect(repo.getApplied(PROJECT)?.revision).toBe('rev-retry'))

    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-retry', running: true, error: null })
    expect(await controller.resolveSandboxForSession('session-in')).not.toBeNull()
    await controller.dispose()
  })

  test('an unavailable lifecycle manager acknowledges the start as failed and stays failed at that revision', async () => {
    const controller = trackController(createSessionSandboxController({
      projectId: PROJECT,
      directory: DIRECTORY,
      preferences: repo,
      sandboxManager: createUnavailableSandboxLifecycleManager(createMockSandboxRuntime()),
      hostSessionsDefault: true,
      getParentSessionId: async () => null,
      getSessionIdentity: async () => ({ projectId: PROJECT, directory: DIRECTORY }),
      logger,
    }))
    await controller.start()

    const applied = repo.getApplied(PROJECT)
    expect(applied?.running).toBe(false)
    expect(applied?.error).toMatch(/unavailable/)
    await expect(controller.resolveSandboxForSession('session-x')).rejects.toThrow(/unavailable/)
    await controller.dispose()
  })

  test('dispose stops the sandbox and records applied off at the desired revision', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-dispose' }))
    const controller = createController()
    await controller.start()
    expect(repo.getApplied(PROJECT)?.running).toBe(true)

    await controller.dispose()
    await controller.dispose()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-dispose', running: false, error: null })

    const second = createController()
    await second.start()
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-dispose', running: true, error: null })
    await second.dispose()
  })

  test('dispose never persists a stop error and the next controller adopts the leftover sandbox', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-dispose-fail' }))
    const controller = createController()
    await controller.start()

    manager.stop = async () => {
      throw new Error('container removal failed')
    }
    await controller.dispose()

    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-dispose-fail', running: true, error: null })

    const second = createController()
    await second.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY, MANAGER_KEY])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-dispose-fail', running: true, error: null })
    expect(await second.resolveSandboxForSession('session-adopt')).not.toBeNull()
    await second.dispose()
  })

  test('a leftover sandbox acknowledged by a failed dispose is stopped by a controller that does not want it', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-leftover' }))
    repo.setApplied(PROJECT, makeApplied({ revision: 'rev-leftover', running: true, error: null }))
    manager.setActive({
      containerName: `forge-${MANAGER_KEY}`,
      projectDir: DIRECTORY,
      startedAt: new Date().toISOString(),
      mounts: [],
      instanceId: `instance-forge-${MANAGER_KEY}`,
    })
    const controller = createController({ hostSessionsDefault: false })
    await controller.start()

    expect(manager.stopCalls).toEqual([MANAGER_KEY])
    expect(manager.active).toBeNull()
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-leftover', running: false, error: null })
    await controller.dispose()
  })

  test('a new controller adopts applied running at the same revision through ensureRunning without stopping', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-adopt' }))
    repo.setApplied(PROJECT, makeApplied({ revision: 'rev-adopt' }))
    const controller = createController()
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-adopt', running: true, error: null })
    expect(await controller.resolveSandboxForSession('session-adopt')).not.toBeNull()
    await controller.dispose()
  })

  test('a failure persisted by a previous process is retried once on start and heals', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-persist-retry' }))
    repo.setApplied(PROJECT, makeApplied({ revision: 'rev-persist-retry', running: false, error: 'container died' }))
    const controller = createController()
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(manager.stopCalls).toEqual([])
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-persist-retry', running: true, error: null })
    expect(await controller.resolveSandboxForSession('session-a')).not.toBeNull()
    await controller.dispose()
  })

  test('a persisted failure that fails again on start stays failed until the desired revision changes', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-persist-fail' }))
    repo.setApplied(PROJECT, makeApplied({ revision: 'rev-persist-fail', running: false, error: 'container died' }))
    manager.setEnsureRunningImpl(async () => {
      throw new Error('still failing')
    })
    const controller = createController({ pollIntervalMs: 10 })
    await controller.start()

    expect(manager.ensureRunningCalls).toEqual([MANAGER_KEY])
    expect(repo.getApplied(PROJECT)?.revision).toBe('rev-persist-fail')
    expect(repo.getApplied(PROJECT)?.running).toBe(false)
    expect(repo.getApplied(PROJECT)?.error).toMatch(/still failing/)
    await expect(controller.resolveSandboxForSession('session-a')).rejects.toThrow(/still failing/)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.ensureRunningCalls).toHaveLength(1)

    manager.setEnsureRunningImpl(async (key: string) => `forge-${key}`)
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-persist-new-revision' }))
    await vi.waitFor(() => expect(repo.getApplied(PROJECT)?.revision).toBe('rev-persist-new-revision'))
    expect(repo.getApplied(PROJECT)).toMatchObject({ running: true, error: null })
    await controller.dispose()
  })

  test('a failed removal is retried with exponential backoff until the stop succeeds', async () => {
    vi.useFakeTimers()
    try {
      repo.setDesired(PROJECT, makeDesired({ revision: 'rev-on', sessions: { 'session-in': true } }))
      const controller = createController({ hostSessionsDefault: false, pollIntervalMs: 20 })
      await controller.start()
      expect(repo.getApplied(PROJECT)?.running).toBe(true)

      let stopFails = true
      manager.stop = async (key) => {
        manager.stopCalls.push(key)
        if (stopFails) throw new Error('transient removal failure')
        manager.active = null
      }
      repo.setDesired(PROJECT, makeDesired({ revision: 'rev-off', sessions: {} }))

      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(1)
      expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-off', running: true })
      expect(repo.getApplied(PROJECT)?.error).toMatch(/transient removal failure/)

      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(20)
      expect(manager.stopCalls).toHaveLength(3)

      stopFails = false
      await vi.advanceTimersByTimeAsync(80)
      expect(manager.stopCalls).toHaveLength(4)
      expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-off', running: false, error: null })

      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('polling is non-overlapping and fully stopped during disposal', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<string>()
      manager.setEnsureRunningImpl(() => gate.promise)
      const controller = createController({ pollIntervalMs: 20 })
      const starting = controller.start()
      const duplicate = controller.start()

      await vi.advanceTimersByTimeAsync(20)
      expect(manager.ensureRunningCalls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(200)
      expect(manager.ensureRunningCalls).toHaveLength(1)

      gate.resolve(`forge-${MANAGER_KEY}`)
      await starting
      await duplicate
      expect(repo.getApplied(PROJECT)?.running).toBe(true)

      await controller.dispose()
      const settledRevision = repo.getApplied(PROJECT)?.revision
      repo.setDesired(PROJECT, makeDesired({ revision: 'rev-after-dispose' }))
      await vi.advanceTimersByTimeAsync(500)
      expect(repo.getApplied(PROJECT)?.revision).toBe(settledRevision)
      expect(repo.getApplied(PROJECT)?.revision).not.toBe('rev-after-dispose')
    } finally {
      vi.useRealTimers()
    }
  })

  test('isIdle follows the wanted flag, liveness, and recorded failures', async () => {
    const off = createController({ hostSessionsDefault: false })
    await off.start()
    expect(off.isIdle()).toBe(true)
    await off.dispose()

    const on = createController()
    await on.start()
    expect(on.isIdle()).toBe(false)
    await on.dispose()
  })

  test('notifies onChange after applied and controller writes', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-notify' }))
    const onChange = vi.fn()
    const controller = createController({ onChange })
    await controller.start()

    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(repo.getApplied(PROJECT)?.running).toBe(true)

    const before = onChange.mock.calls.length
    await controller.dispose()
    expect(onChange.mock.calls.length).toBeGreaterThan(before)
  })

  test('an in-flight start cannot leave the sandbox on after disposal', async () => {
    const gate = deferred<string>()
    manager.setEnsureRunningImpl(() => gate.promise)
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-race' }))
    const controller = createController()

    const starting = controller.start()
    const disposing = controller.dispose()
    gate.resolve(`forge-${MANAGER_KEY}`)
    await starting
    await disposing

    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-race', running: false, error: null })
    expect(manager.stopCalls).toContain(MANAGER_KEY)
  })

  test('overrides changes converge in place without stopping the sandbox', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-1' }))
    const controller = createController({ pollIntervalMs: 10 })
    await controller.start()
    expect(manager.applyOverridesCalls).toHaveLength(1)

    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-2', overrides: { resources: { memory: '12g' } } }))
    await vi.waitFor(() => expect(repo.getApplied(PROJECT)?.revision).toBe('rev-2'))

    expect(manager.stopCalls).toEqual([])
    expect(manager.applyOverridesCalls).toHaveLength(2)
    expect(repo.getApplied(PROJECT)).toMatchObject({
      running: true,
      error: null,
      overrides: { resources: { memory: '12g' } },
    })
    await controller.dispose()
  })

  test('resolves the project root when called with the default poll interval', async () => {
    const controller = createController({ pollIntervalMs: DEFAULT_POLL_INTERVAL_MS })
    await controller.start()
    const context = await controller.resolveSandboxForSession('session-root')
    expect(context?.hostDir).toBe(DIRECTORY)
    expect(manager.ensureRunningCalls).toContain(MANAGER_KEY)
    await controller.dispose()
  })
})
