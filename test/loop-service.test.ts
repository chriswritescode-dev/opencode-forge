import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/loop/service'
import type { LoopState } from '../src/loop/state'
import { createLoop } from '../src/loop/runtime'
import type { Logger } from '../src/types'
import { setupLoopsTestDb } from './helpers/loops-test-db'

describe('Loop', () => {
  let db: Database
  let loop: ReturnType<typeof createLoop>
  let tempDir: string
  const projectId = 'test-project'

  const mockLogger: Logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-service-test-'))
    const dbPath = join(tempDir, 'loop-service-test.db')
    db = new Database(dbPath)

    setupLoopsTestDb(db)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      logger: mockLogger,
      client: {} as any,
      v2Client: {} as any,
      getConfig: () => ({} as any),
    })
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('hasOutstandingFindings', () => {
    test('returns true when only warning findings exist (no severity filter)', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b1',
      })

      expect(loop.hasOutstandingFindings('b1')).toBe(true)
    })

    test('returns false when only warning findings exist and severity=bug filter is applied', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b1',
      })

      expect(loop.hasOutstandingFindings('b1', 'bug')).toBe(false)
      expect(loop.hasOutstandingFindings('b1', 'warning')).toBe(true)
    })

    test('returns true when bug findings exist with severity=bug filter', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b2',
      })

      expect(loop.hasOutstandingFindings('b2', 'bug')).toBe(true)
      const bugFindings = loop.getOutstandingFindings('b2', 'bug')
      expect(bugFindings.length).toBe(1)
      expect(bugFindings[0].severity).toBe('bug')
    })
  })

  describe('getOutstandingFindings', () => {
    test('returns all findings when no severity filter is provided', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b2',
      })

      const allFindings = loop.getOutstandingFindings('b2')
      expect(allFindings.length).toBe(2)

      const warningFindings = loop.getOutstandingFindings('b2', 'warning')
      expect(warningFindings.length).toBe(1)
      expect(warningFindings[0].severity).toBe('warning')
    })
  })

  describe('buildAuditPrompt', () => {
    test('contains plan completeness check instructions', () => {
      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loop.buildAuditPrompt(state as any)

      expect(prompt).toContain('Plan completeness check:')
      expect(prompt).toContain('severity: "bug"')
      expect(prompt).toContain('For every plan phase, verify it is fully implemented')
      expect(prompt).toContain('Outstanding `bug` findings block loop termination')
    })
  })

  describe('getMinAudits removal', () => {
    test('getMinAudits is not exposed on the service', () => {
      expect((loop as any).getMinAudits).toBeUndefined()
    })
  })

  describe('buildContinuationPrompt regression', () => {
    test('includes outstanding findings in continuation prompt', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'test-loop',
      })

      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        prompt: 'Initial prompt',
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loop.buildContinuationPrompt(state as any)

      expect(prompt).toContain('Outstanding Review Findings')
      expect(prompt).toContain('test.ts:1')
    })

    test('does not echo the original plan/prompt back into continuation', () => {
      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'no-findings-branch',
        iteration: 2,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        prompt: 'ORIGINAL_PLAN_BODY_SHOULD_NOT_APPEAR',
        phase: 'coding' as const,
        errorCount: 0,
        auditCount: 1,
      }

      const prompt = loop.buildContinuationPrompt(state as any, 'audit findings text')

      expect(prompt).not.toContain('ORIGINAL_PLAN_BODY_SHOULD_NOT_APPEAR')
      expect(prompt).toContain('audit findings text')
      expect(prompt).toContain('Loop iteration 2')
    })
  })

  describe('bumpFindingRecurrence', () => {
    test('increments finding recurrence count across consecutive calls', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId, file: 'src/bug.ts', line: 10, severity: 'bug', description: 'Bug', scenario: 'test', loopName: 'test-loop',
      })

      const findings = loop.getOutstandingFindings('test-loop', 'bug')
      expect(findings.length).toBe(1)

      // First bump → count=1
      loop.bumpFindingRecurrence('test-loop', findings)
      const prompt1 = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 1, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count 1 is below threshold, so no escalation
      expect(prompt1).not.toContain('Recurring blocking findings')
      expect(prompt1).not.toContain('Recurring findings — re-evaluate')

      // Second bump → count=2
      loop.bumpFindingRecurrence('test-loop', findings)
      const prompt2 = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 2, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count 2 is still below threshold
      expect(prompt2).not.toContain('Recurring blocking findings')

      // Third bump → count=3 (threshold reached)
      loop.bumpFindingRecurrence('test-loop', findings)
      const prompt3 = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      expect(prompt3).toContain('Recurring blocking findings')
      expect(prompt3).toContain('src/bug.ts:10')
      expect(prompt3).toContain('recurred 3×')

      // Also surfaces in audit prompt
      const auditPrompt = loop.buildAuditPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      expect(auditPrompt).toContain('Recurring findings — re-evaluate')
      expect(auditPrompt).toContain('src/bug.ts:10')
    })

    test('resets recurrence count when finding disappears', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)

      // Add a finding
      reviewFindingsRepo.write({
        projectId, file: 'src/bug.ts', line: 10, severity: 'bug', description: 'Bug', scenario: 'test', loopName: 'test-loop-2',
      })

      const findings1 = loop.getOutstandingFindings('test-loop-2', 'bug')
      loop.bumpFindingRecurrence('test-loop-2', findings1) // count=1
      loop.bumpFindingRecurrence('test-loop-2', findings1) // count=2

      // Now resolve the finding (remove it)
      reviewFindingsRepo.delete(projectId, 'src/bug.ts', 10, { loopName: 'test-loop-2' })

      const findings2 = loop.getOutstandingFindings('test-loop-2', 'bug')
      expect(findings2.length).toBe(0)

      // Bump with empty list — should reset
      loop.bumpFindingRecurrence('test-loop-2', findings2)

      // Re-add the same finding
      reviewFindingsRepo.write({
        projectId, file: 'src/bug.ts', line: 10, severity: 'bug', description: 'Bug', scenario: 'test', loopName: 'test-loop-2',
      })

      const findings3 = loop.getOutstandingFindings('test-loop-2', 'bug')
      loop.bumpFindingRecurrence('test-loop-2', findings3) // should start at 1 again

      const prompt = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop-2', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 4, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count=1, below threshold — no escalation
      expect(prompt).not.toContain('Recurring blocking findings')
    })

    test('escalates recurrence in final-audit fix and final-audit prompts after threshold', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)

      reviewFindingsRepo.write({
        projectId, file: 'src/final-bug.ts', line: 42, severity: 'bug', description: 'Final audit bug', scenario: 'test', loopName: 'test-loop-final',
      })

      const findings = loop.getOutstandingFindings('test-loop-final', 'bug')
      expect(findings.length).toBe(1)

      const finalAuditState = {
        active: true, sessionId: 's1', loopName: 'test-loop-final', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'final_auditing', errorCount: 0, auditCount: 2,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any

      // Bump once — below threshold, no escalation
      loop.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt1 = loop.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt1).not.toContain('Recurring blocking findings')

      // Bump twice — still below threshold
      loop.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt2 = loop.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt2).not.toContain('Recurring blocking findings')

      // Bump third time — threshold reached, escalation appears
      loop.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt3 = loop.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt3).toContain('Recurring blocking findings')
      expect(fixPrompt3).toContain('src/final-bug.ts:42')
      expect(fixPrompt3).toContain('recurred 3×')

      // Also surfaces in the final-audit prompt
      const auditPrompt = loop.buildFinalAuditPrompt(finalAuditState)
      expect(auditPrompt).toContain('Recurring findings — re-evaluate')
      expect(auditPrompt).toContain('src/final-bug.ts:42')
    })
  })

  describe('resetSectionRecurrence', () => {
    test('resets recurrence for the specified section; other sections unaffected', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)

      // Add findings for both sections so they can coexist in the recurrence map
      reviewFindingsRepo.write({
        projectId, file: 'src/section0.ts', line: 1, severity: 'bug', description: 'Bug section 0', scenario: 'test', loopName: 'reset-test', sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId, file: 'src/section1.ts', line: 2, severity: 'bug', description: 'Bug section 1', scenario: 'test', loopName: 'reset-test', sectionIndex: 1,
      })

      const allBugs = loop.getOutstandingFindings('reset-test', 'bug')

      // Bump all bugs together → both keys coexist in the map at count=2
      loop.bumpFindingRecurrence('reset-test', allBugs) // s0:1, s1:1
      loop.bumpFindingRecurrence('reset-test', allBugs) // s0:2, s1:2

      // Reset section 0 — should only remove s0 keys, leaving s1:2
      loop.resetSectionRecurrence('reset-test', 0)

      // Bump ALL bugs again: s0 starts fresh (0+1=1), s1 continues (2+1=3)
      loop.bumpFindingRecurrence('reset-test', allBugs)

      // Check escalation via audit prompt: only s1 (count=3) should surface
      const prompt = loop.buildAuditPrompt({
        active: true, sessionId: 's1', loopName: 'reset-test', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'auditing', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      expect(prompt).toContain('Recurring findings — re-evaluate')
      expect(prompt).toContain('src/section1.ts:2')
      // s0 count=1 should not be escalated (it still appears in "Existing findings" listing
      // but NOT in the "recurred N×" format used by the escalation block)
      expect(prompt).toContain('src/section0.ts:1') // appears in existing findings
      expect(prompt).not.toContain('src/section0.ts:1 (') // NOT in recurrence format

      // Verify the continuation prompt also shows only section1 escalated
      const contPrompt = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'reset-test', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      expect(contPrompt).toContain('Recurring blocking findings')
      expect(contPrompt).toContain('src/section1.ts:2')
    })

    test('finding re-emerges with fresh count after section reset', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)

      reviewFindingsRepo.write({
        projectId, file: 'src/bug.ts', line: 10, severity: 'bug', description: 'Bug', scenario: 'test', loopName: 'reset-fresh', sectionIndex: 0,
      })

      const findings = loop.getOutstandingFindings('reset-fresh', 'bug')

      // Build up recurrence to count 2
      loop.bumpFindingRecurrence('reset-fresh', findings) // count=1
      loop.bumpFindingRecurrence('reset-fresh', findings) // count=2

      // Reset section 0 (clean audit)
      loop.resetSectionRecurrence('reset-fresh', 0)

      // Bump again — should start at 1, not 3
      loop.bumpFindingRecurrence('reset-fresh', findings) // count=1 (fresh)

      const prompt = loop.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'reset-fresh', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count=1 is below threshold, so no escalation
      expect(prompt).not.toContain('Recurring blocking findings')
    })

    test('resetting nonexistent section does not throw', () => {
      expect(() => loop.resetSectionRecurrence('nonexistent-loop', 0)).not.toThrow()
    })

    test('resetting section with no recurrence data does not throw', () => {
      expect(() => loop.resetSectionRecurrence('clean-loop', 0)).not.toThrow()
    })
  })

  describe('setCoderDecisions', () => {
    test('set and clear coder decisions via audit prompt', () => {
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const service = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, 'test-project-2', mockLogger,
      )

      const state: LoopState = {
        active: true,
        sessionId: 's1',
        loopName: 'test-loop-cd',
        worktreeDir: '/tmp/test',
        projectDir: '/tmp/test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        phase: 'coding',
        errorCount: 0,
        auditCount: 0,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
      } as LoopState

      // Set coder decisions
      service.setCoderDecisions('test-loop-cd', '### Decisions\n- Chose X')
      const promptWith = service.buildAuditPrompt(state)
      expect(promptWith).toContain('Coder decisions & verification notes')
      expect(promptWith).toContain('Chose X')

      // Clear coder decisions
      service.setCoderDecisions('test-loop-cd', null)
      const promptWithout = service.buildAuditPrompt(state)
      expect(promptWithout).not.toContain('Coder decisions & verification notes')
    })

    test('empty string clears coder decisions', () => {
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const service = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, 'test-project-3', mockLogger,
      )

      service.setCoderDecisions('test-loop-cd2', 'some decisions')
      service.setCoderDecisions('test-loop-cd2', '')

      const state: LoopState = {
        active: true,
        sessionId: 's2',
        loopName: 'test-loop-cd2',
        worktreeDir: '/tmp/test',
        projectDir: '/tmp/test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        phase: 'coding',
        errorCount: 0,
        auditCount: 0,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
      } as LoopState

      const prompt = service.buildAuditPrompt(state)
      expect(prompt).not.toContain('Coder decisions & verification notes')
    })
  })
})
