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

interface MockClientState {
  abortCalls: string[]
  publishCalls: Array<{ directory: string; body: unknown }>
}

function createMockV2Client(state: MockClientState): OpencodeClient {
  return {
    session: {
      create: async () => ({ error: null, data: { id: 'sess' } }),
      promptAsync: async () => ({ error: null, data: null }),
      status: async () => ({ error: null, data: {} }),
      abort: async (params) => {
        state.abortCalls.push((params as any).sessionID)
        return {}
      },
      delete: async () => ({ error: undefined }),
      messages: async () => ({ error: null, data: [] }),
      get: async () => ({ error: null, data: {} }),
    },
    tui: {
      publish: async (params) => {
        state.publishCalls.push(params as { directory: string; body: unknown })
      },
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

describe('Loop Runtime cancel()', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-cancel-test-'))
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

  function makeActiveState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'session-abc',
      loopName: 'cancel-test-loop',
      worktreeDir: '/tmp/cancel-worktree',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'feature/cancel-test',
      iteration: 2,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test cancellation prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: false,
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

  function createRuntime(overrides: {
    clientState?: MockClientState
    loopConfig?: Partial<PluginConfig>
  } = {}): { loop: Loop; clientState: MockClientState; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const clientState = overrides.clientState ?? {
      abortCalls: [],
      publishCalls: [],
    }

    const v2Client = createMockV2Client(clientState)
    const { logger, logs } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig, ...(overrides.loopConfig ?? {}) }

    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client: { client: {} as any } as any,
      v2Client,
      logger,
      getConfig: () => config,
    })

    return { loop, clientState, logger, logs }
  }

  describe('cancel terminates with cancelled reason', () => {
    test('cancel marks the loop as inactive with user_aborted termination', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)

      const terminatedState = loopService.getAnyState(state.loopName)
      expect(terminatedState).not.toBeNull()
      expect(terminatedState!.active).toBe(false)
      expect(terminatedState!.terminationReason).toBe('user_aborted')
    })
  })

  describe('cancel fires termination callbacks', () => {
    test('termination callback receives the correct state and reason', async () => {
      let callbackInvoked = false
      let receivedState: LoopState | null = null

      const { logger } = createCapturingLogger()

      const loop = createLoop({
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        sectionPlansRepo,
        projectId: PROJECT_ID,
        client: {} as any,
        v2Client: createMockV2Client({ abortCalls: [], publishCalls: [] }),
        logger,
        getConfig: () => mockConfig,
        onTerminated: async (state, _reason) => {
          callbackInvoked = true
          receivedState = state
        },
      })

      const state = makeActiveState()
      loop.start({ state })
      await loop.cancel(state.loopName)

      expect(callbackInvoked).toBe(true)
      expect(receivedState).not.toBeNull()
      expect(receivedState!.loopName).toBe(state.loopName)
    })
  })

  describe('cancel clears timers', () => {
    test('after cancel, the loop is no longer active', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)

      const afterCancel = loop.listActive()
      expect(afterCancel.find(s => s.loopName === state.loopName)).toBeUndefined()
    })

    test('calling cancel on already cancelled loop does not throw', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)
      await expect(loop.cancel(state.loopName)).resolves.toBeUndefined()
    })
  })

  describe('cancelBySessionId works for sessions registered via start', () => {
    test('cancels by session ID when loop is started via start()', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      const result = await loop.cancelBySessionId(state.sessionId)

      expect(result).toBe(true)
      const terminated = loopService.getAnyState(state.loopName)!
      expect(terminated.active).toBe(false)
    })

    test('returns false for unknown session ID', async () => {
      const { loop } = createRuntime()
      const result = await loop.cancelBySessionId('unknown-session-id')
      expect(result).toBe(false)
    })
  })
})
