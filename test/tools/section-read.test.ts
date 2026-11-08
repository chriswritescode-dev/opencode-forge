import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createSectionRunsRepo } from '../../src/storage/repos/section-runs-repo'
import { createLoopService } from '../../src/loop/service'
import { createSectionReadTool } from '../../src/tools/section-read'
import { createMockLogger } from '../helpers/logger'
import { createTestDb } from '../helpers/test-db'

const mockLogger = createMockLogger()

describe('section-read tool', () => {
  let db: Database
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let sectionRunsRepo: ReturnType<typeof createSectionRunsRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'section-read-test-'))
    testDb = createTestDb()
    db = testDb.db

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    sectionRunsRepo = createSectionRunsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    testDb.cleanup()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string, opts?: { currentSectionIndex?: number; totalSections?: number; currentSessionId?: string }) {
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
      currentSectionIndex: opts?.currentSectionIndex ?? 0,
      totalSections: opts?.totalSections ?? 0,
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

  function makeToolContext(sessionID: string) {
    return { sessionID } as any
  }

  async function executeSectionRead(args?: { section_index?: number; pending_suffix?: boolean; overview?: boolean }, sessionID?: string): Promise<string> {
    const tool = createSectionReadTool({ loop: { service: loopService } } as any)
    const result = await tool.execute(args ?? {}, makeToolContext(sessionID ?? ''))
    return typeof result === 'string' ? result : (result as unknown as { output: string }).output
  }

  function parseJson(result: string) {
    return JSON.parse(result)
  }

  describe('error cases', () => {
    test('returns error when not in a loop session', async () => {
      const result = parseJson(await executeSectionRead({}, 'unknown-session'))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when loop not found', async () => {
      const result = parseJson(await executeSectionRead({}, 'nonexistent-session'))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when totalSections === 0', async () => {
      insertLoop('test-loop', { totalSections: 0 })
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.error).toContain('No sections available')
    })

    test('returns error for invalid section index (negative)', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: -1 }, 'test-loop-session'))
      expect(result.error).toContain('Invalid section index -1')
    })

    test('returns error for invalid section index (>= totalSections)', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: 3 }, 'test-loop-session'))
      expect(result.error).toContain('Invalid section index 3')
    })

    test('returns error when section not found in database', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({ section_index: 1 }, 'test-loop-session'))
      expect(result.error).toBeUndefined()
      expect(result.index).toBe(1)
    })
  })

  describe('success cases', () => {
    test('returns correct section data for valid index', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.id).toBe('section-1')
      expect(result.after).toEqual([])
      expect(result.title).toBe('Section 1')
      expect(result.content).toBe('Content for section 1')
      expect(result.status).toBe('pending')
      expect(result.summary_done).toBeNull()
      expect(result.summary_deviations).toBeNull()
      expect(result.summary_follow_ups).toBeNull()
    })

    test('reads the run own section when currentSectionIndex points later', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
      expect(result.content).toBe('Content for section 3')
    })

    test('reads the run own section instead of an earlier failed section', async () => {
      insertLoop('test-loop', { totalSections: 2, currentSectionIndex: 1 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'failed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.status).toBe('pending')
    })

    test('reads the run own section when an earlier section is completed', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
    })

    test('falls back to state.currentSectionIndex when all sections are completed', async () => {
      insertLoop('test-loop', { totalSections: 2, currentSectionIndex: 1 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.title).toBe('Section 2')
    })

    test('explicit section_index still returns the requested section even if another incomplete section exists', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      const result = parseJson(await executeSectionRead({ section_index: 1 }, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.title).toBe('Section 2')
    })

    test('summary fields still populate when explicitly reading a completed section', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Handled in section 2',
      })
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.summary_done).toBe('Implemented feature X')
      expect(result.summary_deviations).toBe('None')
      expect(result.summary_follow_ups).toBe('Handled in section 2')
    })

    test('no section statuses are changed by calling section-read()', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)

      const beforeStatuses = [
        sectionPlansRepo.get(projectId, 'test-loop', 0)?.status,
        sectionPlansRepo.get(projectId, 'test-loop', 1)?.status,
      ]

      await executeSectionRead({}, 'test-loop-session')

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.status).toBe(beforeStatuses[0])
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)?.status).toBe(beforeStatuses[1])
    })

    test('handles empty session ID gracefully', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({}, ''))
      expect(result.error).toContain('Not in a loop session')
    })
  })

  describe('pending_suffix', () => {
    test('returns ordered pending sections after the current one', async () => {
      insertLoop('test-loop', { totalSections: 4, currentSectionIndex: 1 })
      insertSections('test-loop', 4)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      const result = parseJson(await executeSectionRead({ pending_suffix: true }, 'test-loop-session'))
      expect(result.from_index).toBe(2)
      expect(result.sections).toEqual([
        { index: 2, id: 'section-3', after: [], title: 'Section 3', content: 'Content for section 3', status: 'pending' },
        { index: 3, id: 'section-4', after: [], title: 'Section 4', content: 'Content for section 4', status: 'pending' },
      ])
    })

    test('returns ids and dependency edges for the suffix and for a single section', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 0 })
      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: 'test-loop',
        sections: [
          { index: 0, id: 'base', after: [], title: 'Base', content: 'base' },
          { index: 1, id: 'parse', after: ['base'], title: 'Parse', content: 'parse' },
          { index: 2, id: 'emit', after: ['base', 'parse'], title: 'Emit', content: 'emit' },
        ],
      })
      loopsRepo.setTotalSections(projectId, 'test-loop', 3)

      const suffix = parseJson(await executeSectionRead({ pending_suffix: true }, 'test-loop-session'))
      expect(suffix.sections.map((s: { id: string; after: string[] }) => ({ id: s.id, after: s.after }))).toEqual([
        { id: 'parse', after: ['base'] },
        { id: 'emit', after: ['base', 'parse'] },
      ])

      const single = parseJson(await executeSectionRead({ section_index: 2 }, 'test-loop-session'))
      expect(single.id).toBe('emit')
      expect(single.after).toEqual(['base', 'parse'])
    })

    test('returns an empty suffix when the current section is the last', async () => {
      insertLoop('test-loop', { totalSections: 2, currentSectionIndex: 1 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({ pending_suffix: true }, 'test-loop-session'))
      expect(result.from_index).toBe(2)
      expect(result.sections).toEqual([])
    })

    test('rejects combining pending_suffix with section_index', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ pending_suffix: true, section_index: 1 }, 'test-loop-session'))
      expect(result.error).toContain('pending_suffix cannot be combined with section_index')
    })

    test('does not mutate section statuses or summaries', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 1 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, { done: 'did 0' })

      await executeSectionRead({ pending_suffix: true }, 'test-loop-session')

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.status).toBe('pending')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)?.status).toBe('in_progress')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 2)?.status).toBe('pending')
      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.summaryDone).toBe('did 0')
    })

    test('splits the pending suffix and defaults are unaffected', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 0 })
      insertSections('test-loop', 3)
      const pending = parseJson(await executeSectionRead({ pending_suffix: true }, 'test-loop-session'))
      expect(pending.from_index).toBe(1)
      expect(pending.sections.map((s: { index: number }) => s.index)).toEqual([1, 2])
      const byIndex = parseJson(await executeSectionRead({ section_index: 2 }, 'test-loop-session'))
      expect(byIndex.index).toBe(2)
      expect(byIndex.title).toBe('Section 3')
    })

    test('skips a later completed row when computing the replacement suffix start', async () => {
      insertLoop('test-loop', { totalSections: 4, currentSectionIndex: 1 })
      insertSections('test-loop', 4)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'in_progress')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 2, 'completed')
      const result = parseJson(await executeSectionRead({ pending_suffix: true }, 'test-loop-session'))
      expect(result.from_index).toBe(3)
      expect(result.sections.map((s: { index: number }) => s.index)).toEqual([3])
    })
  })

  describe('overview', () => {
    test('returns the status table for every section', async () => {
      insertLoop('test-loop', { totalSections: 4, currentSectionIndex: 1 })
      insertSections('test-loop', 4)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionRunsRepo.activate(
        projectId,
        'test-loop',
        { kind: 'section', sectionId: 'section-3', sectionIndex: 2 },
        { sessionId: 'lane-session', phase: 'auditing', standbySessionId: null, laneDir: '/tmp/lane' },
        { exclusive: false },
      )

      const result = parseJson(await executeSectionRead({ overview: true }, 'test-loop-session'))
      const table = result.status_table as string
      expect(table).toContain('## Section status')
      for (const id of ['section-1', 'section-2', 'section-3', 'section-4']) {
        expect(table).toContain(`| ${id} |`)
      }
      expect(table).toContain('| completed |')
      expect(table).toContain('| not started |')
      expect(table).toContain('auditing in lane')
      expect(table).toContain('/tmp/lane')
    })

    test('rejects combining overview with section_index', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ overview: true, section_index: 1 }, 'test-loop-session'))
      expect(result.error).toContain('overview cannot be combined with section_index')
    })

    test('rejects combining overview with pending_suffix', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ overview: true, pending_suffix: true }, 'test-loop-session'))
      expect(result.error).toContain('overview cannot be combined with section_index or pending_suffix')
    })
  })

  describe('state-driven behavior', () => {
    test('returns the run own section instead of the next ready one', async () => {
      insertLoop('test-loop', { currentSectionIndex: 2, totalSections: 5 })
      insertSections('test-loop', 5)
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
    })

    test('a caller owning a non-primary section run reads its own section', async () => {
      insertLoop('test-loop', { currentSectionIndex: 0, totalSections: 3 })
      insertSections('test-loop', 3)
      sectionRunsRepo.activate(
        projectId,
        'test-loop',
        { kind: 'section', sectionId: 'section-3', sectionIndex: 2 },
        { sessionId: 'second-run-session', phase: 'coding', standbySessionId: null },
        { exclusive: false },
      )

      const result = parseJson(await executeSectionRead({}, 'second-run-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
      expect(result.content).toBe('Content for section 3')
    })

    test('allows reading sections beyond current index', async () => {
      insertLoop('test-loop', { currentSectionIndex: 0, totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: 2 }, 'test-loop-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
    })

    test('allows reading previously completed sections', async () => {
      insertLoop('test-loop', { currentSectionIndex: 1, totalSections: 3 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, {
        done: 'Section 0 done',
      })
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.title).toBe('Section 1')
      expect(result.status).toBe('completed')
      expect(result.summary_done).toBe('Section 0 done')
    })
  })
})
