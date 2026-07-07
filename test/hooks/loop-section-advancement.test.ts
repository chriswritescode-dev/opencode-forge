import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoopEventHandler } from '../../src/hooks/loop'
import type { Logger, PluginConfig } from '../../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('Loop Section Advancement', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-section-advancement-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)

    db.run(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
        session_directory    TEXT,
        worktree_branch      TEXT,
        project_dir          TEXT NOT NULL,
        max_iterations       INTEGER NOT NULL,
        iteration            INTEGER NOT NULL DEFAULT 0,
        audit_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        phase                TEXT NOT NULL,
        execution_model      TEXT,
        auditor_model        TEXT,
        model_failed         INTEGER NOT NULL DEFAULT 0,
        sandbox              INTEGER NOT NULL DEFAULT 0,
        sandbox_container    TEXT,
        started_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        termination_reason   TEXT,
        completion_summary   TEXT,
        workspace_id         TEXT,
        host_session_id      TEXT,
        audit_session_id     TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections       INTEGER NOT NULL DEFAULT 0,
        final_audit_done     INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        execution_variant    TEXT,
        auditor_variant      TEXT,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        last_audit_result   TEXT,
        post_action_report  TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.run(`
      CREATE TABLE plans (
        project_id   TEXT NOT NULL,
        loop_name    TEXT,
        session_id   TEXT,
        content      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
        CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
        UNIQUE (project_id, loop_name),
        UNIQUE (project_id, session_id)
      )
    `)

    db.run(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)

    db.run(`
      CREATE TABLE section_plans (
        project_id    TEXT    NOT NULL,
        loop_name     TEXT    NOT NULL,
        section_index INTEGER NOT NULL,
        title         TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        started_at    INTEGER,
        completed_at  INTEGER,
        summary_done           TEXT,
        summary_deviations     TEXT,
        summary_follow_ups     TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(overrides: Record<string, any> = {}) {
    const defaults = {
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
      final_audit_attempts: 0,
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
      [projectId, 'test-loop', index, title, content, status, 0, Date.now()]
    )
  }

  describe('1. Section advancement from one to next', () => {
    test('setCurrentSectionIndex increments to next section and startSection marks it as in_progress', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'pending')
      insertSectionPlan(2, 'Section 3', 'Content 3', 'pending')

      // Simulate the hook logic: advance from section 0 to section 1
      const nextIdx = 1
      loopService.setCurrentSectionIndex('test-loop', nextIdx)
      loopService.startSection('test-loop', nextIdx)

      const state = loopService.getActiveState('test-loop')
      expect(state).not.toBeNull()
      expect(state!.currentSectionIndex).toBe(1)

      const section = loopService.getSectionPlan(state!, 1)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('in_progress')
      expect(section!.startedAt).not.toBeNull()
    })

    test('setCurrentSectionIndex works for advancing multiple sections', () => {
      insertLoop({ total_sections: 5 })
      for (let i = 0; i < 5; i++) {
        insertSectionPlan(i, `Section ${i + 1}`, `Content ${i + 1}`)
      }

      // Advance through sections
      for (let i = 0; i < 5; i++) {
        loopService.setCurrentSectionIndex('test-loop', i)
        loopService.startSection('test-loop', i)
      }

      const state = loopService.getActiveState('test-loop')!
      expect(state.currentSectionIndex).toBe(4)

      // Verify all sections were started
      for (let i = 0; i < 5; i++) {
        const plan = loopService.getSectionPlan(state, i)
        expect(plan!.status).toBe('in_progress')
      }
    })
  })

  describe('2. Last section transition to final audit', () => {
    test('when last section is completed, setPhaseAndResetError transitions to final_auditing', () => {
      insertLoop({ phase: 'coding', total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'completed')

      loopService.setPhaseAndResetError('test-loop', 'final_auditing')

      const state = loopService.getActiveState('test-loop')
      expect(state).not.toBeNull()
      expect(state!.phase).toBe('final_auditing')
      expect(state!.errorCount).toBe(0)
    })

    test('setFinalAuditDone marks final audit complete', () => {
      insertLoop({ phase: 'final_auditing' })

      loopService.setFinalAuditDone('test-loop', true)

      const state = loopService.getActiveState('test-loop')!
      expect(state.finalAuditDone).toBe(true)
    })

  })

  describe('3. Section completion updates status', () => {
    test('completeSection sets status to completed and writes summary fields', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')

      loopService.completeSection('test-loop', 0, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Handled in section 2',
      })

      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBe('Implemented feature X')
      expect(section!.summaryDeviations).toBe('None')
      expect(section!.summaryFollowUps).toBe('Handled in section 2')
      expect(section!.completedAt).not.toBeNull()
    })

    test('completeSection works with null summary fields', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')

      loopService.completeSection('test-loop', 0, {
        done: null,
        deviations: null,
        followUps: null,
      })

      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBeNull()
      expect(section!.summaryDeviations).toBeNull()
      expect(section!.summaryFollowUps).toBeNull()
      expect(section!.completedAt).not.toBeNull()
    })
  })

  describe('4. Section retry on dirty audit', () => {
    test('incrementSectionAttempts increments attempts counter', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!.attempts).toBe(1)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!.attempts).toBe(2)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!.attempts).toBe(3)
    })

    test('section retry does not change section index', () => {
      insertLoop({ current_section_index: 1 })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'in_progress')
      insertSectionPlan(2, 'Section 3', 'Content 3', 'pending')

      // Retry increments attempts but should not change section index
      loopService.incrementSectionAttempts('test-loop', 1)

      const state = loopService.getActiveState('test-loop')!
      expect(state.currentSectionIndex).toBe(1)
      expect(state.totalSections).toBe(3)
    })
  })

  describe('5. Section summary parsing', () => {
    test('parseSectionSummary extracts Done, Deviations, Follow-ups', () => {
      const text = `<!-- section-summary:start -->
### Done
- Implemented feature X
### Deviations
- None
### Follow-ups
- Handled in section 2
<!-- section-summary:end -->`

      const result = loopService.parseSectionSummary(text)
      expect(result).not.toBeNull()
      expect(result!.done).toContain('Implemented feature X')
      expect(result!.deviations).toContain('None')
      expect(result!.followUps).toContain('Handled in section 2')
    })

    test('parseSectionSummary returns null when no section summary marker', () => {
      const result = loopService.parseSectionSummary('No summary here')
      expect(result).toBeNull()
    })

    test('parseSectionSummary handles partial markers', () => {
      const text = `<!-- section-summary:start -->
### Done
- Completed work
<!-- section-summary:end -->`

      const result = loopService.parseSectionSummary(text)
      expect(result).not.toBeNull()
      expect(result!.done).toContain('Completed work')
      expect(result!.deviations).toBeNull()
      expect(result!.followUps).toBeNull()
    })

    test('parseSectionSummary handles multiline content', () => {
      const text = `<!-- section-summary:start -->
### Done
- Implemented feature A
- Fixed bug B
### Deviations
- Skipped optional step C
- Reason: not required
### Follow-ups
- Defer to section 3
- Add test coverage
<!-- section-summary:end -->`

      const result = loopService.parseSectionSummary(text)
      expect(result).not.toBeNull()
      expect(result!.done).toContain('Implemented feature A')
      expect(result!.done).toContain('Fixed bug B')
      expect(result!.deviations).toContain('Skipped optional step C')
      expect(result!.followUps).toContain('Defer to section 3')
    })
  })

  describe('6. Completed section digest', () => {
    test('getCompletedSectionDigest returns correct digest with done/deviations/follow-ups', () => {
      insertLoop({ total_sections: 3 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')
      insertSectionPlan(2, 'Section 3', 'Content 3')

      loopService.startSection('test-loop', 0)
      loopService.completeSection('test-loop', 0, {
        done: 'Feature A implemented',
        deviations: 'None',
        followUps: 'Deferred item',
      })

      loopService.startSection('test-loop', 1)
      loopService.completeSection('test-loop', 1, {
        done: 'Feature B implemented',
        deviations: 'Minor deviation',
        followUps: null,
      })

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest).toHaveLength(2)
      expect(digest[0].title).toBe('Section 1')
      expect(digest[0].summaryDone).toBe('Feature A implemented')
      expect(digest[0].summaryDeviations).toBe('None')
      expect(digest[0].summaryFollowUps).toBe('Deferred item')
      expect(digest[1].title).toBe('Section 2')
      expect(digest[1].summaryDone).toBe('Feature B implemented')
      expect(digest[1].summaryDeviations).toBe('Minor deviation')
      expect(digest[1].summaryFollowUps).toBeNull()
    })

    test('getCompletedSectionDigest returns empty when no sections completed', () => {
      insertLoop({ total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest).toHaveLength(0)
    })
  })

  describe('7. All sections completed check', () => {
    test('after all sections complete, completed count equals totalSections', () => {
      insertLoop({ total_sections: 3 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')
      insertSectionPlan(2, 'Section 3', 'Content 3')

      // Complete all 3 sections
      for (let i = 0; i < 3; i++) {
        loopService.startSection('test-loop', i)
        loopService.completeSection('test-loop', i, {
          done: `Done ${i}`,
          deviations: null,
          followUps: null,
        })
      }

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest.length).toBe(state.totalSections)
      expect(digest.length).toBe(3)
    })

    test('partial completion count is less than totalSections', () => {
      insertLoop({ total_sections: 3 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')
      insertSectionPlan(2, 'Section 3', 'Content 3')

      loopService.startSection('test-loop', 0)
      loopService.completeSection('test-loop', 0, {
        done: 'Done 0',
        deviations: null,
        followUps: null,
      })

      loopService.startSection('test-loop', 1)
      loopService.completeSection('test-loop', 1, {
        done: 'Done 1',
        deviations: null,
        followUps: null,
      })

      const state = loopService.getActiveState('test-loop')!
      const digest = loopService.getCompletedSectionDigest(state)

      expect(digest.length).toBe(2)
      expect(digest.length).toBeLessThan(state.totalSections)
    })

    test('can detect all completed after rewind scenario', () => {
      insertLoop({ total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')

      // Complete both sections after rewind
      loopService.startSection('test-loop', 0)
      loopService.completeSection('test-loop', 0, {
        done: 'Done 0',
        deviations: null,
        followUps: null,
      })

      loopService.startSection('test-loop', 1)
      loopService.completeSection('test-loop', 1, {
        done: 'Done 1',
        deviations: null,
        followUps: null,
      })

      const state = loopService.getActiveState('test-loop')!
      const allCompleted = loopService.getCompletedSectionDigest(state).length === state.totalSections
      expect(allCompleted).toBe(true)
    })
  })

  describe('8. Reset for rewind', () => {
    test('resetSectionForRewind resets section state', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      loopService.completeSection('test-loop', 0, {
        done: 'old done',
        deviations: 'old dev',
        followUps: 'old follow',
      })

      loopService.resetSectionForRewind('test-loop', 0)

      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('in_progress')
      expect(section!.attempts).toBe(0)
      expect(section!.summaryDone).toBeNull()
      expect(section!.summaryDeviations).toBeNull()
      expect(section!.summaryFollowUps).toBeNull()
      expect(section!.completedAt).toBeNull()
    })

    test('resetSectionForRewind clears summaries even with non-null values', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      loopService.completeSection('test-loop', 0, {
        done: 'Feature implemented',
        deviations: 'Some deviation',
        followUps: 'Some follow-up',
      })

      // Verify it has summaries before reset
      let section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!
      expect(section.summaryDone).toBe('Feature implemented')
      expect(section.summaryDeviations).toBe('Some deviation')
      expect(section.summaryFollowUps).toBe('Some follow-up')

      loopService.resetSectionForRewind('test-loop', 0)

      section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!
      expect(section.summaryDone).toBeNull()
      expect(section.summaryDeviations).toBeNull()
      expect(section.summaryFollowUps).toBeNull()
      expect(section.status).toBe('in_progress')
    })
  })

  describe('Cross-cutting: audit result storage', () => {
    test('setLastAuditResult persists audit text in large fields', () => {
      insertLoop()
      loopService.setLastAuditResult('test-loop', 'Section looks good')

      const state = loopService.getActiveState('test-loop')!
      expect(state.lastAuditResult).toBe('Section looks good')
    })

    test('setLastAuditResult ignores empty string', () => {
      insertLoop()
      loopService.setLastAuditResult('test-loop', '')

      const state = loopService.getActiveState('test-loop')!
      expect(state.lastAuditResult).toBeUndefined()
    })

    test('clearLastAuditResult removes stored audit text', () => {
      insertLoop()
      loopService.setLastAuditResult('test-loop', 'Some text')
      loopService.clearLastAuditResult('test-loop')

      const state = loopService.getActiveState('test-loop')!
      expect(state.lastAuditResult).toBeUndefined()
    })
  })

  describe('Cross-cutting: section prompts include correct context', () => {
    test('buildSectionInitialPrompt includes completed section digest', () => {
      insertLoop({ total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')

      loopService.startSection('test-loop', 0)
      loopService.completeSection('test-loop', 0, {
        done: 'Completed section 0',
        deviations: 'None',
        followUps: 'Deferred item',
      })
      loopService.startSection('test-loop', 1)

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Prior Sections')
      expect(prompt).toContain('Completed section 0')
    })

    test('buildSectionContinuationPrompt includes outstanding findings', () => {
      insertLoop({ total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')
      insertSectionPlan(1, 'Section 2', 'Content 2')

      reviewFindingsRepo.write({
        projectId,
        file: 'src/test.ts',
        line: 10,
        severity: 'bug',
        description: 'Test bug',
        loopName: 'test-loop',
        sectionIndex: 0,
      })

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'audit text')
      expect(prompt).toContain('Outstanding findings')
      expect(prompt).toContain('src/test.ts:10')
    })
  })

  describe('Edge cases', () => {
    test('completeSection on non-existent section is no-op', () => {
      insertLoop({ total_sections: 2 })
      insertSectionPlan(0, 'Section 1', 'Content 1')
      insertSectionPlan(1, 'Section 2', 'Content 2')

      // Should not throw when completing non-existent section
      loopService.completeSection('test-loop', 5, {
        done: 'phantom done',
        deviations: null,
        followUps: null,
      })

      // Original sections unchanged
      const state = loopService.getActiveState('test-loop')!
      expect(loopService.getSectionPlan(state, 0)!.status).toBe('pending')
      expect(loopService.getSectionPlan(state, 1)!.status).toBe('pending')
    })

    test('incrementSectionAttempts on non-existent section is no-op', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1')

      loopService.incrementSectionAttempts('test-loop', 5)

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.getSectionPlan(state, 0)!.attempts).toBe(0)
    })

    test('resetSectionForRewind on non-existent section is no-op', () => {
      insertLoop()
      insertSectionPlan(0, 'Section 1', 'Content 1', 'pending')

      loopService.resetSectionForRewind('test-loop', 5)

      const state = loopService.getActiveState('test-loop')!
      expect(loopService.getSectionPlan(state, 0)!.status).toBe('pending')
    })
  })
})

