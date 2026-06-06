import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, MAX_RETRIES } from '../../src/loop/service'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { openForgeDatabase } from '../../src/storage/database'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('Loop final audit rewind behavior', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-final-audit-rewind-test-'))
    const dbPath = join(tempDir, 'loop-final-audit-rewind-test.db')
    db = openForgeDatabase(dbPath)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(
      loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger,
      undefined, undefined, undefined, sectionPlansRepo,
    )
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(overrides: Record<string, any> = {}) {
    const defaults: Record<string, any> = {
      project_id: projectId,
      loop_name: 'test-loop',
      status: 'running',
      current_session_id: 'sess-1',
      worktree: 1,
      worktree_dir: '/tmp/wt',
      project_dir: '/tmp/proj',
      max_iterations: 5,
      iteration: 1,
      audit_count: 0,
      error_count: 0,
      phase: 'coding',
      started_at: Date.now(),
      current_section_index: 0,
      total_sections: 3,
      final_audit_done: 0,
    }
    const values = { ...defaults, ...overrides }
    db.run(
      `INSERT INTO loops (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`,
      Object.values(values),
    )
  }

  function insertSectionPlan(loopName: string, sectionIndex: number, opts: {
    title?: string
    content?: string
    status?: string
    attempts?: number
    summaryDone?: string | null
    summaryDeviations?: string | null
    summaryFollowUps?: string | null
  } = {}) {
    db.run(
      `INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, summary_done, summary_deviations, summary_follow_ups, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId, loopName, sectionIndex,
        opts.title ?? `Section ${sectionIndex}`,
        opts.content ?? `Content for section ${sectionIndex}`,
        opts.status ?? 'completed',
        opts.attempts ?? 0,
        opts.summaryDone ?? null,
        opts.summaryDeviations ?? null,
        opts.summaryFollowUps ?? null,
        Date.now(),
      ],
    )
  }



  describe('buildFinalAuditPrompt', () => {
    test('includes section summaries when sections are completed', () => {
      insertLoop({ loop_name: 'summary-loop', total_sections: 2 })
      insertSectionPlan('summary-loop', 0, {
        title: 'Auth Module',
        status: 'completed',
        summaryDone: 'Implemented JWT auth',
        summaryDeviations: 'Used HS256 instead of RS256',
        summaryFollowUps: null,
      })
      insertSectionPlan('summary-loop', 1, {
        title: 'API Endpoints',
        status: 'completed',
        summaryDone: 'Added CRUD endpoints',
        summaryDeviations: null,
        summaryFollowUps: 'Add rate limiting later',
      })

      const state = loopService.getActiveState('summary-loop')
      expect(state).not.toBeNull()

      const prompt = loopService.buildFinalAuditPrompt(state!)

      expect(prompt).toContain('[Final integration audit]')
      expect(prompt).toContain('## Master Plan')
      expect(prompt).toContain("### Completed Sections' Summaries")
      expect(prompt).toContain('## Section 1: Auth Module')
      expect(prompt).toContain('### Done\nImplemented JWT auth')
      expect(prompt).toContain('### Deviations\nUsed HS256 instead of RS256')
      expect(prompt).toContain('## Section 2: API Endpoints')
      expect(prompt).toContain('### Done\nAdded CRUD endpoints')
      expect(prompt).toContain('### Follow-ups\nAdd rate limiting later')
    })

    test('returns prompt without summaries when no sections are completed', () => {
      insertLoop({ loop_name: 'empty-loop', total_sections: 2 })

      const state = loopService.getActiveState('empty-loop')
      expect(state).not.toBeNull()

      const prompt = loopService.buildFinalAuditPrompt(state!)

      expect(prompt).toContain('[Final integration audit]')
      expect(prompt).toContain('## Master Plan')
      expect(prompt).not.toContain("### Completed Sections' Summaries")
    })
  })

  describe('setFinalAuditDone', () => {
    test('marks final audit as done and persists correctly', () => {
      insertLoop({ loop_name: 'done-loop' })

      const beforeState = loopService.getActiveState('done-loop')
      expect(beforeState!.finalAuditDone).toBe(false)

      loopService.setFinalAuditDone('done-loop', true)

      const afterState = loopService.getActiveState('done-loop')
      expect(afterState!.finalAuditDone).toBe(true)
    })

    test('can reset final audit done to false', () => {
      insertLoop({ loop_name: 'reset-loop', final_audit_done: 1 })

      const beforeState = loopService.getActiveState('reset-loop')
      expect(beforeState!.finalAuditDone).toBe(true)

      loopService.setFinalAuditDone('reset-loop', false)

      const afterState = loopService.getActiveState('reset-loop')
      expect(afterState!.finalAuditDone).toBe(false)
    })
  })



  describe('getCompletedSectionDigest', () => {
    test('returns completed section summaries', () => {
      insertLoop({ loop_name: 'digest-loop', total_sections: 3 })

      insertSectionPlan('digest-loop', 0, {
        title: 'Section Zero',
        status: 'completed',
        summaryDone: 'Zero done',
        summaryDeviations: 'Zero deviations',
        summaryFollowUps: 'Zero follow-ups',
      })
      insertSectionPlan('digest-loop', 1, {
        title: 'Section One',
        status: 'completed',
        summaryDone: 'One done',
        summaryDeviations: 'One deviations',
        summaryFollowUps: null,
      })
      insertSectionPlan('digest-loop', 2, {
        title: 'Section Two',
        status: 'in_progress',
        summaryDone: null,
        summaryDeviations: null,
        summaryFollowUps: null,
      })

      const state = loopService.getActiveState('digest-loop')
      const digest = loopService.getCompletedSectionDigest(state!)

      expect(digest).toHaveLength(2)
      expect(digest[0].index).toBe(0)
      expect(digest[0].title).toBe('Section Zero')
      expect(digest[0].summaryDone).toBe('Zero done')
      expect(digest[0].summaryDeviations).toBe('Zero deviations')
      expect(digest[0].summaryFollowUps).toBe('Zero follow-ups')

      expect(digest[1].index).toBe(1)
      expect(digest[1].title).toBe('Section One')
      expect(digest[1].summaryDone).toBe('One done')
    })

    test('returns empty array when no sections are completed', () => {
      insertLoop({ loop_name: 'no-complete', total_sections: 2 })

      insertSectionPlan('no-complete', 0, { status: 'pending' })
      insertSectionPlan('no-complete', 1, { status: 'in_progress' })

      const state = loopService.getActiveState('no-complete')
      const digest = loopService.getCompletedSectionDigest(state!)
      expect(digest).toHaveLength(0)
    })

    test('returns all completed sections in order', () => {
      insertLoop({ loop_name: 'order-loop', total_sections: 3 })

      insertSectionPlan('order-loop', 0, { title: 'First', status: 'completed', summaryDone: 'A' })
      insertSectionPlan('order-loop', 1, { title: 'Second', status: 'completed', summaryDone: 'B' })
      insertSectionPlan('order-loop', 2, { title: 'Third', status: 'completed', summaryDone: 'C' })

      const state = loopService.getActiveState('order-loop')
      const digest = loopService.getCompletedSectionDigest(state!)

      expect(digest).toHaveLength(3)
      expect(digest.map(d => d.index)).toEqual([0, 1, 2])
      expect(digest.map(d => d.summaryDone)).toEqual(['A', 'B', 'C'])
    })
  })

  describe('section completion and final audit transition', () => {
    test('completing all sections with digest matches totalSections', () => {
      insertLoop({ loop_name: 'transition-loop', total_sections: 2 })

      insertSectionPlan('transition-loop', 0, {
        title: 'Auth',
        status: 'completed',
        summaryDone: 'Auth complete',
        summaryDeviations: null,
        summaryFollowUps: null,
      })
      insertSectionPlan('transition-loop', 1, {
        title: 'API',
        status: 'completed',
        summaryDone: 'API complete',
        summaryDeviations: null,
        summaryFollowUps: null,
      })

      const state = loopService.getActiveState('transition-loop')
      const digest = loopService.getCompletedSectionDigest(state!)

      expect(digest.length).toBe(state!.totalSections)
      expect(digest.length).toBe(2)
    })

    test('buildFinalAuditPrompt after all sections include all summaries', () => {
      insertLoop({ loop_name: 'all-sections', total_sections: 2 })

      insertSectionPlan('all-sections', 0, {
        title: 'Module A',
        status: 'completed',
        summaryDone: 'Module A done',
        summaryDeviations: 'Module A deviation',
        summaryFollowUps: null,
      })
      insertSectionPlan('all-sections', 1, {
        title: 'Module B',
        status: 'completed',
        summaryDone: 'Module B done',
        summaryDeviations: null,
        summaryFollowUps: 'Module B follow-up',
      })

      const state = loopService.getActiveState('all-sections')
      const prompt = loopService.buildFinalAuditPrompt(state!)

      expect(prompt).toContain('Module A done')
      expect(prompt).toContain('Module A deviation')
      expect(prompt).toContain('Module B done')
      expect(prompt).toContain('Module B follow-up')
      expect(prompt).toContain('[Final integration audit]')
    })

    test('setPhaseAndResetError sets phase to final_auditing', () => {
      insertLoop({ loop_name: 'phase-loop', phase: 'coding' })

      loopService.setPhaseAndResetError('phase-loop', 'final_auditing')

      const state = loopService.getActiveState('phase-loop')
      expect(state!.phase).toBe('final_auditing')
      expect(state!.errorCount).toBe(0)
    })

    test('completeSection marks section as completed with summary', () => {
      insertLoop({ loop_name: 'complete-loop', total_sections: 2 })
      insertSectionPlan('complete-loop', 0, { status: 'in_progress' })

      loopService.completeSection('complete-loop', 0, {
        done: 'Section done text',
        deviations: 'Deviation text',
        followUps: 'Follow-up text',
      })

      const state = loopService.getActiveState('complete-loop')
      const digest = loopService.getCompletedSectionDigest(state!)

      expect(digest).toHaveLength(1)
      expect(digest[0].summaryDone).toBe('Section done text')
      expect(digest[0].summaryDeviations).toBe('Deviation text')
      expect(digest[0].summaryFollowUps).toBe('Follow-up text')
    })

    test('incrementSectionAttempts increments attempt counter', () => {
      insertLoop({ loop_name: 'attempts-loop', total_sections: 1 })
      insertSectionPlan('attempts-loop', 0, { status: 'in_progress', attempts: 0 })

      loopService.incrementSectionAttempts('attempts-loop', 0)

      const state = loopService.getActiveState('attempts-loop')
      const sectionPlan = loopService.getSectionPlan(state!, 0)
      expect(sectionPlan!.attempts).toBe(1)
    })
  })
})

