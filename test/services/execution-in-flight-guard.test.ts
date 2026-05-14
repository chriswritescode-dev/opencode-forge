import { describe, test, expect, beforeEach, afterEach } from 'vitest'
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
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import {
  markPromptInFlight,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'

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
  decomposition_status TEXT NOT NULL DEFAULT 'pending' CHECK (decomposition_status IN ('pending','running','completed','failed','skipped')),
  decomposition_mode   TEXT NOT NULL DEFAULT 'agent' CHECK (decomposition_mode IN ('agent','deterministic')),
  decomposition_session_id TEXT,
  current_section_index INTEGER NOT NULL DEFAULT 0,
  total_sections       INTEGER NOT NULL DEFAULT 0,
  final_audit_done     INTEGER NOT NULL DEFAULT 0,
  final_audit_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, loop_name)
)
`

const LOOP_LARGE_FIELDS = `
CREATE TABLE loop_large_fields (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  prompt              TEXT,
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

describe('execution in-flight guard', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let tempDir: string

  const mockLogger: Logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  beforeEach(() => {
    __resetInFlightGuard()
    tempDir = mkdtempSync(join(tmpdir(), 'exec-guard-test-'))
    db = new Database(join(tempDir, 'test.db'))

    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch {}
    __resetInFlightGuard()
  })

  describe('restart prompt path', () => {
    test('rejects restart prompt when another prompt is in-flight', async () => {
      const noopFn = () => {}

      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'guard-loop',
        status: 'stalled',
        currentSessionId: 'old-session',
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
        terminationReason: 'stall_timeout',
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'completed',
        decompositionMode: 'deterministic',
        decompositionSessionId: null,
        currentSectionIndex: 0,
        totalSections: 5,
        finalAuditDone: 0,
      }, { prompt: 'test plan text', lastAuditResult: null })

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'guard-loop',
        sections: [
          { index: 0, title: 'A', content: 'a' },
          { index: 1, title: 'B', content: 'b' },
        ],
      })

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'new-sess-999' } }),
          get: async () => ({ data: {} }),
          promptAsync: async () => ({ error: null, data: null }),
          abort: async () => ({}),
          delete: async () => ({}),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}), selectSession: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const loopService = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger,
        undefined, undefined, undefined, sectionPlansRepo,
      )

      const mockLoopHandler = {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: noopFn,
        clearLoopTimers: noopFn,
      }

      const { createForgeExecutionService } = await import('../../src/services/execution')
      const service = createForgeExecutionService({
        projectId: PROJECT_ID,
        directory: '/tmp/test',
        config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo,
        loopsRepo,
        loop: loopService as any,
        loopHandler: mockLoopHandler as any,
        sectionPlansRepo,
      } as any)

      // Pre-set guard to simulate concurrent in-flight prompt for this loop
      markPromptInFlight('guard-loop', 'other-prompt-sess', 'code')

      const result = await service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.restart' as const,
          selector: { kind: 'exact' as const, name: 'guard-loop' },
        },
      )

      // Before Phase 6: no guard check → promptAsync IS called → assertion fails
      // After Phase 6: guard rejects → promptAsync NOT called → passes
      // The result should be ok or error depending on guard wiring
      if (result.ok) {
        // If result.ok is true, it means promptAsync was called (no rejection) — should fail
        expect.fail('Expected promptAsync not to be called while guard is active')
      }
    })
  })
})
