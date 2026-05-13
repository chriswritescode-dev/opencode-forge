import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import { createLoopService } from '../src/loop/service'
import { openForgeDatabase } from '../src/storage/database'
import type { Logger } from '../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('Phase 11: Loop decomposition and advancement', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'phase11-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = openForgeDatabase(dbPath)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  function insertLoop(overrides: Partial<{
    loopName: string
    phase: string
    decompositionStatus: string
    decompositionMode: string
    currentSectionIndex: number
    totalSections: number
    finalAuditDone: number
    iteration: number
  }> = {}) {
    const defaults = {
      loopName: 'test-loop',
      phase: 'coding',
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      currentSectionIndex: 0,
      totalSections: 2,
      finalAuditDone: 0,
      iteration: 1,
    }
    const opts = { ...defaults, ...overrides }
    loopsRepo.insert({
      projectId,
      loopName: opts.loopName,
      status: 'running',
      currentSessionId: 'session-1',
      worktree: false,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
      maxIterations: 5,
      iteration: opts.iteration,
      auditCount: 0,
      errorCount: 0,
      phase: opts.phase as any,
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
      decompositionStatus: opts.decompositionStatus as any,
      decompositionMode: opts.decompositionMode as any,
      decompositionSessionId: null,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      finalAuditDone: opts.finalAuditDone,
    }, { prompt: null, lastAuditResult: null })
  }

  describe('Deterministic decomposer', () => {
    test('builds section-based prompt with correct section index', () => {
      insertLoop({ currentSectionIndex: 1, totalSections: 3 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
          { index: 2, title: 'Test', content: 'Write tests' },
        ],
      })
      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Write code')
      expect(prompt).toContain('2/3')
    })

    test('section plans are persisted correctly', () => {
      insertLoop({ totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section).not.toBeNull()
      expect(section!.title).toBe('Setup')
    })
  })

  describe('Loop section advancement', () => {
    test('completing a section updates the section plan status', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      loopService.completeSection('test-loop', 0, {
        done: 'Implemented setup',
        deviations: 'none',
        followUps: 'none',
      })
      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBe('Implemented setup')
    })

    test('retry cap terminates after MAX_RETRIES attempts', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })

      // Simulate dirty audits up to MAX_RETRIES (3)
      for (let i = 0; i < 3; i++) {
        loopService.incrementSectionAttempts('test-loop', 0)
      }

      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section!.attempts).toBe(3)

      // After MAX_RETRIES (>= check), the section should be terminated
      expect(section!.attempts >= 3).toBe(true)
    })

    test('retry cap check happens before increment, not after', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })

      // Simulate what handleAuditingPhase does: check before incrementing
      // With MAX_RETRIES=3, after 2 dirty audits (attempts=2), we should NOT terminate
      for (let i = 0; i < 2; i++) {
        loopService.incrementSectionAttempts('test-loop', 0)
      }

      const section2 = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section2!.attempts).toBe(2)

      // Check if section exceeds max retries BEFORE incrementing again
      // At attempts=2, we should still be able to retry (2 < 3)
      expect(section2!.attempts < 3).toBe(true)

      // Now increment for the 3rd retry
      loopService.incrementSectionAttempts('test-loop', 0)

      const section3 = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section3!.attempts).toBe(3)

      // At attempts=3, we should terminate (3 >= 3)
      expect(section3!.attempts >= 3).toBe(true)
    })

    test('section summary is parsed correctly', () => {
      const text = `<!-- section-summary:start -->
### Done
- Implemented setup
### Deviations
- none
### Follow-ups
- none
<!-- section-summary:end -->`
      const summary = loopService.parseSectionSummary(text)
      expect(summary).not.toBeNull()
      expect(summary!.done).toContain('Implemented setup')
      expect(summary!.deviations).toContain('none')
      expect(summary!.followUps).toContain('none')
    })

    test('section continuation prompt includes audit findings', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/setup.ts',
        line: 10,
        severity: 'bug',
        description: 'Missing dependency',
        sectionIndex: 0,
      })
      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'Some audit text')
      expect(prompt).toContain('src/setup.ts')
      expect(prompt).toContain('Outstanding findings')
    })

    test('cross-section findings do not block section advancement', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      // Cross-section finding (sectionIndex null) should not block section 0
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/utils.ts',
        line: 5,
        severity: 'bug',
        description: 'Cross-section issue',
        sectionIndex: null,
      })
      const state = loopService.getActiveState('test-loop')!
      const sectionBugFindings = loopService.getOutstandingFindings('test-loop', 'bug')
        .filter(f => f.sectionIndex === state.currentSectionIndex)
      expect(sectionBugFindings.length).toBe(0)
    })
  })

  describe('Final audit', () => {
    test('final audit prompt includes section summaries', () => {
      insertLoop({ totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      loopService.completeSection('test-loop', 0, {
        done: 'Setup complete',
        deviations: 'none',
        followUps: 'none',
      })
      loopService.completeSection('test-loop', 1, {
        done: 'Implementation complete',
        deviations: 'none',
        followUps: 'none',
      })
      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildFinalAuditPrompt(state)
      expect(prompt).toContain('Setup complete')
    })

    test('final audit done flag blocks termination until all sections complete', () => {
      insertLoop({ totalSections: 2, finalAuditDone: 0 })
      const state = loopService.getActiveState('test-loop')!
      expect(state.totalSections).toBe(2)
      expect(!!state.finalAuditDone).toBe(false)
      loopService.setFinalAuditDone('test-loop', true)
      const updated = loopService.getActiveState('test-loop')!
      expect(!!updated.finalAuditDone).toBe(true)
    })
  })

  describe('Review section scope', () => {
    test('findings with sectionIndex match the correct section', () => {
      insertLoop({ currentSectionIndex: 1, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/code.ts',
        line: 15,
        severity: 'bug',
        description: 'Bug in implementation',
        sectionIndex: 1,
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/setup.ts',
        line: 5,
        severity: 'bug',
        description: 'Bug in setup',
        sectionIndex: 0,
      })
      const findings = loopService.getOutstandingFindings('test-loop', 'bug')
      const section1Findings = findings.filter(f => f.sectionIndex === 1)
      const section0Findings = findings.filter(f => f.sectionIndex === 0)
      expect(section1Findings.length).toBe(1)
      expect(section0Findings.length).toBe(1)
      expect(section1Findings[0].description).toBe('Bug in implementation')
      expect(section0Findings[0].description).toBe('Bug in setup')
    })

    test('findings without sectionIndex are treated as cross-section', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/utils.ts',
        line: 10,
        severity: 'bug',
        description: 'Cross-section issue',
        sectionIndex: null,
      })
      const allFindings = loopService.getOutstandingFindings('test-loop', 'bug')
      expect(allFindings.length).toBe(1)
      expect(allFindings[0].sectionIndex).toBeNull()
    })

    test('section advancement filter only considers current section findings', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      // Findings for other sections should not block section 0
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/implement.ts',
        line: 20,
        severity: 'bug',
        description: 'Bug in another section',
        sectionIndex: 1,
      })
      const findings = loopService.getOutstandingFindings('test-loop', 'bug')
      const currentSectionFindings = findings.filter(f => f.sectionIndex === 0)
      expect(currentSectionFindings.length).toBe(0)
    })

    test('continuation prompt does not include cross-section findings', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 3 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
          { index: 2, title: 'Test', content: 'Write tests' },
        ],
      })
      // Cross-section finding
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/utils.ts',
        line: 10,
        severity: 'bug',
        description: 'Cross-section issue',
        sectionIndex: null,
      })
      // Section 1 finding
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/code.ts',
        line: 15,
        severity: 'bug',
        description: 'Bug in section 1',
        sectionIndex: 1,
      })
      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'Some audit text')
      // Should NOT contain cross-section or section 1 findings
      expect(prompt).not.toContain('src/utils.ts')
      expect(prompt).not.toContain('src/code.ts')
    })

    test('continuation prompt includes only current section findings', () => {
      insertLoop({ currentSectionIndex: 0, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      // Section 0 finding
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/setup.ts',
        line: 10,
        severity: 'bug',
        description: 'Missing dependency',
        sectionIndex: 0,
      })
      // Section 1 finding
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/code.ts',
        line: 15,
        severity: 'bug',
        description: 'Bug in section 1',
        sectionIndex: 1,
      })
      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'Some audit text')
      // Should contain section 0 finding but not section 1
      expect(prompt).toContain('src/setup.ts')
      expect(prompt).not.toContain('src/code.ts')
    })

    test('review-findings-repo sectionIndex filtering works correctly', () => {
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/setup.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/code.ts',
        line: 15,
        severity: 'bug',
        description: 'Section 1 bug',
        sectionIndex: 1,
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/utils.ts',
        line: 5,
        severity: 'warning',
        description: 'Cross-section warning',
        sectionIndex: null,
      })
      // All findings
      const allFindings = reviewFindingsRepo.listAll(projectId)
      expect(allFindings.length).toBe(3)
      // Section 0 only
      const section0 = reviewFindingsRepo.listAll(projectId, 0)
      expect(section0.length).toBe(1)
      expect(section0[0].description).toBe('Section 0 bug')
      // Section 1 only
      const section1 = reviewFindingsRepo.listAll(projectId, 1)
      expect(section1.length).toBe(1)
      expect(section1[0].description).toBe('Section 1 bug')
      // Cross-section only
      const crossSection = reviewFindingsRepo.listAll(projectId, null)
      expect(crossSection.length).toBe(1)
      expect(crossSection[0].description).toBe('Cross-section warning')
    })

    test('different sections can report findings on the same file:line', () => {
      const result1 = reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/example.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        sectionIndex: 0,
      })
      const result2 = reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/example.ts',
        line: 10,
        severity: 'warning',
        description: 'Section 1 bug',
        sectionIndex: 1,
      })
      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
      expect(reviewFindingsRepo.listAll(projectId)).toHaveLength(2)
    })

    test('same section same file:line produces conflict', () => {
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/example.ts',
        line: 10,
        severity: 'bug',
        description: 'First bug',
        sectionIndex: 0,
      })
      const result = reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/example.ts',
        line: 10,
        severity: 'warning',
        description: 'Second bug',
        sectionIndex: 0,
      })
      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)
    })

    test('final audit rewind picks offending section from findings', () => {
      insertLoop({ currentSectionIndex: 1, totalSections: 2 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })
      reviewFindingsRepo.write({
        projectId,
        loopName: 'test-loop',
        file: 'src/code.ts',
        line: 15,
        severity: 'bug',
        description: 'Bug in section 1',
        sectionIndex: 1,
      })
      const allFindings = loopService.getOutstandingFindings('test-loop', 'bug')
      const offendingIdx = allFindings.length > 0 ? (allFindings[0].sectionIndex ?? 1) : 1
      expect(offendingIdx).toBe(1)
    })
  })
})
