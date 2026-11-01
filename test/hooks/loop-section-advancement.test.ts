import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { formatAuditHandoffResult } from '../../src/loop/handoff'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createTestDb } from '../helpers/test-db'
import { createMockLogger } from '../helpers/logger'
import { recordAuditorHandoff } from '../helpers/loop-handoff'

const mockLogger = createMockLogger()

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

const CLEAN_AUDIT_SUMMARY = { done: ['completed section 1 cleanly'], deviations: [], followUps: [] }

const assistantMessage = (text: string) => [
  {
    info: { role: 'assistant', finish: 'stop' },
    parts: [{ type: 'text' as const, text }],
  },
]

describe('Loop Section Advancement', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-section-advancement-test-'))
    testDb = createTestDb()
    db = testDb.db

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo, loopTransitionsRepo)
  })

  afterEach(() => {
    testDb.cleanup()
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

  describe('Section checkpoint commits', () => {
    function createFakeGitService(overrides: { statusStdout?: string } = {}) {
      const commits: Array<{ cwd: string; message: string }> = []
      const ok = { ok: true, status: 0, stdout: '', stderr: '' }
      const git = {
        addAll: () => ({ ...ok }),
        statusPorcelain: () => ({ ...ok, stdout: overrides.statusStdout ?? ' M src/file.ts' }),
        commit: (cwd: string, message: string) => {
          commits.push({ cwd, message })
          return { ...ok }
        },
        isPathTracked: () => false,
      } as unknown as import('../../src/utils/git-service').GitService
      return { git, commits }
    }

    function buildHandler(gitService: import('../../src/utils/git-service').GitService) {
      const { client: forgeClient } = createFakeForgeClient({
        session: { messages: async () => assistantMessage('audit complete') },
      })
      return createLoopEventHandler(
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        projectId,
        forgeClient,
        mockLogger,
        () => mockConfig,
        undefined,
        tempDir,
        undefined,
        sectionPlansRepo,
        undefined,
        undefined,
        undefined,
        loopTransitionsRepo,
        undefined,
        undefined,
        gitService,
      )
    }

    test('a clean section advance commits a "section N: title" checkpoint in the worktree', async () => {
      insertLoop({ phase: 'auditing', current_section_index: 0, total_sections: 2, worktree_dir: tempDir })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'pending')

      const { git, commits } = createFakeGitService()
      const handler = buildHandler(git)
      await recordAuditorHandoff(handler.loop, 'sess-1', { summary: CLEAN_AUDIT_SUMMARY })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { status: { type: 'idle' }, sessionID: 'sess-1' },
        },
      })

      expect(commits).toHaveLength(1)
      expect(commits[0].cwd).toBe(tempDir)
      expect(commits[0].message).toBe('section 1: Section 1')

      handler.clearAllRetryTimeouts()
    })

    test('no checkpoint commit when the worktree has no pending changes', async () => {
      insertLoop({ phase: 'auditing', current_section_index: 0, total_sections: 2, worktree_dir: tempDir })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'pending')

      const { git, commits } = createFakeGitService({ statusStdout: '' })
      const handler = buildHandler(git)
      await recordAuditorHandoff(handler.loop, 'sess-1', { summary: CLEAN_AUDIT_SUMMARY })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { status: { type: 'idle' }, sessionID: 'sess-1' },
        },
      })

      expect(commits).toHaveLength(0)

      // The section still advanced — the checkpoint is bookkeeping, not a gate.
      const after = loopService.getActiveState('test-loop')!
      expect(after.currentSectionIndex).toBe(1)

      handler.clearAllRetryTimeouts()
    })

    test('a clean auditor handoff with a summary completes the section with that summary and records the rendered handoff result', async () => {
      insertLoop({ phase: 'auditing', current_section_index: 0, total_sections: 2, worktree_dir: tempDir })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'pending')

      const { git } = createFakeGitService()
      const handler = buildHandler(git)
      const payload = {
        summary: {
          done: ['Implemented the section'],
          deviations: ['Skipped the optional flag'],
          followUps: ['Add coverage in a later section'],
        },
        notes: 'Checked the section acceptance criteria.',
      }
      await recordAuditorHandoff(handler.loop, 'sess-1', payload)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { status: { type: 'idle' }, sessionID: 'sess-1' },
        },
      })

      const section = loopService.getSectionPlan(loopService.getActiveState('test-loop')!, 0)!
      expect(section.status).toBe('completed')
      expect(section.summaryDone).toBe('- Implemented the section')
      expect(section.summaryDeviations).toBe('- Skipped the optional flag')
      expect(section.summaryFollowUps).toBe('- Add coverage in a later section')

      const after = loopService.getActiveState('test-loop')!
      expect(after.lastAuditResult).toBe(formatAuditHandoffResult(payload, {
        clean: true,
        blockingBugs: 0,
        sectionIndex: 0,
      }))

      handler.clearAllRetryTimeouts()
    })
  })

  describe('Cross-cutting: persisted transition log', () => {
    /**
     * Drive the real runtime via createLoopEventHandler and assert that each
     * phase change/termination lands a row in loop_transitions. These tests
     * intentionally do NOT call loopService.recordTransition directly: a
     * regression that strips runtime logging would fail them, not silently
     * pass.
     */
    test('a clean section advance via the runtime records an auditor-handoff/advance-section row', async () => {
      insertLoop({ phase: 'auditing', current_section_index: 0, total_sections: 2, iteration: 1, max_iterations: 5 })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'in_progress')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'pending')

      // Build a handler bound to the same DB so the runtime writes transition
      // rows into the shared loop_transitions_repo.
      const { client: forgeClient } = createFakeForgeClient({
        session: { messages: async () => assistantMessage('audit complete') },
      })
      const handler = createLoopEventHandler(
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        projectId,
        forgeClient,
        mockLogger,
        () => mockConfig,
        undefined,
        tempDir,
        undefined,
        sectionPlansRepo,
        undefined,
        undefined,
        undefined,
        loopTransitionsRepo,
      )

      await recordAuditorHandoff(handler.loop, 'sess-1', { summary: CLEAN_AUDIT_SUMMARY })

      // The persisted loops row's current_session_id is 'sess-1' (insertLoop
      // default) so the idle event resolves to this loop via getBySessionId.
      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { status: { type: 'idle' }, sessionID: 'sess-1' },
        },
      })

      const rows = loopTransitionsRepo.listForLoop(projectId, 'test-loop')
      expect(rows).toHaveLength(1)
      expect(rows[0].eventType).toBe('auditor-handoff')
      expect(rows[0].transitionKind).toBe('advance-section')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      // recordTransitionEntry uses the pre-transition snapshot: iteration=1,
      // currentSectionIndex=0 (the section that was just audited clean).
      expect(rows[0].iteration).toBe(1)
      expect(rows[0].sectionIndex).toBe(0)

      // The runtime actually advanced the persisted section pointer too.
      const after = loopService.getActiveState('test-loop')!
      expect(after.currentSectionIndex).toBe(1)
      expect(after.phase).toBe('coding')

      handler.clearAllRetryTimeouts()
    })

    test('a runtime max-iterations termination records exactly one terminate row', async () => {
      // iteration=1, maxIterations=1 → the very next iteration cap fires.
      insertLoop({ phase: 'auditing', current_section_index: 1, total_sections: 2, iteration: 1, max_iterations: 1 })
      insertSectionPlan(0, 'Section 1', 'Content 1', 'completed')
      insertSectionPlan(1, 'Section 2', 'Content 2', 'in_progress')
      // An outstanding bug finding makes the audit genuinely dirty.
      reviewFindingsRepo.write({
        projectId,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Found an issue',
        loopName: 'test-loop',
        sectionIndex: 1,
      })

      // A dirty auditor handoff routes through the section-dirty branch, which
      // calls nextIterationOrTerminate; the cap terminates the loop without
      // first logging a rotate row.
      const { client: forgeClient, calls } = createFakeForgeClient({
        session: { messages: async () => assistantMessage('dirty audit: found issues') },
      })
      const handler = createLoopEventHandler(
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        projectId,
        forgeClient,
        mockLogger,
        () => mockConfig,
        undefined,
        tempDir,
        undefined,
        sectionPlansRepo,
        undefined,
        undefined,
        undefined,
        loopTransitionsRepo,
      )

      await recordAuditorHandoff(handler.loop, 'sess-1')

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { status: { type: 'idle' }, sessionID: 'sess-1' },
        },
      })

      const rows = loopTransitionsRepo.listForLoop(projectId, 'test-loop')
      expect(rows).toHaveLength(1)
      expect(rows[0].transitionKind).toBe('terminate')
      expect(rows[0].eventType).toBe('max_iterations')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBeNull()
      // terminationStatusFor('max_iterations') falls through to 'errored'.
      expect(rows[0].status).toBe('errored')
      expect(rows[0].reason).toBe('max_iterations')
      expect(rows[0].iteration).toBe(1)
      expect(rows[0].sectionIndex).toBe(1)

      // The loop is persisted as terminated.
      const after = loopService.getAnyState('test-loop')!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('max_iterations')

      // A capped dirty audit sends no coder retry prompt and keeps the finding.
      const retryPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code',
      )
      expect(retryPrompts.length).toBe(0)
      const retained = reviewFindingsRepo.listByLoopName(projectId, 'test-loop')
      expect(retained.some((f) => f.severity === 'bug')).toBe(true)

      handler.clearAllRetryTimeouts()
    })
  })
})
