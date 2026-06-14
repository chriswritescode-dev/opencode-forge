import { describe, test, expect, vi } from 'vitest'
import { applyPlanDecomposition } from '../../src/services/section-bootstrap'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'

const PROJECT_ID = 'test-project'
const LOOP_NAME = 'test-loop'

function buildSpyLoopsRepo(): LoopsRepo {
  return {
    insert: vi.fn(),
    get: vi.fn(),
    getLarge: vi.fn(),
    getBySessionId: vi.fn(),
    listByStatus: vi.fn(),
    listAll: vi.fn(),
    updatePhase: vi.fn(),
    updateIteration: vi.fn(),
    incrementError: vi.fn(),
    resetError: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setWorkspaceId: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
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
    setFinalAuditDone: vi.fn(),
  }
}

function buildSpySectionPlansRepo(): SectionPlansRepo {
  return {
    bulkInsert: vi.fn(),
    list: vi.fn(),
    listCompleted: vi.fn(),
    get: vi.fn(),
    getNextIncomplete: vi.fn(),
    setStatus: vi.fn(),
    incrementAttempts: vi.fn(),
    setSummary: vi.fn(),
    resetForRewind: vi.fn(),
    setStartedAt: vi.fn(),
    setCompletedAt: vi.fn(),
    updateContent: vi.fn(),
    count: vi.fn(),
    deleteAll: vi.fn(),
    restoreAll: vi.fn(),
  }
}

describe('applyPlanDecomposition', () => {
  test('sectioned plan + repo present: bulk inserts, sets totals, marks first section in_progress', () => {
    const loopsRepo = buildSpyLoopsRepo()
    const sectionPlansRepo = buildSpySectionPlansRepo()

    const planText = [
      '<!-- forge-plan:start -->',
      '# Objective',
      '',
      'Do the thing.',
      '',
      '<!-- forge-section -->',
      '## Phase 1: Setup',
      '',
      'Install dependencies and configure the environment.',
      '',
      '<!-- forge-section -->',
      '## Phase 2: Build',
      '',
      'Compile and run the tests.',
      '',
      '## Verification',
      'Check that everything works.',
      '<!-- forge-plan:end -->',
    ].join('\n')

    const result = applyPlanDecomposition({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      planText,
      loopsRepo,
      sectionPlansRepo,
    })

    expect(result).toEqual({ totalSections: 2 })

    // bulkInsert called with sections matching the two phases
    expect(sectionPlansRepo.bulkInsert).toHaveBeenCalledTimes(1)
    const bulkInsertArgs = vi.mocked(sectionPlansRepo.bulkInsert).mock.calls[0][0]
    expect(bulkInsertArgs.projectId).toBe(PROJECT_ID)
    expect(bulkInsertArgs.loopName).toBe(LOOP_NAME)
    expect(bulkInsertArgs.sections).toHaveLength(2)
    expect(bulkInsertArgs.sections[0].index).toBe(0)
    expect(bulkInsertArgs.sections[0].title).toContain('Phase 1')
    expect(bulkInsertArgs.sections[1].index).toBe(1)
    expect(bulkInsertArgs.sections[1].title).toContain('Phase 2')

    // loopsRepo.setTotalSections called
    expect(loopsRepo.setTotalSections).toHaveBeenCalledTimes(1)
    expect(loopsRepo.setTotalSections).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 2)

    // loopsRepo.setCurrentSectionIndex called
    expect(loopsRepo.setCurrentSectionIndex).toHaveBeenCalledTimes(1)
    expect(loopsRepo.setCurrentSectionIndex).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 0)

    // First section set to in_progress
    expect(sectionPlansRepo.setStatus).toHaveBeenCalledTimes(1)
    expect(sectionPlansRepo.setStatus).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 0, 'in_progress')

    // First section startedAt set
    expect(sectionPlansRepo.setStartedAt).toHaveBeenCalledTimes(1)
    expect(sectionPlansRepo.setStartedAt).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 0, expect.any(Number))
  })

  test('no-marker plan: returns 0, does not persist sections', () => {
    const loopsRepo = buildSpyLoopsRepo()
    const sectionPlansRepo = buildSpySectionPlansRepo()

    const planText = '# Simple Plan\n\nJust a regular plan with no section markers.'

    const result = applyPlanDecomposition({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      planText,
      loopsRepo,
      sectionPlansRepo,
    })

    expect(result).toEqual({ totalSections: 0 })

    // loopsRepo.setTotalSections(projectId, loopName, 0)
    expect(loopsRepo.setTotalSections).toHaveBeenCalledTimes(1)
    expect(loopsRepo.setTotalSections).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 0)

    // No section persistence calls
    expect(sectionPlansRepo.bulkInsert).not.toHaveBeenCalled()
    expect(sectionPlansRepo.setStatus).not.toHaveBeenCalled()
    expect(sectionPlansRepo.setStartedAt).not.toHaveBeenCalled()
    expect(loopsRepo.setCurrentSectionIndex).not.toHaveBeenCalled()
  })

  test('sectionPlansRepo undefined + sectioned plan: returns 0, no persistence', () => {
    const loopsRepo = buildSpyLoopsRepo()

    const planText = [
      '<!-- forge-section -->',
      '## Phase 1: Something',
      '',
      'Body text.',
    ].join('\n')

    const result = applyPlanDecomposition({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      planText,
      loopsRepo,
      sectionPlansRepo: undefined,
    })

    expect(result).toEqual({ totalSections: 0 })

    // loopsRepo.setTotalSections(projectId, loopName, 0)
    expect(loopsRepo.setTotalSections).toHaveBeenCalledTimes(1)
    expect(loopsRepo.setTotalSections).toHaveBeenCalledWith(PROJECT_ID, LOOP_NAME, 0)

    // No section persistence calls (no sectionPlansRepo)
    expect(loopsRepo.setCurrentSectionIndex).not.toHaveBeenCalled()
  })
})
