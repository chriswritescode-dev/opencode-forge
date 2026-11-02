import type { ForgeDashboardLoopSummary, ForgeLoopTransition } from '../../src/host/forge-rpc'
import type { LoopRow } from '../../src/storage'

/** Builds a loop transition row for machine-diagram and timeline tests. */
export function makeTransition(overrides: Partial<ForgeLoopTransition> = {}): ForgeLoopTransition {
  return {
    id: 1,
    projectId: 'p1',
    loopName: 'loop-a',
    eventType: 'phase',
    transitionKind: 'phase',
    fromPhase: 'coding',
    toPhase: 'auditing',
    iteration: 1,
    createdAt: 0,
    ...overrides,
  }
}

/** Builds a dashboard loop summary for view-model and dashboard-store tests. */
export function makeLoopSummary(overrides: Partial<ForgeDashboardLoopSummary> = {}): ForgeDashboardLoopSummary {
  return {
    loopName: 'my-loop',
    status: 'running',
    phase: 'coding',
    iteration: 3,
    maxIterations: 10,
    currentSectionIndex: 1,
    totalSections: 5,
    sectionCount: 2,
    bugCount: 0,
    hasPlan: false,
    startedAt: 1700000000000,
    activityAt: 1700000000000,
    ...overrides,
  }
}

/** Builds a minimal running loop row for dashboard and TUI RPC service tests. */
export function makeLoopRow(overrides: Partial<LoopRow> = {}): LoopRow {
  return {
    projectId: 'test-project',
    loopName: 'test-loop',
    status: 'running',
    currentSessionId: 'session-1',
    worktree: false,
    worktreeDir: '/tmp/test',
    worktreeBranch: null,
    projectDir: '/tmp/test',
    maxIterations: 10,
    iteration: 0,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: 'claude-sonnet-4-20250514',
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: Date.now(),
    completedAt: null,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 0,
    totalSections: 1,
    executionVariant: null,
    auditorVariant: null,
    baseCommit: null,
    standbySessionId: null,
    ...overrides,
  }
}
