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
import { createLoop, type Loop } from '../../src/loop/runtime'
import { sessionsAwaitingBusy } from '../../src/loop/idle-gate'
import type { Logger, PluginConfig } from '../../src/types'
import type { ForgeClient } from '../../src/client/port'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

function createMockForgeClient(): ForgeClient {
  return {
    session: {
      create: async () => ({ id: 'sess' }) as any,
      promptAsync: async () => {},
      status: async () => ({}) as any,
      abort: async () => {},
      delete: async () => {},
      messages: async () => [],
      get: async () => ({}) as any,
      update: async () => {},
    },
    workspace: {
      create: async () => ({ id: '', directory: '/tmp/wt', branch: 'b' }) as any,
      list: async () => [],
      status: async () => ({}) as any,
      syncList: async () => {},
      remove: async () => {},
      warp: async () => {},
    },
    tui: {
      publish: async () => {},
      selectSession: async () => {},
    },
    sync: {
      start: async () => {},
    },
  }
}

function createCapturingLogger(): { logger: Logger; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = []
  const logger: Logger = {
    log: (msg: string) => logs.push({ level: 'log', message: msg }),
    error: (msg: string) => logs.push({ level: 'error', message: msg }),
    debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
  }
  return { logger, logs }
}

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
  post_action_report  TEXT,
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

describe('Loop Runtime start()', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-start-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} },
      undefined,
      undefined,
      sectionPlansRepo,
    )

    sessionsAwaitingBusy.clear()
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
    sessionsAwaitingBusy.clear()
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'session-123',
      loopName: 'test-loop',
      worktreeDir: '/tmp/test-worktree',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'test/branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      ...overrides,
    }
  }

  function createRuntime(): { loop: Loop; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const { logger, logs } = createCapturingLogger()
    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client: createMockForgeClient(),
      logger,
      getConfig: () => mockConfig,
    })
    return { loop, logger, logs }
  }

  describe('start writes initial state correctly', () => {
    test('persists active loop state via setState and registerLoopSession', () => {
      const { loop } = createRuntime()
      const state = makeState()

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)
      expect(persisted).not.toBeNull()
      expect(persisted!.active).toBe(true)
      expect(persisted!.sessionId).toBe(state.sessionId)
      expect(persisted!.loopName).toBe(state.loopName)
      expect(persisted!.worktreeDir).toBe(state.worktreeDir)
      expect(persisted!.phase).toBe('coding')
      expect(persisted!.iteration).toBe(1)
      expect(persisted!.maxIterations).toBe(5)
    })

    test('loop start always begins in phase=coding regardless of plan content', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

  })

  describe('start generates unique loop names', () => {
    test('allows multiple distinct loop names', () => {
      const { loop } = createRuntime()

      const state1 = makeState({ loopName: 'loop-alpha' })
      const state2 = makeState({ loopName: 'loop-beta', sessionId: 'session-beta' })

      loop.start({ state: state1 })
      loop.start({ state: state2 })

      const alpha = loopService.getAnyState('loop-alpha')
      const beta = loopService.getAnyState('loop-beta')

      expect(alpha).not.toBeNull()
      expect(beta).not.toBeNull()
      expect(alpha!.loopName).not.toBe(beta!.loopName)
    })

    test('does not overwrite existing loop when starting with a duplicate name', () => {
      const { loop, logs } = createRuntime()

      const existingState = makeState({ loopName: 'my-loop' })
      loop.start({ state: existingState })

      const existing = loopService.getAnyState('my-loop')
      expect(existing).not.toBeNull()
      expect(existing!.active).toBe(true)

      const duplicateState = makeState({
        loopName: 'my-loop',
        sessionId: 'session-duplicate',
        iteration: 5,
      })
      loop.start({ state: duplicateState })

      const originalAfterDuplicate = loopService.getAnyState('my-loop')
      expect(originalAfterDuplicate).not.toBeNull()
      expect(originalAfterDuplicate!.sessionId).toBe(existingState.sessionId)
      expect(originalAfterDuplicate!.iteration).toBe(1)

      const renamed = loopService.getAnyState('my-loop-1')
      expect(renamed).not.toBeNull()
      expect(renamed!.sessionId).toBe(duplicateState.sessionId)

      expect(logs.some(l => l.message.includes('auto-renamed to my-loop-1'))).toBe(true)
    })
  })

  describe('start records activity log', () => {
    test('logs the start operation', () => {
      const { loop, logs } = createRuntime()
      const state = makeState()

      loop.start({ state })

      expect(logs.some(l => l.message.includes('started loop='))).toBe(true)
      expect(logs.some(l => l.message.includes(state.loopName))).toBe(true)
    })
  })

  describe('generateUniqueLoopName returns unique names', () => {
    test('returns base name when no conflicts exist', () => {
      const { loop } = createRuntime()
      const result = loop.generateUniqueLoopName('fresh-name')
      expect(result).toBe('fresh-name')
    })

    test('returns suffixed name when base name already exists', () => {
      const { loop } = createRuntime()
      const state1 = makeState({ loopName: 'taken' })
      loop.start({ state: state1 })

      const result = loop.generateUniqueLoopName('taken')
      expect(result).toBe('taken-1')
    })

    test('increments counter through multiple conflicts', () => {
      const { loop } = createRuntime()

      const s1 = makeState({ loopName: 'loop' })
      const s2 = makeState({ loopName: 'loop-1', sessionId: 'session-loop-1' })
      const s3 = makeState({ loopName: 'loop-2', sessionId: 'session-loop-2' })
      loop.start({ state: s1 })
      loop.start({ state: s2 })
      loop.start({ state: s3 })

      const result = loop.generateUniqueLoopName('loop')
      expect(result).toBe('loop-3')
    })
  })

  describe('start enables listing by loop name', () => {
    test('started loop appears in listActive after start', () => {
      const { loop } = createRuntime()
      const state = makeState()

      loop.start({ state })

      const active = loop.listActive()
      expect(active.length).toBeGreaterThanOrEqual(1)
      expect(active.find(s => s.loopName === state.loopName)).toBeDefined()
    })
  })
})
