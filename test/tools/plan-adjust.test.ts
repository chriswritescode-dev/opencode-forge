import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createPlanAmendmentsRepo } from '../../src/storage/repos/plan-amendments-repo'
import { createLoopService } from '../../src/loop/service'
import { createPlanAdjustTool } from '../../src/tools/plan-adjust'
import type { Logger } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('plan-adjust tool', () => {
  let db: Database
  let dbPath: string
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let planAmendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-adjust-test-'))
    dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    planAmendmentsRepo = createPlanAmendmentsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo, undefined, planAmendmentsRepo)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string, opts?: {
    currentSectionIndex?: number
    totalSections?: number
    currentSessionId?: string
    phase?: 'auditing' | 'coding' | 'final_auditing' | 'post_action' | 'final_audit_fix'
  }) {
    loopsRepo.insert({
      projectId,
      loopName,
      status: 'running',
      currentSessionId: opts?.currentSessionId ?? `${loopName}-session`,
      worktree: false,
      worktreeDir: tempDir,
      worktreeBranch: null,
      projectDir: tempDir,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: opts?.phase ?? 'auditing',
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
      currentSectionIndex: opts?.currentSectionIndex ?? 0,
      totalSections: opts?.totalSections ?? 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }, { lastAuditResult: null })
  }

  function makeToolContext(sessionID: string) {
    return { sessionID } as any
  }

  async function executePlanAdjust(
    args: {
      sections?: Array<{ title: string; content: string }>
      currentSection?: { title: string; content: string }
      rationale: string
    },
    sessionID?: string,
  ): Promise<string> {
    const tool = createPlanAdjustTool({ loop: { service: loopService } } as any)
    const result = await tool.execute(args, makeToolContext(sessionID ?? ''))
    return typeof result === 'string' ? result : JSON.stringify(result.output)
  }

  function seedSections(loopName: string, sections: Array<{ title: string; content: string }>) {
    sectionPlansRepo.bulkInsert({
      projectId,
      loopName,
      sections: sections.map((s, index) => ({ index, title: s.title, content: s.content })),
    })
  }

  function parseJson(result: string) {
    return JSON.parse(result)
  }

  describe('error cases', () => {
    test('returns error when not in a loop session', async () => {
      const result = parseJson(await executePlanAdjust(
        { sections: [], rationale: 'removing dead sections' },
        'non-loop-session',
      ))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when phase is not auditing', async () => {
      insertLoop('test-loop', {
        currentSessionId: 'test-loop-session',
        totalSections: 3,
        phase: 'coding',
      })
      const result = parseJson(await executePlanAdjust(
        { sections: [], rationale: 'removing dead sections' },
        'test-loop-session',
      ))
      expect(result.error).toContain('auditing')
    })

    test('forwards sections and rationale to adjustRemainingSections via stub', async () => {
      const forwarded: { name: string; args: { sections: unknown[]; rationale: string } }[] = []
      const stubService = {
        ...loopService,
        resolveLoopName: (sessionId: string) => (sessionId === 'audit-sess-1' ? 'test-loop' : null),
        getAnyState: (_name: string) => ({
          active: true,
          sessionId: 'audit-sess-1',
          phase: 'auditing' as const,
        } as any),
        adjustRemainingSections: (name: string, args: { sections: unknown[]; rationale: string }) => {
          forwarded.push({ name, args })
          return Promise.resolve({ ok: true, totalSections: 2 })
        },
      }

      const tool = createPlanAdjustTool({ loop: { service: stubService } } as any)
      const result = await tool.execute(
        {
          sections: [{ title: 'New A', content: 'X' }],
          rationale: 'revised plan after audit',
        },
        { sessionID: 'audit-sess-1' },
      )
      const parsed = typeof result === 'string' ? JSON.parse(result) : JSON.parse((result as any).output)

      expect(parsed.ok).toBe(true)
      expect(parsed.total_sections).toBe(2)
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0].name).toBe('test-loop')
      expect(forwarded[0].args.sections).toEqual([{ title: 'New A', content: 'X' }])
      expect(forwarded[0].args.rationale).toBe('revised plan after audit')
    })

    test('passes service error rejection through verbatim', async () => {
      const stubService = {
        ...loopService,
        resolveLoopName: (sessionId: string) => (sessionId === 'audit-sess-2' ? 'test-loop' : null),
        getAnyState: (_name: string) => ({
          active: true,
          sessionId: 'audit-sess-2',
          phase: 'auditing' as const,
        } as any),
        adjustRemainingSections: (_name: string, _args: { sections: unknown[]; rationale: string }) =>
          Promise.resolve({ ok: false, error: 'plan objective is immutable; cannot remove verification step' }),
      }

      const tool = createPlanAdjustTool({ loop: { service: stubService } } as any)
      const result = await tool.execute(
        { sections: [{ title: 'Trimmed', content: 'Y' }], rationale: 'trim section' },
        { sessionID: 'audit-sess-2' },
      )
      const parsed = typeof result === 'string' ? JSON.parse(result) : JSON.parse((result as any).output)

      expect(parsed.error).toBe('plan objective is immutable; cannot remove verification step')
    })

    test('rejects when caller session != loop auditor session', async () => {
      insertLoop('test-loop', {
        currentSessionId: 'correct-audit-session',
        totalSections: 3,
      })

      const stubService = {
        ...loopService,
        resolveLoopName: (sessionId: string) =>
          (sessionId === 'wrong-audit-session' ? 'test-loop' : null),
      }

      const tool = createPlanAdjustTool({ loop: { service: stubService } } as any)
      const resultStr = await tool.execute(
        { sections: [{ title: 'Revised', content: 'Z' }], rationale: 'should be blocked' },
        { sessionID: 'wrong-audit-session' },
      )
      const result = typeof resultStr === 'string'
        ? JSON.parse(resultStr)
        : JSON.parse((resultStr as any).output)

      expect(result.error).toContain('session mismatch')
      expect(result.error).toContain('test-loop')
    })

    test('handles empty session ID gracefully', async () => {
      const result = parseJson(await executePlanAdjust(
        { sections: [], rationale: 'test' },
        '',
      ))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when neither sections nor currentSection is provided', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      const result = parseJson(await executePlanAdjust(
        { rationale: 'nothing to change' },
        'test-loop-session',
      ))
      expect(result.error).toContain('no changes specified')
    })

    test('rejects editing an already-completed current section', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      seedSections('test-loop', [
        { title: 'S0', content: 'c0' },
        { title: 'S1', content: 'c1' },
        { title: 'S2', content: 'c2' },
      ])
      loopService.completeSection('test-loop', 1, { done: 'x', deviations: null, followUps: null })
      const result = parseJson(await executePlanAdjust(
        { currentSection: { title: 'S1-new', content: 'c1-new' }, rationale: 'edit completed section' },
        'test-loop-session',
      ))
      expect(result.error).toContain('completed')
    })
  })

  describe('success cases', () => {
    test('returns { ok: true, total_sections } and forwards sections+rationale to service', async () => {
      insertLoop('test-loop', {
        currentSessionId: 'test-loop-session',
        totalSections: 3,
      })

      const resultStr = await executePlanAdjust(
        {
          sections: [
            { title: 'Section A', content: 'Content A' },
            { title: 'Section B', content: 'Content B' },
          ],
          rationale: 'Plan objective shifted; removed redundant sections.',
        },
        'test-loop-session',
      )
      const result = parseJson(resultStr)
      expect(result.ok).toBe(true)
      expect(result).toHaveProperty('total_sections')
      expect(result.total_sections).toBeTypeOf('number')
    })

    test('empty sections array succeeds (removes entire pending suffix)', async () => {
      insertLoop('test-loop', {
        currentSessionId: 'test-loop-session',
        totalSections: 3,
      })
      const resultStr = await executePlanAdjust(
        { sections: [], rationale: 'removing all remaining sections' },
        'test-loop-session',
      )
      const result = parseJson(resultStr)
      expect(result.ok).toBe(true)
      expect(result).toHaveProperty('total_sections')
    })

    test('edits the current section in place, preserving its progress and total', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      seedSections('test-loop', [
        { title: 'S0', content: 'c0' },
        { title: 'S1', content: 'c1-old' },
        { title: 'S2', content: 'c2' },
      ])
      loopService.startSection('test-loop', 1)
      loopService.incrementSectionAttempts('test-loop', 1)

      const result = parseJson(await executePlanAdjust(
        { currentSection: { title: 'S1-new', content: 'c1-new' }, rationale: 'unforeseen outcome: current section must be rescoped' },
        'test-loop-session',
      ))
      expect(result.ok).toBe(true)
      expect(result.total_sections).toBe(3)

      const cur = sectionPlansRepo.get(projectId, 'test-loop', 1)!
      expect(cur.title).toBe('S1-new')
      expect(cur.content).toBe('c1-new')
      expect(cur.status).toBe('in_progress')
      expect(cur.attempts).toBe(1)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)!.content).toBe('c0')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)!.content).toBe('c2')
    })

    test('omitting sections leaves future sections unchanged while editing current', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      seedSections('test-loop', [
        { title: 'S0', content: 'c0' },
        { title: 'S1', content: 'c1-old' },
        { title: 'S2', content: 'c2' },
      ])
      loopService.startSection('test-loop', 1)

      const result = parseJson(await executePlanAdjust(
        { currentSection: { title: 'S1-new', content: 'c1-new' }, rationale: 'edit current only' },
        'test-loop-session',
      ))
      expect(result.ok).toBe(true)
      expect(result.total_sections).toBe(3)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)!.title).toBe('S2')
    })

    test('edits current section and replaces the pending suffix together', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      seedSections('test-loop', [
        { title: 'S0', content: 'c0' },
        { title: 'S1', content: 'c1-old' },
        { title: 'S2', content: 'c2' },
      ])
      loopService.startSection('test-loop', 1)

      const result = parseJson(await executePlanAdjust(
        {
          currentSection: { title: 'S1-new', content: 'c1-new' },
          sections: [{ title: 'S2-new', content: 'c2-new' }],
          rationale: 'rescope current and remaining',
        },
        'test-loop-session',
      ))
      expect(result.ok).toBe(true)
      expect(result.total_sections).toBe(3)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)!.content).toBe('c1-new')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)!.title).toBe('S2-new')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)!.status).toBe('pending')
    })

    test('editing current section with empty sections removes the pending suffix', async () => {
      insertLoop('test-loop', { currentSessionId: 'test-loop-session', totalSections: 3, currentSectionIndex: 1 })
      seedSections('test-loop', [
        { title: 'S0', content: 'c0' },
        { title: 'S1', content: 'c1-old' },
        { title: 'S2', content: 'c2' },
      ])
      loopService.startSection('test-loop', 1)

      const result = parseJson(await executePlanAdjust(
        { currentSection: { title: 'S1-new', content: 'c1-new' }, sections: [], rationale: 'drop remaining, rescope current' },
        'test-loop-session',
      ))
      expect(result.ok).toBe(true)
      expect(result.total_sections).toBe(2)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)!.content).toBe('c1-new')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)).toBeNull()
    })
  })
})
