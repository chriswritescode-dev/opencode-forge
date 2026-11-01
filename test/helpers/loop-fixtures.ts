import { Database } from 'bun:sqlite'
import { vi } from 'vitest'
import type { ForgeClient } from '../../src/client/port'
import { createLoop, type OnTerminatedCallback } from '../../src/loop/runtime'
import { createLoopService, type LoopChangeNotifier } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopsRepo, type LoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient, type RecordedCall } from './fake-client'
import { createCapturingLogger } from './logger'

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
    ...overrides,
  } as LoopsRepo
}

/**
 * Builds a loop runtime against an already migrated test database.
 *
 * Every call gets its own repositories, capturing logger and fake client, so a
 * test can drive the loop through the returned handles without hand-wiring
 * `createLoop`. Passing `client` keeps the caller's fake; its `calls` are not
 * mirrored here.
 */
export function buildLoopRuntime(
  db: Database,
  options: {
    projectId?: string
    client?: ForgeClient
    config?: Partial<PluginConfig>
    dataDir?: string
    directory?: string
    notify?: LoopChangeNotifier
    onTerminated?: OnTerminatedCallback
    withUsageRepo?: boolean
    getParentSessionId?: (sessionId: string) => Promise<string | null>
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
  const forge = options.client
    ? { client: options.client, calls: [] as RecordedCall[] }
    : createFakeForgeClient()
  const config = options.config ?? {}

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

  const loop = createLoop({
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopTransitionsRepo,
    projectId,
    client: forge.client,
    logger,
    getConfig: () => config,
    sandboxManager: undefined,
    dataDir: options.dataDir,
    directory: options.directory,
    notify: options.notify,
    onTerminated: options.onTerminated,
    loopSessionUsageRepo: options.withUsageRepo ? loopSessionUsageRepo : undefined,
    getParentSessionId: options.getParentSessionId,
  })

  return {
    loop,
    logger,
    logs,
    calls: forge.calls,
    loopService,
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopTransitionsRepo,
    loopSessionUsageRepo,
  }
}
