import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import { createLoopService } from '../src/loop/service'
import type { Logger } from '../src/types'
import { createTestDb } from './helpers/test-db'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('LoopService section management', () => {
  let db: Database
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'section-management-test-'))
    testDb = createTestDb()
    db = testDb.db

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    testDb.cleanup()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string) {
    loopsRepo.insert({
      projectId,
      loopName,
      status: 'running',
      currentSessionId: `${loopName}-session`,
      worktree: false,
      worktreeDir: tempDir,
      worktreeBranch: null,
      projectDir: tempDir,
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
      currentSectionIndex: 0,
      totalSections: 2,
      executionVariant: null,
      auditorVariant: null,
      baseCommit: null,
      standbySessionId: null,
    }, { lastAuditResult: null })
  }

  function insertSections(loopName: string, count: number) {
    const sections = Array.from({ length: count }, (_, i) => ({
      index: i,
      title: `Section ${i + 1}`,
      content: `Content for section ${i + 1}`,
    }))
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
    loopsRepo.setTotalSections(projectId, loopName, count)
  }

  describe('completeSection', () => {
    test('marks section as completed with summary', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)

      loopService.completeSection('test-loop', 1, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Handled in section 2',
      })

      const section = sectionPlansRepo.get(projectId, 'test-loop', 1)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBe('Implemented feature X')
      expect(section!.summaryDeviations).toBe('None')
      expect(section!.summaryFollowUps).toBe('Handled in section 2')
      expect(section!.completedAt).not.toBeNull()
    })

    test('stores null summary fields and still records completion time', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)

      loopService.completeSection('test-loop', 0, {
        done: null,
        deviations: null,
        followUps: null,
      })

      const section = sectionPlansRepo.get(projectId, 'test-loop', 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBeNull()
      expect(section!.summaryDeviations).toBeNull()
      expect(section!.summaryFollowUps).toBeNull()
      expect(section!.completedAt).not.toBeNull()
    })

    test('completing a non-existent section leaves existing sections unchanged', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      loopService.completeSection('test-loop', 5, {
        done: 'phantom done',
        deviations: null,
        followUps: null,
      })

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)!.status).toBe('pending')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)!.status).toBe('pending')
    })
  })

  describe('incrementSectionAttempts', () => {
    test('increments attempt counter', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(0)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(1)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(2)
    })

    test('does not change the current section index', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      loopsRepo.setCurrentSectionIndex(projectId, 'test-loop', 1)

      loopService.incrementSectionAttempts('test-loop', 1)

      const state = loopService.getActiveState('test-loop')!
      expect(state.currentSectionIndex).toBe(1)
      expect(state.totalSections).toBe(3)
    })

    test('incrementing a non-existent section does not touch existing sections', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)

      loopService.incrementSectionAttempts('test-loop', 5)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)!.attempts).toBe(0)
    })
  })

  describe('resetSectionForRewind', () => {
    test('resets section to in_progress with cleared summaries', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, { done: 'old done', deviations: 'old dev', followUps: 'old follow' })
      sectionPlansRepo.setCompletedAt(projectId, 'test-loop', 0, Date.now())

      loopService.resetSectionForRewind('test-loop', 0)

      const section = sectionPlansRepo.get(projectId, 'test-loop', 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('in_progress')
      expect(section!.attempts).toBe(0)
      expect(section!.summaryDone).toBeNull()
      expect(section!.summaryDeviations).toBeNull()
      expect(section!.summaryFollowUps).toBeNull()
      expect(section!.completedAt).toBeNull()
    })

    test('resetting a non-existent section leaves existing sections unchanged', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)

      loopService.resetSectionForRewind('test-loop', 5)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)!.status).toBe('pending')
    })
  })

  describe('setCurrentSectionIndex', () => {
    test('updates current section index within bounds', () => {
      insertLoop('test-loop-with-3')
      loopsRepo.setTotalSections(projectId, 'test-loop-with-3', 3)

      loopService.setCurrentSectionIndex('test-loop-with-3', 2)

      const state = loopService.getActiveState('test-loop-with-3')
      expect(state).not.toBeNull()
      expect(state!.currentSectionIndex).toBe(2)
    })
  })

  describe('startSection', () => {
    test('advancing through sections updates the index and marks each section in_progress', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 5)

      for (let i = 0; i < 5; i++) {
        loopService.setCurrentSectionIndex('test-loop', i)
        loopService.startSection('test-loop', i)
      }

      const state = loopService.getActiveState('test-loop')!
      expect(state.currentSectionIndex).toBe(4)

      for (let i = 0; i < 5; i++) {
        const plan = sectionPlansRepo.get(projectId, 'test-loop', i)!
        expect(plan.status).toBe('in_progress')
        expect(plan.startedAt).not.toBeNull()
      }
    })
  })

  describe('isLastOpenSection', () => {
    test('is true when every other section is completed', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      loopsRepo.setCurrentSectionIndex(projectId, 'test-loop', 1)

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.isLastOpenSection(state)).toBe(true)
    })

    test('is false while another section is still open', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'in_progress')

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.isLastOpenSection(state)).toBe(false)
    })

    test('is true for an earlier index after a rewind', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'in_progress')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 2, 'completed')
      loopsRepo.setCurrentSectionIndex(projectId, 'test-loop', 0)

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.isLastOpenSection(state)).toBe(true)
    })

    test('is false for a non-sectioned loop', () => {
      insertLoop('no-sections')
      loopsRepo.setTotalSections(projectId, 'no-sections', 0)

      const state = loopService.getActiveState('no-sections')!
      expect(loopService.isLastOpenSection(state)).toBe(false)
    })
  })

  describe('buildAuditPrompt routing', () => {
    test('uses section audit prompt for sectioned loops', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildAuditPrompt(state)

      expect(prompt).toContain('Loop section audit 1/3')
    })

    test('uses legacy audit prompt for non-sectioned loops', () => {
      // Insert a loop with no sections
      loopsRepo.insert({
        projectId,
        loopName: 'no-sections',
        status: 'running',
        currentSessionId: 'no-sections-session',
        worktree: false,
        worktreeDir: tempDir,
        worktreeBranch: null,
        projectDir: tempDir,
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
        currentSectionIndex: 0,
        totalSections: 0,
        executionVariant: null,
        auditorVariant: null,
        baseCommit: null,
        standbySessionId: null,
      }, { lastAuditResult: null })

      const state = loopService.getActiveState('no-sections')!
      const prompt = loopService.buildAuditPrompt(state)

      expect(prompt).toContain('Post-iteration')
      expect(prompt).not.toContain('Loop section audit')
    })
  })

  describe('buildSectionAuditPrompt section scope', () => {
    test('includes the section-wide blocking rule and prior section summaries', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, { done: 'Feature A implemented' })
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      sectionPlansRepo.setCompletedAt(projectId, 'test-loop', 0, Date.now())
      loopsRepo.setCurrentSectionIndex(projectId, 'test-loop', 1)

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionAuditPrompt(state)

      expect(prompt).toContain('Loop section audit 2/2')
      expect(prompt).toContain('Section 1: Section 1')
      expect(prompt).toContain('Feature A implemented')
      expect(prompt).toContain('This section is clean only when this section, every earlier section, and the cross-section findings are free of outstanding bugs')
      expect(prompt).not.toContain('Last open section:')
    })
  })

  describe('last audit result', () => {
    test('persists audit text in large fields', () => {
      insertLoop('test-loop')

      loopService.setLastAuditResult('test-loop', 'Section looks good')

      expect(loopService.getActiveState('test-loop')!.lastAuditResult).toBe('Section looks good')
    })

    test('ignores empty string', () => {
      insertLoop('test-loop')

      loopService.setLastAuditResult('test-loop', '')

      expect(loopService.getActiveState('test-loop')!.lastAuditResult).toBeUndefined()
    })

    test('clearLastAuditResult removes stored audit text', () => {
      insertLoop('test-loop')
      loopService.setLastAuditResult('test-loop', 'Some text')

      loopService.clearLastAuditResult('test-loop')

      expect(loopService.getActiveState('test-loop')!.lastAuditResult).toBeUndefined()
    })
  })

  describe('getCompletedSectionDigest', () => {
    test('returns completed sections with their summaries', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, {
        done: 'Feature A implemented',
        deviations: 'None',
        followUps: 'Deferred item',
      })
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 1, {
        done: 'Feature B implemented',
        deviations: 'Minor deviation',
      })

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest).toEqual([
        {
          index: 0,
          title: 'Section 1',
          summaryDone: 'Feature A implemented',
          summaryDeviations: 'None',
          summaryFollowUps: 'Deferred item',
        },
        {
          index: 1,
          title: 'Section 2',
          summaryDone: 'Feature B implemented',
          summaryDeviations: 'Minor deviation',
          summaryFollowUps: null,
        },
      ])
      expect(digest.length).toBeLessThan(state.totalSections)
    })

    test('returns an empty digest when no sections are completed', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.getCompletedSectionDigest(state)).toHaveLength(0)
    })

    test('includes every completed section once all sections are complete', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)

      for (let i = 0; i < 3; i++) {
        loopService.completeSection('test-loop', i, { done: `Done ${i}`, deviations: null, followUps: null })
      }

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest).toHaveLength(state.totalSections)
      expect(digest).toHaveLength(3)
    })
  })

  describe('getNextIncompleteSectionPlan', () => {
    test('returns lowest-index non-completed section', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(1)
    })

    test('returns failed before later pending', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'failed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(0)
      expect(result!.status).toBe('failed')
    })

    test('returns null when all sections are completed', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).toBeNull()
    })

    test('does not update state.currentSectionIndex', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')

      const stateBefore = loopService.getActiveState('test-loop')!
      expect(stateBefore.currentSectionIndex).toBe(0)

      loopService.getNextIncompleteSectionPlan(stateBefore)

      const stateAfter = loopService.getActiveState('test-loop')!
      expect(stateAfter.currentSectionIndex).toBe(0)
    })

    test('does not mutate section statuses or timestamps', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      const beforeStatuses = [
        sectionPlansRepo.get(projectId, 'test-loop', 0)?.status,
        sectionPlansRepo.get(projectId, 'test-loop', 1)?.status,
      ]

      const state = loopService.getActiveState('test-loop')!
      loopService.getNextIncompleteSectionPlan(state)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.status).toBe(beforeStatuses[0])
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)?.status).toBe(beforeStatuses[1])
    })
  })
})

describe('section-read tool contract', () => {
  test('returns structured JSON output', async () => {
    const testDb = createTestDb()
    const db = testDb.db

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'proj', mockLogger, undefined, undefined, sectionPlansRepo)

    // Insert a test loop with sections
    loopsRepo.insert({
      projectId: 'proj',
      loopName: 'my-loop',
      status: 'running',
      currentSessionId: 'sess-1',
      worktree: false,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
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
      currentSectionIndex: 0,
      totalSections: 2,
      executionVariant: null,
      auditorVariant: null,
      baseCommit: null,
      standbySessionId: null,
    }, { lastAuditResult: null })

    sectionPlansRepo.bulkInsert({
      projectId: 'proj',
      loopName: 'my-loop',
      sections: [
        { index: 0, title: 'Setup', content: 'Install deps' },
        { index: 1, title: 'Implement', content: 'Write code' },
      ],
    })

    // Verify JSON structure (basic structural check)
    const state = loopService.getActiveState('my-loop')!
    const section = loopService.getSectionPlan(state, 0)
    expect(section).not.toBeNull()
    expect(section!.title).toBe('Setup')
    expect(section!.status).toBe('pending')

    testDb.cleanup()
  })
})
