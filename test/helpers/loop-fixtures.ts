import { vi } from 'vitest'
import type { LoopState } from '../../src/loop/state'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'

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
