import type { LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'

interface LoopStateBase {
  active: boolean
  sessionId: string
  loopName: string
  worktreeDir: string
  projectDir?: string
  worktreeBranch?: string
  iteration: number
  maxIterations: number
  startedAt: string
  prompt?: string
  lastAuditResult?: string
  errorCount: number
  auditCount: number
  status: LoopRow['status']
  terminationReason?: string
  completedAt?: string
  worktree?: boolean
  modelFailed?: boolean
  sandbox?: boolean
  sandboxContainer?: string
  completionSummary?: string
  executionModel?: string
  auditorModel?: string
  workspaceId?: string
  hostSessionId?: string
  currentSectionIndex: number
  totalSections: number
  finalAuditDone: boolean
  executionVariant?: string
  auditorVariant?: string
}

export interface CodingState extends LoopStateBase {
  phase: 'coding'
}

export interface AuditingState extends LoopStateBase {
  phase: 'auditing'
}

export interface FinalAuditingState extends LoopStateBase {
  phase: 'final_auditing'
}

export type LoopState = CodingState | AuditingState | FinalAuditingState

export type Phase = LoopState['phase']

export function loopRowToState(row: LoopRow, large?: LoopLargeFields | null): LoopState {
  const base = {
    active: row.status === 'running',
    sessionId: row.currentSessionId,
    loopName: row.loopName,
    worktreeDir: row.worktreeDir,
    projectDir: row.projectDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    startedAt: new Date(row.startedAt).toISOString(),
    lastAuditResult: large?.lastAuditResult ?? undefined,
    errorCount: row.errorCount,
    auditCount: row.auditCount,
    status: row.status,
    terminationReason: row.terminationReason ?? undefined,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    worktree: row.worktree,
    modelFailed: row.modelFailed,
    sandbox: row.sandbox,
    sandboxContainer: row.sandboxContainer ?? undefined,
    completionSummary: row.completionSummary ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
    currentSectionIndex: row.currentSectionIndex,
    totalSections: row.totalSections,
    finalAuditDone: row.finalAuditDone === 1,
    executionVariant: row.executionVariant ?? undefined,
    auditorVariant: row.auditorVariant ?? undefined,
  }

  switch (row.phase) {
    case 'coding':
      return { ...base, phase: 'coding' } satisfies CodingState
    case 'auditing':
      return { ...base, phase: 'auditing' } satisfies AuditingState
    case 'final_auditing':
      return { ...base, phase: 'final_auditing' } satisfies FinalAuditingState
  }
}

export function loopStateToRow(state: LoopState, projectId: string): Omit<LoopRow, 'createdAt' | 'updatedAt'> {
  return {
    projectId,
    loopName: state.loopName,
    status: state.status,
    currentSessionId: state.sessionId,
    worktree: state.worktree ?? false,
    worktreeDir: state.worktreeDir,
    worktreeBranch: state.worktreeBranch ?? null,
    projectDir: state.projectDir ?? state.worktreeDir,
    maxIterations: state.maxIterations,
    iteration: state.iteration,
    auditCount: state.auditCount,
    errorCount: state.errorCount,
    phase: state.phase,
    executionModel: state.executionModel ?? null,
    auditorModel: state.auditorModel ?? null,
    modelFailed: state.modelFailed ?? false,
    sandbox: state.sandbox ?? false,
    sandboxContainer: state.sandboxContainer ?? null,
    startedAt: new Date(state.startedAt).getTime(),
    completedAt: state.completedAt ? new Date(state.completedAt).getTime() : null,
    terminationReason: state.terminationReason ?? null,
    completionSummary: state.completionSummary ?? null,
    workspaceId: state.workspaceId ?? null,
    hostSessionId: state.hostSessionId ?? null,
    currentSectionIndex: state.currentSectionIndex,
    totalSections: state.totalSections,
    finalAuditDone: state.finalAuditDone ? 1 : 0,
    executionVariant: state.executionVariant ?? null,
    auditorVariant: state.auditorVariant ?? null,
  }
}
