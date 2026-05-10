import { describe, it, expect } from 'vitest'
import {
  loopRowToState,
  loopStateToRow,
  type LoopState,
  type CodingState,
  type AuditingState,
  type DecomposingState,
  type FinalAuditingState,
} from '../../src/loop/state'
import type { LoopRow } from '../../src/storage/repos/loops-repo'

function makeRow(overrides: Partial<LoopRow> = {}): LoopRow {
  return {
    projectId: 'proj-1',
    loopName: 'test-loop',
    status: 'running',
    currentSessionId: 'sess-1',
    worktree: false,
    worktreeDir: '/tmp/wt',
    worktreeBranch: null,
    projectDir: '/tmp/project',
    maxIterations: 10,
    iteration: 1,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
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
    decompositionStatus: 'pending',
    decompositionMode: 'agent',
    decompositionSessionId: null,
    currentSectionIndex: 0,
    totalSections: 0,
    finalAuditDone: 0,
    ...overrides,
  }
}

describe('loopRowToState', () => {
  it('narrows coding phase to CodingState', () => {
    const row = makeRow({ phase: 'coding' })
    const state = loopRowToState(row)
    expect(state.phase).toBe('coding')
    // TypeScript narrowing check
    const coding = state as CodingState
    expect(coding.phase).toBe('coding')
  })

  it('narrows auditing phase to AuditingState', () => {
    const row = makeRow({ phase: 'auditing' })
    const state = loopRowToState(row)
    expect(state.phase).toBe('auditing')
    const auditing = state as AuditingState
    expect(auditing.phase).toBe('auditing')
  })

  it('narrows decomposing phase to DecomposingState', () => {
    const row = makeRow({ phase: 'decomposing', currentSectionIndex: 0 })
    const state = loopRowToState(row)
    expect(state.phase).toBe('decomposing')
    const decomposing = state as DecomposingState
    expect(decomposing.phase).toBe('decomposing')
  })

  it('narrows final_auditing phase to FinalAuditingState', () => {
    const row = makeRow({ phase: 'final_auditing' })
    const state = loopRowToState(row)
    expect(state.phase).toBe('final_auditing')
    const finalAudit = state as FinalAuditingState
    expect(finalAudit.phase).toBe('final_auditing')
  })

  it('converts boolean fields correctly', () => {
    const row = makeRow({ worktree: true, modelFailed: true, sandbox: true, finalAuditDone: 1 })
    const state = loopRowToState(row)
    expect(state.worktree).toBe(true)
    expect(state.modelFailed).toBe(true)
    expect(state.sandbox).toBe(true)
    expect(state.finalAuditDone).toBe(true)
  })

  it('converts null optional strings to undefined', () => {
    const row = makeRow({
      terminationReason: null,
      completionSummary: null,
      sandboxContainer: null,
      executionModel: null,
      auditorModel: null,
      workspaceId: null,
      hostSessionId: null,
      worktreeBranch: null,
    })
    const state = loopRowToState(row)
    expect(state.terminationReason).toBeUndefined()
    expect(state.completionSummary).toBeUndefined()
    expect(state.sandboxContainer).toBeUndefined()
    expect(state.executionModel).toBeUndefined()
    expect(state.auditorModel).toBeUndefined()
    expect(state.workspaceId).toBeUndefined()
    expect(state.hostSessionId).toBeUndefined()
    expect(state.worktreeBranch).toBeUndefined()
  })

  it('converts status to active flag', () => {
    const running = makeRow({ status: 'running' })
    expect(loopRowToState(running).active).toBe(true)

    const completed = makeRow({ status: 'completed' })
    expect(loopRowToState(completed).active).toBe(false)

    const errored = makeRow({ status: 'errored' })
    expect(loopRowToState(errored).active).toBe(false)
  })

  it('converts timestamp to ISO string', () => {
    const ts = new Date('2025-01-15T12:00:00.000Z').getTime()
    const row = makeRow({ startedAt: ts })
    const state = loopRowToState(row)
    expect(state.startedAt).toBe('2025-01-15T12:00:00.000Z')
  })

  it('converts completedAt timestamp to ISO string or undefined', () => {
    const ts = new Date('2025-01-16T08:30:00.000Z').getTime()
    const row = makeRow({ completedAt: ts })
    const state = loopRowToState(row)
    expect(state.completedAt).toBe('2025-01-16T08:30:00.000Z')

    const rowNull = makeRow({ completedAt: null })
    const stateNull = loopRowToState(rowNull)
    expect(stateNull.completedAt).toBeUndefined()
  })

  it('handles large field for prompt and lastAuditResult', () => {
    const row = makeRow()
    const large = { prompt: 'test prompt', lastAuditResult: 'all good' }
    const state = loopRowToState(row, large)
    expect(state.prompt).toBe('test prompt')
    expect(state.lastAuditResult).toBe('all good')
  })

  it('defaults large fields to undefined when not provided', () => {
    const row = makeRow()
    const state = loopRowToState(row)
    expect(state.prompt).toBeUndefined()
    expect(state.lastAuditResult).toBeUndefined()
  })

  it('returns all four phases without runtime errors', () => {
    for (const phase of ['coding', 'auditing', 'decomposing', 'final_auditing'] as const) {
      const row = makeRow({ phase })
      const state = loopRowToState(row)
      expect(state.phase).toBe(phase)
    }
  })
})

describe('loopStateToRow', () => {
  it('preserves phase value', () => {
    const state = loopRowToState(makeRow({ phase: 'decomposing' }))
    const row = loopStateToRow(state)
    expect(row.phase).toBe('decomposing')
  })

  it('maps active flag to status', () => {
    const active = loopRowToState(makeRow({ status: 'running' }))
    expect(loopStateToRow(active).status).toBe('running')

    const inactive = loopRowToState(makeRow({ status: 'completed' }))
    expect(loopStateToRow(inactive).status).toBe('completed')
  })

  it('converts ISO string back to epoch millis', () => {
    const ts = new Date('2025-01-15T12:00:00.000Z').getTime()
    const state = loopRowToState(makeRow({ startedAt: ts }))
    const row = loopStateToRow(state)
    expect(row.startedAt).toBe(ts)
  })

  it('converts boolean back to 1 or 0 for finalAuditDone', () => {
    const done = loopRowToState(makeRow({ finalAuditDone: 1 }))
    expect(loopStateToRow(done).finalAuditDone).toBe(1)

    const notDone = loopRowToState(makeRow({ finalAuditDone: 0 }))
    expect(loopStateToRow(notDone).finalAuditDone).toBe(0)
  })

  it('converts optional values back to null', () => {
    const state = loopRowToState(makeRow())
    const row = loopStateToRow(state)
    expect(row.terminationReason).toBeNull()
    expect(row.completionSummary).toBeNull()
    expect(row.sandboxContainer).toBeNull()
    expect(row.executionModel).toBeNull()
    expect(row.auditorModel).toBeNull()
    expect(row.workspaceId).toBeNull()
    expect(row.hostSessionId).toBeNull()
    expect(row.worktreeBranch).toBeNull()
  })

  it('round-trips loopName and other string fields', () => {
    const row = makeRow({
      loopName: 'my-loop',
      currentSessionId: 'sess-abc',
      worktreeDir: '/tmp/my-wt',
      projectDir: '/tmp/proj',
    })
    const state = loopRowToRow_backwardCompat(row)
    const result = loopStateToRow(state)
    expect(result.loopName).toBe('my-loop')
    expect(result.currentSessionId).toBe('sess-abc')
    expect(result.worktreeDir).toBe('/tmp/my-wt')
  })
})

describe('loopRowToState + loopStateToRow round-trip', () => {
  it('round-trips numeric fields via deconstruction', () => {
    const row = makeRow({
      iteration: 5,
      maxIterations: 10,
      auditCount: 3,
      errorCount: 2,
      currentSectionIndex: 2,
      totalSections: 7,
    })
    const state = loopRowToRow_backwardCompat(row)
    const result = loopStateToRow(state)
    expect(result.iteration).toBe(5)
    expect(result.maxIterations).toBe(10)
    expect(result.auditCount).toBe(3)
    expect(result.errorCount).toBe(2)
    expect(result.currentSectionIndex).toBe(2)
    expect(result.totalSections).toBe(7)
  })

  it('round-trips booleans and decomposition fields', () => {
    const row = makeRow({
      worktree: true,
      modelFailed: true,
      sandbox: true,
      decompositionStatus: 'completed',
      decompositionMode: 'agent',
    })
    const state = loopRowToRow_backwardCompat(row)
    const result = loopStateToRow(state)
    expect(result.worktree).toBe(true)
    expect(result.modelFailed).toBe(true)
    expect(result.sandbox).toBe(true)
    expect(result.decompositionStatus).toBe('completed')
    expect(result.decompositionMode).toBe('agent')
  })
})

describe('decomposing state specific assertions', () => {
  it('has phase: decomposing, currentSectionIndex: 0, no required lastAuditResult', () => {
    const row = makeRow({ phase: 'decomposing', currentSectionIndex: 0 })
    const state = loopRowToState(row)
    expect(state.phase).toBe('decomposing')
    expect((state as DecomposingState).currentSectionIndex).toBe(0)
    expect(state.lastAuditResult).toBeUndefined()
  })
})

// Helper to convert a row through our mapping (simulating what the existing code does)
function loopRowToRow_backwardCompat(row: LoopRow): LoopState {
  return loopRowToState(row)
}
