import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop, type LoopRuntimeDeps } from '../../src/loop/runtime'
import { sessionsAwaitingBusy } from '../../src/loop/idle-gate'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

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

function createMockV2Client(): OpencodeClient {
  return {
    session: {
      create: async () => ({ error: null, data: { id: 'sess' } }),
      promptAsync: async () => ({ error: null, data: null }),
      status: async () => ({ error: null, data: {} }),
      abort: async () => ({}),
      delete: async () => ({ error: undefined }),
      messages: async () => ({ error: null, data: [] }),
      get: async () => ({ error: null, data: {} }),
    },
    tui: {
      publish: async () => {},
      selectSession: async () => {},
    },
    worktree: {
      create: async () => ({ error: null, data: { directory: '/tmp/wt', branch: 'b' } }),
      remove: async () => {},
    },
  } as unknown as OpencodeClient
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

const LOOP_LARGE_FIELDS_SCHEMA = `
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

    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS_SCHEMA)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)

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
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
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
      client: {} as any,
      v2Client: createMockV2Client(),
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

    test('writes correct decomposition settings', () => {
      const { loop } = createRuntime()
      const state = makeState({
        decompositionStatus: 'pending',
        decompositionMode: 'agent',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.decompositionStatus).toBe('pending')
      expect(persisted.decompositionMode).toBe('agent')
      expect(persisted.phase).toBe('decomposing')
    })

  })

  describe('start derives initial phase from decomposition settings', () => {
    test('sets phase to decomposing for agent decomposition mode with pending status', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'agent',
        decompositionStatus: 'pending',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('decomposing')
    })

    test('sets phase to decomposing for agent decomposition mode with running status', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'agent',
        decompositionStatus: 'running',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('decomposing')
    })

    test('keeps phase as coding for deterministic decomposition with completed status', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'deterministic',
        decompositionStatus: 'completed',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

    test('keeps phase as coding for deterministic decomposition with pending status', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'deterministic',
        decompositionStatus: 'pending',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

    test('keeps phase as coding when decomposition is skipped', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'agent',
        decompositionStatus: 'skipped',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

    test('preserves explicitly provided decomposing phase for agent decomposer', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'decomposing',
        decompositionMode: 'agent',
        decompositionStatus: 'running',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('decomposing')
      expect(persisted.decompositionStatus).toBe('running')
    })
  })

  describe('start generates unique loop names', () => {
    test('allows multiple distinct loop names', () => {
      const { loop } = createRuntime()

      const state1 = makeState({ loopName: 'loop-alpha' })
      const state2 = makeState({ loopName: 'loop-beta' })

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
      const s2 = makeState({ loopName: 'loop-1' })
      const s3 = makeState({ loopName: 'loop-2' })
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

  describe('plan-approval path delegates phase derivation via start()', () => {
    test('loop.start() sets phase to decomposing when called with agent decomposition state', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'agent',
        decompositionStatus: 'running',
        decompositionSessionId: null,
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('decomposing')
      expect(persisted.decompositionMode).toBe('agent')
      expect(persisted.decompositionStatus).toBe('running')
    })

    test('loop.start() preserves phase as coding when called with deterministic decomposition state', () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
        decompositionMode: 'deterministic',
        decompositionStatus: 'completed',
        totalSections: 5,
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

  })
})
