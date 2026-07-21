import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import { createPlanAmendmentsRepo } from '../src/storage/repos/plan-amendments-repo'
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
      const bugFindings = loop.service.getOutstandingFindings('b2', 'bug')
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

      const allFindings = loop.service.getOutstandingFindings('b2')
      expect(allFindings.length).toBe(2)

      const warningFindings = loop.service.getOutstandingFindings('b2', 'warning')
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

      const prompt = loop.service.buildAuditPrompt(state as any)

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

      const prompt = loop.service.buildContinuationPrompt(state as any)

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

      const prompt = loop.service.buildContinuationPrompt(state as any, 'audit findings text')

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

      const findings = loop.service.getOutstandingFindings('test-loop', 'bug')
      expect(findings.length).toBe(1)

      // First bump → count=1
      loop.service.bumpFindingRecurrence('test-loop', findings)
      const prompt1 = loop.service.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 1, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count 1 is below threshold, so no escalation
      expect(prompt1).not.toContain('Recurring blocking findings')
      expect(prompt1).not.toContain('Recurring findings — re-evaluate')

      // Second bump → count=2
      loop.service.bumpFindingRecurrence('test-loop', findings)
      const prompt2 = loop.service.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 2, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count 2 is still below threshold
      expect(prompt2).not.toContain('Recurring blocking findings')

      // Third bump → count=3 (threshold reached)
      loop.service.bumpFindingRecurrence('test-loop', findings)
      const prompt3 = loop.service.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'test-loop', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      expect(prompt3).toContain('Recurring blocking findings')
      expect(prompt3).toContain('src/bug.ts:10')
      expect(prompt3).toContain('recurred 3×')

      // Also surfaces in audit prompt
      const auditPrompt = loop.service.buildAuditPrompt({
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

      const findings1 = loop.service.getOutstandingFindings('test-loop-2', 'bug')
      loop.service.bumpFindingRecurrence('test-loop-2', findings1) // count=1
      loop.service.bumpFindingRecurrence('test-loop-2', findings1) // count=2

      // Now resolve the finding (remove it)
      reviewFindingsRepo.delete(projectId, 'src/bug.ts', 10, { loopName: 'test-loop-2' })

      const findings2 = loop.service.getOutstandingFindings('test-loop-2', 'bug')
      expect(findings2.length).toBe(0)

      // Bump with empty list — should reset
      loop.service.bumpFindingRecurrence('test-loop-2', findings2)

      // Re-add the same finding
      reviewFindingsRepo.write({
        projectId, file: 'src/bug.ts', line: 10, severity: 'bug', description: 'Bug', scenario: 'test', loopName: 'test-loop-2',
      })

      const findings3 = loop.service.getOutstandingFindings('test-loop-2', 'bug')
      loop.service.bumpFindingRecurrence('test-loop-2', findings3) // should start at 1 again

      const prompt = loop.service.buildContinuationPrompt({
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

      const findings = loop.service.getOutstandingFindings('test-loop-final', 'bug')
      expect(findings.length).toBe(1)

      const finalAuditState = {
        active: true, sessionId: 's1', loopName: 'test-loop-final', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'final_auditing', errorCount: 0, auditCount: 2,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any

      // Bump once — below threshold, no escalation
      loop.service.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt1 = loop.service.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt1).not.toContain('Recurring blocking findings')

      // Bump twice — still below threshold
      loop.service.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt2 = loop.service.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt2).not.toContain('Recurring blocking findings')

      // Bump third time — threshold reached, escalation appears
      loop.service.bumpFindingRecurrence('test-loop-final', findings)
      const fixPrompt3 = loop.service.buildFinalAuditFixPrompt(finalAuditState, 'final audit feedback')
      expect(fixPrompt3).toContain('Recurring blocking findings')
      expect(fixPrompt3).toContain('src/final-bug.ts:42')
      expect(fixPrompt3).toContain('recurred 3×')

      // Also surfaces in the final-audit prompt
      const auditPrompt = loop.service.buildFinalAuditPrompt(finalAuditState)
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

      const allBugs = loop.service.getOutstandingFindings('reset-test', 'bug')

      // Bump all bugs together → both keys coexist in the map at count=2
      loop.service.bumpFindingRecurrence('reset-test', allBugs) // s0:1, s1:1
      loop.service.bumpFindingRecurrence('reset-test', allBugs) // s0:2, s1:2

      // Reset section 0 — should only remove s0 keys, leaving s1:2
      loop.service.resetSectionRecurrence('reset-test', 0)

      // Bump ALL bugs again: s0 starts fresh (0+1=1), s1 continues (2+1=3)
      loop.service.bumpFindingRecurrence('reset-test', allBugs)

      // Check escalation via audit prompt: only s1 (count=3) should surface
      const prompt = loop.service.buildAuditPrompt({
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
      const contPrompt = loop.service.buildContinuationPrompt({
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

      const findings = loop.service.getOutstandingFindings('reset-fresh', 'bug')

      // Build up recurrence to count 2
      loop.service.bumpFindingRecurrence('reset-fresh', findings) // count=1
      loop.service.bumpFindingRecurrence('reset-fresh', findings) // count=2

      // Reset section 0 (clean audit)
      loop.service.resetSectionRecurrence('reset-fresh', 0)

      // Bump again — should start at 1, not 3
      loop.service.bumpFindingRecurrence('reset-fresh', findings) // count=1 (fresh)

      const prompt = loop.service.buildContinuationPrompt({
        active: true, sessionId: 's1', loopName: 'reset-fresh', worktreeDir: '/tmp/test',
        projectDir: '/tmp/test', iteration: 3, maxIterations: 5,
        startedAt: new Date().toISOString(), phase: 'coding', errorCount: 0, auditCount: 0,
        currentSectionIndex: 0, totalSections: 0, finalAuditDone: false,
      } as any)
      // Count=1 is below threshold, so no escalation
      expect(prompt).not.toContain('Recurring blocking findings')
    })

    test('resetting nonexistent section does not throw', () => {
      expect(() => loop.service.resetSectionRecurrence('nonexistent-loop', 0)).not.toThrow()
    })

    test('resetting section with no recurrence data does not throw', () => {
      expect(() => loop.service.resetSectionRecurrence('clean-loop', 0)).not.toThrow()
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

  describe('adjustRemainingSections', () => {
    function insertLoop(overrides: Record<string, any> = {}) {
      const defaults = {
        project_id: 'test-project',
        loop_name: 'adj-loop',
        status: 'running',
        current_session_id: 'sess-adj',
        worktree: 1,
        worktree_dir: '/tmp/wt',
        project_dir: '/tmp/proj',
        max_iterations: 10,
        iteration: 1,
        audit_count: 0,
        error_count: 0,
        phase: 'auditing',
        started_at: Date.now(),
        current_section_index: 1,
        total_sections: 4,
        final_audit_done: 0,
        loop_kind: 'plan',
        executor_session_id: null as string | null,
      }
      const values = { ...defaults, ...overrides }
      db.run(
        `INSERT INTO loops (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`,
        Object.values(values)
      )
      db.run(
        `INSERT INTO loop_large_fields (project_id, loop_name, last_audit_result) VALUES (?, ?, ?)`,
        [values.project_id, values.loop_name, null]
      )
    }

    function insertSectionPlan(index: number, title: string, content: string, status: string = 'pending') {
      db.run(
        `INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['test-project', 'adj-loop', index, title, content, status, 0, Date.now()]
      )
    }

    function buildService() {
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const sectionPlansRepo = createSectionPlansRepo(db)
      const planAmendmentsRepo = createPlanAmendmentsRepo(db)
      return {
        service: createLoopService(
          loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger,
          undefined, undefined, sectionPlansRepo, undefined, planAmendmentsRepo,
        ),
        sectionPlansRepo,
        planAmendmentsRepo,
        loopsRepo,
      }
    }

    test('happy path: replaces pending sections, updates total_sections, inserts one amendment row', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'New Phase 2', content: 'new c2' },
          { title: 'New Phase 3', content: 'new c3' },
        ],
        rationale: 'auditor revised remaining work after dirty audit',
      })

      expect(result).toEqual({ ok: true, totalSections: 4 })

      // total_sections unchanged on the loop row (1 + 2 = 3? No: fromIndex = current+1 = 2; newTotal = 2 + 2 = 4).
      const row = loopsRepo.get('test-project', 'adj-loop')
      expect(row?.totalSections).toBe(4)

      // Section rows: 0/1 untouched, 2/3 replaced.
      const rows = sectionPlansRepo.list('test-project', 'adj-loop')
      expect(rows).toHaveLength(4)
      expect(rows[0]).toMatchObject({ sectionIndex: 0, title: 'Phase 0', status: 'completed' })
      expect(rows[1]).toMatchObject({ sectionIndex: 1, title: 'Phase 1', status: 'in_progress' })
      expect(rows[2]).toMatchObject({ sectionIndex: 2, title: 'New Phase 2', status: 'pending' })
      expect(rows[3]).toMatchObject({ sectionIndex: 3, title: 'New Phase 3', status: 'pending' })

      // Exactly one amendment row with before/after JSON.
      const amendments = planAmendmentsRepo.listForLoop('test-project', 'adj-loop')
      expect(amendments).toHaveLength(1)
      const amend = amendments[0]
      expect(amend.source).toBe('auditor')
      expect(amend.rationale).toBe('auditor revised remaining work after dirty audit')
      expect(amend.appliedAtSection).toBe(1)
      const before = JSON.parse(amend.sectionsBefore)
      const after = JSON.parse(amend.sectionsAfter)
      expect(before).toEqual([
        { index: 2, title: 'Phase 2', content: 'c2' },
        { index: 3, title: 'Phase 3', content: 'c3' },
      ])
      expect(after).toEqual([
        { index: 2, title: 'New Phase 2', content: 'new c2' },
        { index: 3, title: 'New Phase 3', content: 'new c3' },
      ])
    })

    test('rejects goal loops', async () => {
      insertLoop({ loop_kind: 'goal' })
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')

      const { service, planAmendmentsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'X', content: 'x' }],
        rationale: 'should be rejected',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/goal/i)
      }
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('rejects when totalSections === 0', async () => {
      insertLoop({ total_sections: 0, current_section_index: 0 })

      const { service, planAmendmentsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'X', content: 'x' }],
        rationale: 'should be rejected',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/no sectioned plan|totalSections|total sections/i)
      }
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('rejects when phase is not auditing', async () => {
      insertLoop({ phase: 'coding' })
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')

      const { service, planAmendmentsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'X', content: 'x' }],
        rationale: 'should be rejected',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/auditing/)
      }
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('rejects when resulting total would exceed 24', async () => {
      insertLoop({ current_section_index: 1, total_sections: 4 })
      // 23 pending rows from index 2..24 inclusive → fromIndex=2, with 23 new sections → newTotal=25 > 24.
      for (let i = 2; i <= 24; i++) insertSectionPlan(i, `Old ${i}`, `c${i}`, 'pending')

      const { service, planAmendmentsRepo } = buildService()

      // Replacing with 23 sections would make total = 2 + 23 = 25 > 24.
      const newSections = Array.from({ length: 23 }, (_, i) => ({ title: `N${i}`, content: `n${i}` }))
      const result = await service.adjustRemainingSections('adj-loop', {
        sections: newSections,
        rationale: 'should be rejected',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/24/)
      }
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('rejects when rationale is empty', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')

      const { service, planAmendmentsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'X', content: 'x' }],
        rationale: '',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/rationale/i)
      }
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test("does not touch the plan text in the plans table", async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      db.run(
        `INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)`,
        ['test-project', 'adj-loop', 'ORIGINAL_PLAN_OBJECTIVE', Date.now()]
      )

      const { service } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'New 2', content: 'new c2' }],
        rationale: 'amend',
      })

      expect(result.ok).toBe(true)
      const plan = db.prepare('SELECT content FROM plans WHERE project_id = ? AND loop_name = ?').get('test-project', 'adj-loop') as { content: string }
      expect(plan.content).toBe('ORIGINAL_PLAN_OBJECTIVE')
    })

    test('rejects when planAmendmentsRepo is not configured', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')

      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const sectionPlansRepo = createSectionPlansRepo(db)
      const service = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger,
        undefined, undefined, sectionPlansRepo, undefined, undefined,
      )

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'New 2', content: 'new c2' }],
        rationale: 'amend',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/amendments/i)
      }
      // Nothing changed.
      const rows = sectionPlansRepo.list('test-project', 'adj-loop')
      expect(rows[2]).toMatchObject({ sectionIndex: 2, title: 'Phase 2', status: 'pending' })
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(4)
    })

    test('failure injection: setTotalSections throws rolls back sections, total, and amendment', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()
      // Snapshot prior state for assertion.
      const sectionsBefore = sectionPlansRepo.list('test-project', 'adj-loop')
      const totalBefore = loopsRepo.get('test-project', 'adj-loop')?.totalSections
      // Inject failure into the second write (the loop-row update).
      vi.spyOn(loopsRepo, 'setTotalSections').mockImplementation(() => {
        throw new Error('injected setTotalSections failure')
      })

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'New Phase 2', content: 'new c2' },
          { title: 'New Phase 3', content: 'new c3' },
        ],
        rationale: 'amend with injected failure',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/injected setTotalSections failure/)
      }
      // Sections unchanged: replacement rolled back.
      expect(sectionPlansRepo.list('test-project', 'adj-loop')).toEqual(sectionsBefore)
      // total_sections unchanged.
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(totalBefore)
      // No amendment row landed.
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('failure injection: planAmendmentsRepo.insert throws rolls back sections and total', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()
      const sectionsBefore = sectionPlansRepo.list('test-project', 'adj-loop')
      const totalBefore = loopsRepo.get('test-project', 'adj-loop')?.totalSections
      // Inject failure into the third write (the amendment audit-row insert).
      vi.spyOn(planAmendmentsRepo, 'insert').mockImplementation(() => {
        throw new Error('injected amendment insert failure')
      })

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'New Phase 2', content: 'new c2' },
          { title: 'New Phase 3', content: 'new c3' },
        ],
        rationale: 'amend with injected amendment failure',
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/injected amendment insert failure/)
      }
      // Sections unchanged.
      expect(sectionPlansRepo.list('test-project', 'adj-loop')).toEqual(sectionsBefore)
      // total_sections unchanged.
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(totalBefore)
      // No amendment row landed (the spy threw before any row was inserted).
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(0)
    })

    test('every successful adjustment creates exactly one amendment row across repeated calls', async () => {
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()

      // First successful adjustment: replace 2 pending sections.
      const r1 = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'R1 P2', content: 'r1 c2' },
          { title: 'R1 P3', content: 'r1 c3' },
        ],
        rationale: 'first amendment',
      })
      expect(r1).toEqual({ ok: true, totalSections: 4 })
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(1)

      // Second successful adjustment: replace the same pending range with one section.
      // total_sections becomes 3 (fromIndex=2, 1 new section).
      const r2 = await service.adjustRemainingSections('adj-loop', {
        sections: [{ title: 'R2 Only', content: 'r2 c2' }],
        rationale: 'second amendment',
      })
      expect(r2).toEqual({ ok: true, totalSections: 3 })
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(3)
      expect(planAmendmentsRepo.listForLoop('test-project', 'adj-loop')).toHaveLength(2)

      // Verify the second replacement's before/after JSON reflects the actual state.
      const a2 = planAmendmentsRepo.listForLoop('test-project', 'adj-loop')[1]
      expect(JSON.parse(a2.sectionsBefore)).toEqual([
        { index: 2, title: 'R1 P2', content: 'r1 c2' },
        { index: 3, title: 'R1 P3', content: 'r1 c3' },
      ])
      expect(JSON.parse(a2.sectionsAfter)).toEqual([
        { index: 2, title: 'R2 Only', content: 'r2 c2' },
      ])
      // Section 3 row is gone after the second replacement.
      const rows = sectionPlansRepo.list('test-project', 'adj-loop')
      expect(rows).toHaveLength(3)
      expect(rows[2]).toMatchObject({ sectionIndex: 2, title: 'R2 Only', status: 'pending' })
    })

    test('empty sections array removes the pending suffix, updates total_sections, and inserts one amendment', async () => {
      insertLoop({ total_sections: 4 })
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [],
        rationale: 'auditor cancelled remaining work',
      })

      expect(result).toEqual({ ok: true, totalSections: 2 })

      // total_sections lowered from 4 to fromIndex (2).
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(2)

      // Pending suffix removed; 0/1 untouched.
      const rows = sectionPlansRepo.list('test-project', 'adj-loop')
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ sectionIndex: 0, status: 'completed' })
      expect(rows[1]).toMatchObject({ sectionIndex: 1, status: 'in_progress' })

      // Exactly one amendment row recording the deleted suffix.
      const amendments = planAmendmentsRepo.listForLoop('test-project', 'adj-loop')
      expect(amendments).toHaveLength(1)
      const amend = amendments[0]
      expect(amend.rationale).toBe('auditor cancelled remaining work')
      expect(JSON.parse(amend.sectionsBefore)).toEqual([
        { index: 2, title: 'Phase 2', content: 'c2' },
        { index: 3, title: 'Phase 3', content: 'c3' },
      ])
      expect(JSON.parse(amend.sectionsAfter)).toEqual([])
    })

    test('appends new sections after the current final section when no pending rows remain', async () => {
      // current_section_index=3, total_sections=4 → fromIndex=4, no rows at >=4.
      insertLoop({ current_section_index: 3, total_sections: 4 })
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'completed')
      insertSectionPlan(2, 'Phase 2', 'c2', 'completed')
      insertSectionPlan(3, 'Phase 3', 'c3', 'in_progress')

      const { service, sectionPlansRepo, planAmendmentsRepo, loopsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'Appended A', content: 'a content' },
          { title: 'Appended B', content: 'b content' },
        ],
        rationale: 'auditor discovered additional work after the final section',
      })

      expect(result).toEqual({ ok: true, totalSections: 6 })
      expect(loopsRepo.get('test-project', 'adj-loop')?.totalSections).toBe(6)

      const rows = sectionPlansRepo.list('test-project', 'adj-loop')
      expect(rows).toHaveLength(6)
      // Existing rows untouched.
      expect(rows[0]).toMatchObject({ sectionIndex: 0, status: 'completed' })
      expect(rows[3]).toMatchObject({ sectionIndex: 3, status: 'in_progress' })
      // Two appended pending rows.
      expect(rows[4]).toMatchObject({ sectionIndex: 4, title: 'Appended A', status: 'pending', attempts: 0 })
      expect(rows[5]).toMatchObject({ sectionIndex: 5, title: 'Appended B', status: 'pending', attempts: 0 })

      // Exactly one amendment row with empty before-snapshot and the new rows as after.
      const amendments = planAmendmentsRepo.listForLoop('test-project', 'adj-loop')
      expect(amendments).toHaveLength(1)
      const amend = amendments[0]
      expect(JSON.parse(amend.sectionsBefore)).toEqual([])
      expect(JSON.parse(amend.sectionsAfter)).toEqual([
        { index: 4, title: 'Appended A', content: 'a content' },
        { index: 5, title: 'Appended B', content: 'b content' },
      ])
    })

    test('sectionsBefore snapshot is captured inside the transaction and matches the rows actually replaced', async () => {
      // Two pending sections; the amendment's before-snapshot must reflect
      // exactly the pre-replacement state, not any concurrent mutation.
      insertLoop()
      insertSectionPlan(0, 'Phase 0', 'c0', 'completed')
      insertSectionPlan(1, 'Phase 1', 'c1', 'in_progress')
      insertSectionPlan(2, 'Phase 2', 'c2', 'pending')
      insertSectionPlan(3, 'Phase 3', 'c3', 'pending')

      const { service, planAmendmentsRepo } = buildService()

      const result = await service.adjustRemainingSections('adj-loop', {
        sections: [
          { title: 'New Phase 2', content: 'new c2' },
          { title: 'New Phase 3', content: 'new c3' },
        ],
        rationale: 'concurrent-safe snapshot',
      })

      expect(result.ok).toBe(true)
      const amend = planAmendmentsRepo.listForLoop('test-project', 'adj-loop')[0]
      // Snapshot reflects the actual rows that were replaced, captured under
      // the same transaction that performed the delete/insert.
      expect(JSON.parse(amend.sectionsBefore)).toEqual([
        { index: 2, title: 'Phase 2', content: 'c2' },
        { index: 3, title: 'Phase 3', content: 'c3' },
      ])
      expect(JSON.parse(amend.sectionsAfter)).toEqual([
        { index: 2, title: 'New Phase 2', content: 'new c2' },
        { index: 3, title: 'New Phase 3', content: 'new c3' },
      ])
    })

    test('concurrency: suffix-deletion clamps setCurrentSectionIndex when index exceeds totalSections', () => {
      const db = new Database(':memory:')
      setupLoopsTestDb(db)
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const rfr = createReviewFindingsRepo(db)
      const sectionPlansRepo = createSectionPlansRepo(db)
      const amendmentsRepo = createPlanAmendmentsRepo(db)
      const service = createLoopService(
        loopsRepo, plansRepo, rfr, 'p', mockLogger,
        undefined, undefined, sectionPlansRepo, undefined, amendmentsRepo,
      )

      loopsRepo.insert({
        projectId: 'p', loopName: 'adj', status: 'running', currentSessionId: 's1',
        worktreeDir: '/w', worktree: false, worktreeBranch: null, projectDir: '/p',
        maxIterations: 10, iteration: 1, auditCount: 0, errorCount: 0,
        phase: 'auditing', executionModel: null, auditorModel: null,
        modelFailed: false, sandbox: false, sandboxContainer: null,
        startedAt: Date.now(), completedAt: null, terminationReason: null,
        completionSummary: null, workspaceId: null, hostSessionId: null,
        executorSessionId: null, currentSectionIndex: 1, totalSections: 2,
        finalAuditDone: 0, executionVariant: null, auditorVariant: null,
        kind: 'plan',
      } as any, { lastAuditResult: null, postActionReport: null })

      service.setCurrentSectionIndex('adj', 2)
      expect(loopsRepo.get('p', 'adj')?.currentSectionIndex).toBe(1)
      db.close()
    })

    test('concurrency: setTotalSections clamps currentSectionIndex when total is reduced', () => {
      const db = new Database(':memory:')
      setupLoopsTestDb(db)
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const rfr = createReviewFindingsRepo(db)
      const service = createLoopService(
        loopsRepo, plansRepo, rfr, 'p', mockLogger,
      )

      loopsRepo.insert({
        projectId: 'p', loopName: 'adj', status: 'running', currentSessionId: 's1',
        worktreeDir: '/w', worktree: false, worktreeBranch: null, projectDir: '/p',
        maxIterations: 10, iteration: 1, auditCount: 0, errorCount: 0,
        phase: 'auditing', executionModel: null, auditorModel: null,
        modelFailed: false, sandbox: false, sandboxContainer: null,
        startedAt: Date.now(), completedAt: null, terminationReason: null,
        completionSummary: null, workspaceId: null, hostSessionId: null,
        executorSessionId: null, currentSectionIndex: 4, totalSections: 5,
        finalAuditDone: 0, executionVariant: null, auditorVariant: null,
        kind: 'plan',
      } as any, { lastAuditResult: null, postActionReport: null })

      service.setTotalSections('adj', 3)
      expect(loopsRepo.get('p', 'adj')?.currentSectionIndex).toBe(2)
      db.close()
    })

    test('adjacent runExclusive calls serialise: two concurrent adjustRemainingSections never interleave', async () => {
      // When runExclusive is wired, two concurrent adjustRemainingSections calls
      // must be serialised — the second must see the updated state (after the first
      // committed) rather than the stale pre-first-snapshot state.
      const dbLocal = new Database(':memory:')
      setupLoopsTestDb(dbLocal)
      const loopsRepo = createLoopsRepo(dbLocal)
      const plansRepo = createPlansRepo(dbLocal)
      const rfr = createReviewFindingsRepo(dbLocal)
      const sectionPlansRepo = createSectionPlansRepo(dbLocal)
      const amendmentsRepo = createPlanAmendmentsRepo(dbLocal)

      let callOrder: number[] = []
      // A simple promise-chain lock simulating runExclusive.
      let pendingPromise: Promise<unknown> = Promise.resolve()
      const mockRunExclusive = async <T>(_loopName: string, fn: () => Promise<T>) => {
        const prev = pendingPromise
        pendingPromise = prev.catch(() => undefined).then(() => fn())
        return await pendingPromise as T
      }

      const service = createLoopService(
        loopsRepo, plansRepo, rfr, 'p', mockLogger,
        undefined, undefined, sectionPlansRepo, undefined, amendmentsRepo,
        mockRunExclusive,
      )

      // Loop: currentSectionIndex = 0, totalSections = 2
      // Sections: [0=pending, 1=pending]. fromIndex = 1.
      loopsRepo.insert({
        projectId: 'p', loopName: 'adj', status: 'running', currentSessionId: 's1',
        worktreeDir: '/w', worktree: false, worktreeBranch: null, projectDir: '/p',
        maxIterations: 10, iteration: 1, auditCount: 0, errorCount: 0,
        phase: 'auditing', executionModel: null, auditorModel: null,
        modelFailed: false, sandbox: false, sandboxContainer: null,
        startedAt: Date.now(), completedAt: null, terminationReason: null,
        completionSummary: null, workspaceId: null, hostSessionId: null,
        executorSessionId: null, currentSectionIndex: 0, totalSections: 2,
        finalAuditDone: 0, executionVariant: null, auditorVariant: null,
        kind: 'plan',
      } as any, { lastAuditResult: null, postActionReport: null })

      dbLocal.run(`INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES ('p', 'adj', 0, 'S0', 'c0', 'pending', 0, ?)`, [Date.now()])
      dbLocal.run(`INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES ('p', 'adj', 1, 'S1', 'c1', 'pending', 0, ?)`, [Date.now()])

      // Launch two adjustments concurrently but serialised by runExclusive.
      // Caller A replaces section 1 with 'A' (fromIndex = 1, newTotal = 2 → ok)
      // Caller B replaces section 1 with 'B' (fromIndex = 1, but after A commits, fromIndex still 1 since currentSectionIndex unchanged)
      const p1 = service.adjustRemainingSections('adj', {
        sections: [{ title: 'A', content: 'a' }],
        rationale: 'caller A',
      })
      const p2 = service.adjustRemainingSections('adj', {
        sections: [{ title: 'B', content: 'b' }],
        rationale: 'caller B',
      })
      const [r1, r2] = await Promise.all([p1, p2])

      // Both must succeed (each with fromIndex=1, one section). The second will
      // snapshot A's replacement as before-snapshot.
      expect(r1.ok).toBe(true)
      if (r1.ok) expect(r1.totalSections).toBe(2)
      expect(r2.ok).toBe(true)
      if (r2.ok) expect(r2.totalSections).toBe(2)

      // Exactly two amendment rows landed.
      const amendments = amendmentsRepo.listForLoop('p', 'adj')
      expect(amendments).toHaveLength(2)
      // Section 1 title is whatever the second caller set.
      const rows = sectionPlansRepo.list('p', 'adj')
      expect(rows).toHaveLength(2)
      expect(rows[1].title).toBe('B') // B was second

      dbLocal.close()
    })

    test('adjacent: adjustRemainingSections rejects when loop falls out of auditing phase', async () => {
      // Simulates the scenario: a suffix-deletion reduces totalSections which
      // causes setCurrentSectionIndex to clamp, but the loop stays in auditing.
      // A subsequent adjustment still validates against the (now-authoritative)
      // phase and totalSections.
      const dbLocal = new Database(':memory:')
      setupLoopsTestDb(dbLocal)
      const loopsRepo = createLoopsRepo(dbLocal)
      const plansRepo = createPlansRepo(dbLocal)
      const rfr = createReviewFindingsRepo(dbLocal)
      const sectionPlansRepo = createSectionPlansRepo(dbLocal)
      const amendmentsRepo = createPlanAmendmentsRepo(dbLocal)

      const service = createLoopService(
        loopsRepo, plansRepo, rfr, 'p', mockLogger,
        undefined, undefined, sectionPlansRepo, undefined, amendmentsRepo,
      )

      // Loop: currentSectionIndex = 0, totalSections = 3
      // Sections: [0=pending, 1=pending, 2=pending]. fromIndex = 1.
      loopsRepo.insert({
        projectId: 'p', loopName: 'adj2', status: 'running', currentSessionId: 's1',
        worktreeDir: '/w', worktree: false, worktreeBranch: null, projectDir: '/p',
        maxIterations: 10, iteration: 1, auditCount: 0, errorCount: 0,
        phase: 'auditing', executionModel: null, auditorModel: null,
        modelFailed: false, sandbox: false, sandboxContainer: null,
        startedAt: Date.now(), completedAt: null, terminationReason: null,
        completionSummary: null, workspaceId: null, hostSessionId: null,
        executorSessionId: null, currentSectionIndex: 0, totalSections: 3,
        finalAuditDone: 0, executionVariant: null, auditorVariant: null,
        kind: 'plan',
      } as any, { lastAuditResult: null, postActionReport: null })

      dbLocal.run(`INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES ('p', 'adj2', 0, 'S0', 'c0', 'pending', 0, ?)`, [Date.now()])
      dbLocal.run(`INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES ('p', 'adj2', 1, 'S1', 'c1', 'pending', 0, ?)`, [Date.now()])
      dbLocal.run(`INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, created_at) VALUES ('p', 'adj2', 2, 'S2', 'c2', 'pending', 0, ?)`, [Date.now()])

      let result = await service.adjustRemainingSections('adj2', {
        sections: [{ title: 'N1', content: 'n1' }],
        rationale: 'replace',
      })
      expect(result.ok).toBe(true)

      // Now advance the loop to 'coding' (simulates the ticker moving on).
      loopsRepo.updatePhase('p', 'adj2', 'coding')

      result = await service.adjustRemainingSections('adj2', {
        sections: [{ title: 'N1', content: 'n1' }],
        rationale: 'should fail',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/auditing/)
      }

      dbLocal.close()
    })
  })
})
