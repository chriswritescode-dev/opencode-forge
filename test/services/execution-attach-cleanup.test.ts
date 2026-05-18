import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'

const noopFn = () => {}

const DB_SCHEMA = `
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
  PRIMARY KEY (project_id, loop_name)
)
`

const LOOP_LARGE_FIELDS_SCHEMA = `
CREATE TABLE loop_large_fields (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  last_audit_result   TEXT,
  PRIMARY KEY (project_id, loop_name),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
)
`

const PLANS_SCHEMA = `
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
`

const REVIEW_FINDINGS_SCHEMA = `
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
`

const SECTION_PLANS_SCHEMA = `
CREATE TABLE section_plans (
  project_id TEXT NOT NULL,
  loop_name TEXT NOT NULL,
  section_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  summary_done TEXT,
  summary_deviations TEXT,
  summary_follow_ups TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, section_index)
)
`

const PROJECT_ID = 'test-project'

describe('attachLoopToSession', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attach-cleanup-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS_SCHEMA)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  function buildDeps() {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )

    const promptAsyncMock = vi.fn().mockResolvedValue({ error: null })
    const tuiSelectSessionMock = vi.fn().mockResolvedValue(undefined)

    const deps = {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      dataDir: '/tmp',
      v2: {
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'new-session' } }),
          get: vi.fn().mockResolvedValue({ data: {} }),
          update: vi.fn().mockResolvedValue({ data: {} }),
          promptAsync: promptAsyncMock,
          abort: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
        tui: {
          publish: vi.fn(),
          selectSession: tuiSelectSessionMock,
        },
      },
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loop: loopService as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(),
        clearLoopTimers: noopFn,
      },
      sandboxManager: null,
      workspaceStatusRegistry: {
        recordEvent: vi.fn(),
        getStatus: vi.fn().mockReturnValue('connected' as const),
        awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
        primeFromSnapshot: vi.fn(),
      },
    }

    return { deps, loopsRepo, plansRepo, sectionPlansRepo, reviewFindingsRepo, loopService }
  }

  test('attachLoopToSession purges orphaned per-loop rows even when no loops row exists', async () => {
    const { deps, sectionPlansRepo, plansRepo, reviewFindingsRepo } = buildDeps()

    const LOOP_NAME = 'orphan-loop'

    // Seed orphaned section_plans for the loop (no loops row exists)
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, title: 'Stale section', content: '# Stale\n\nStale content.' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, LOOP_NAME, 0, 'in_progress')

    // Seed orphaned plan for the loop
    plansRepo.writeForLoop(PROJECT_ID, LOOP_NAME, 'STALE_PLAN_CONTENT')

    // Seed orphaned review findings for the loop
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      file: 'a.ts',
      line: 1,
      severity: 'bug' as const,
      description: 'stale finding',
    })

    // Verify seed data is present before attach
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(1)
    expect(plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)).not.toBeNull()
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME).length).toBeGreaterThan(0)

    // Confirm no loops row exists for orphan-loop (simulating orphan state)
    const existingLoop = deps.loopsRepo.get(PROJECT_ID, LOOP_NAME)
    expect(existingLoop).toBeNull()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_fresh',
        workspaceId: 'ws_fresh',
        worktreeDir: '/tmp/wt/fresh',
        loopName: LOOP_NAME,
        displayName: 'Orphan Loop',
        executionName: LOOP_NAME,
        maxIterations: 50,
        sandboxEnabled: false,
        planText: 'NEW_PLAN',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    // Attach should succeed (no existing running loop)
    expect(result.ok).toBe(true)

    // --- Assertions that MUST fail today ---
    // Today: no purge logic exists, so the orphaned rows remain.
    // After Phase 6: these should pass once defensive purge is added.
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(0)
    // Plan row is rewritten by setState from the new plan text ('NEW_PLAN')
    const planAfterAttach = plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)
    expect(planAfterAttach).not.toBeNull()
    expect(planAfterAttach!.content).toBe('NEW_PLAN')
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME)).toEqual([])
  })
})
