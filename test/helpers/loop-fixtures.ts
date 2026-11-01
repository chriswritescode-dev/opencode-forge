import { Database } from 'bun:sqlite'
import { vi } from 'vitest'
import type { ForgeClient } from '../../src/client/port'
import type { createLoopEventHandler } from '../../src/hooks'
import { createLoop, type Loop, type LoopRuntimeDeps, type OnTerminatedCallback } from '../../src/loop/runtime'
import { createLoopService, type LoopChangeNotifier } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import type { ForgeExecutionServiceDeps } from '../../src/services/execution'
import type { LoopAttemptsRepo } from '../../src/storage/repos/loop-attempts-repo'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopsRepo, type LoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopConfig, PluginConfig } from '../../src/types'
import { createPendingTeardownRegistry } from '../../src/workspace/pending-teardown'
import { createFakeForgeClient } from './fake-client'
import { createCapturingLogger, createMockLogger } from './logger'

/** Creates a LoopState with the standard test defaults; overrides replace any default. */
export function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    active: true,
    sessionId: 'loop-session-id',
    loopName: 'test-loop',
    worktreeDir: '/tmp/nonexistent-worktree-for-test',
    projectDir: '/tmp/host-project-dir',
    worktreeBranch: 'test/branch',
    iteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    prompt: 'Test prompt',
    phase: 'coding',
    errorCount: 0,
    auditCount: 0,
    status: 'running',
    worktree: true,
    modelFailed: false,
    sandbox: false,
    executionModel: 'test/model',
    auditorModel: 'test/auditor',
    executionVariant: undefined,
    auditorVariant: undefined,
    currentSectionIndex: 0,
    totalSections: 0,
    ...overrides,
  }
}

/** Creates a LoopsRepo whose methods are spies; `get` returns null unless overridden. */
export function createMockLoopsRepo(overrides?: Partial<LoopsRepo>): LoopsRepo {
  return {
    insert: vi.fn(),
    restore: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    getLarge: vi.fn(),
    getBySessionId: vi.fn(),
    listByStatus: vi.fn(),
    listAll: vi.fn(),
    listSidebarRows: vi.fn(),
    updatePhase: vi.fn(),
    updateIteration: vi.fn(),
    incrementError: vi.fn(),
    resetError: vi.fn(),
    advanceAuditorFallbackIndex: vi.fn(),
    resetAuditorFallbackIndex: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setStandbySessionId: vi.fn(),
    setWorkspaceId: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setModelFailed: vi.fn(),
    setModels: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setPostActionReport: vi.fn(),
    setSandboxContainer: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    setStatus: vi.fn(),
    replaceSession: vi.fn(),
    restart: vi.fn(),
    terminate: vi.fn(),
    delete: vi.fn(),
    findPartial: vi.fn(),
    setCurrentSectionIndex: vi.fn(),
    setTotalSections: vi.fn(),
    upsertPendingHandoff: vi.fn(),
    getPendingHandoff: vi.fn().mockReturnValue(null),
    applyPendingHandoff: vi.fn().mockReturnValue(null),
    discardPendingHandoff: vi.fn(),
    listHandoffs: vi.fn().mockReturnValue([]),
    ...overrides,
  }
}

/**
 * Builds a loop runtime against an already migrated test database.
 *
 * Every call gets its own repositories, capturing logger and fake client, so a
 * test can drive the loop through the returned handles without hand-wiring
 * `createLoop`. Passing `client` keeps the caller's fake, so assert on that
 * fake's own `calls`.
 */
export function buildLoopRuntime(
  db: Database,
  options: {
    projectId?: string
    client?: ForgeClient
    config?: Partial<PluginConfig>
    loopConfig?: LoopConfig
    dataDir?: string
    directory?: string
    notify?: LoopChangeNotifier
    onTerminated?: OnTerminatedCallback
    withUsageRepo?: boolean
    getParentSessionId?: (sessionId: string) => Promise<string | null>
    sandboxManager?: LoopRuntimeDeps['sandboxManager']
    loopAttemptsRepo?: LoopAttemptsRepo
  } = {},
) {
  const projectId = options.projectId ?? 'test-project'
  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopTransitionsRepo = createLoopTransitionsRepo(db)
  const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
  const { logger, logs } = createCapturingLogger()
  const client = options.client ?? createFakeForgeClient().client
  const config = options.config ?? {}

  const loop = createLoop({
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopTransitionsRepo,
    projectId,
    client,
    logger,
    getConfig: () => config,
    sandboxManager: options.sandboxManager,
    loopAttemptsRepo: options.loopAttemptsRepo,
    loopConfig: options.loopConfig,
    dataDir: options.dataDir,
    directory: options.directory,
    notify: options.notify,
    onTerminated: options.onTerminated,
    loopSessionUsageRepo: options.withUsageRepo ? loopSessionUsageRepo : undefined,
    getParentSessionId: options.getParentSessionId,
  })

  return {
    loop,
    logs,
    loopService: loop.service,
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopTransitionsRepo,
    loopSessionUsageRepo,
  }
}

/** Overrides accepted by {@link buildExecutionDeps}; `loop` and `loopHandler` merge into the stubs. */
type ExecutionDepsOverrides = Omit<
  Partial<ForgeExecutionServiceDeps>,
  'loop' | 'loopHandler'
> & {
  loop?: Partial<Loop>
  loopHandler?: Partial<ReturnType<typeof createLoopEventHandler>>
}

/**
 * Builds `ForgeExecutionServiceDeps` against an already migrated test database.
 *
 * Defaults mirror the historical inline wiring in the execution service tests:
 * repos on `db`, a loop stub delegating state lookups to the service, a
 * passthrough `runExclusive`, a null sandbox manager and a real
 * pending-teardown registry. `loop` and `loopHandler` overrides merge into the
 * stubs, so a test passes only the members whose behaviour it changes.
 */
export function buildExecutionDeps(
  db: Database,
  overrides: ExecutionDepsOverrides = {},
) {
  const { loop: loopOverrides, loopHandler: loopHandlerOverrides, ...depsOverrides } = overrides
  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopTransitionsRepo = createLoopTransitionsRepo(db)
  const logger = depsOverrides.logger ?? createMockLogger()
  const projectId = depsOverrides.projectId ?? 'test-project'
  const loopService = createLoopService(
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    projectId,
    logger,
    undefined,
    undefined,
    sectionPlansRepo,
    loopTransitionsRepo,
  )
  const delegatingService = loopOverrides?.service ?? loopService
  const loop = {
    service: loopService,
    listActive: () => delegatingService.listActive(),
    listRecent: () => delegatingService.listRecent(),
    findMatchByName: (name: string) => delegatingService.findMatchByName(name),
    setPhase: (name: string, phase: LoopState['phase']) => delegatingService.setPhase(name, phase),
    registerSessionReverseIndex: () => {},
    unregisterSessionReverseIndex: () => {},
    handleAuditorProviderLimit: async () => false,
    snapshotSectionCodeGraph: async () => {},
    ...loopOverrides,
  } as unknown as Loop
  const loopHandler = {
    runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
    startWatchdog: vi.fn(),
    clearLoopTimers: async () => {},
    ...loopHandlerOverrides,
  } as unknown as ReturnType<typeof createLoopEventHandler>
  const deps: ForgeExecutionServiceDeps = {
    projectId,
    directory: '/tmp/test',
    config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
    logger,
    dataDir: '/tmp',
    client: createFakeForgeClient().client,
    plansRepo,
    loopsRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loop,
    loopHandler,
    sandboxManager: null,
    pendingTeardowns: createPendingTeardownRegistry(),
    ...depsOverrides,
  }

  return { deps, loopService, loopsRepo, plansRepo, reviewFindingsRepo, sectionPlansRepo }
}
