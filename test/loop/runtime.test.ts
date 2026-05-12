import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
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
import type { Logger, PluginConfig, LoopConfig } from '../../src/types'
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
  createCalls: Array<Record<string, unknown>>
  deleteCalls: Array<{ sessionID: string; directory: string }>
  publishCalls: Array<{ directory: string; body: unknown }>
  selectCalls: Array<{ sessionID: string; workspace?: string }>
  deleteThrows: boolean
  abortCalls: string[]
  promptCalls: Array<{ sessionID: string; agent?: string }>
  messagesResult: Array<{ info: { role: string; finish?: string }; parts: Array<{ type: string; text?: string }> }> | null
}

function createMockV2Client(state: MockClientState): OpencodeClient {
  return {
    session: {
      create: async (params) => {
        state.createCalls.push(params as Record<string, unknown>)
        return { error: null, data: { id: 'sess' } }
      },
      promptAsync: async (params) => {
        state.promptCalls.push({ sessionID: (params as any).sessionID ?? '', agent: (params as any).agent })
        return { error: null, data: null }
      },
      status: async () => ({ error: null, data: {} }),
      abort: async (params) => {
        state.abortCalls.push((params as any).sessionID)
        return {}
      },
      delete: async (params) => {
        state.deleteCalls.push(params as { sessionID: string; directory: string })
        if (state.deleteThrows) throw new Error('delete failed')
        return { error: undefined }
      },
      messages: async () => ({
        error: null,
        data: (state.messagesResult ?? []) as any,
      }),
      get: async () => ({ error: null, data: {} }),
    },
    tui: {
      publish: async (params) => {
        state.publishCalls.push(params as { directory: string; body: unknown })
      },
      selectSession: async (params) => {
        state.selectCalls.push(params as { sessionID: string; workspace?: string })
      },
    },
    worktree: {
      create: async () => ({ error: null, data: { directory: '/tmp/wt', branch: 'b' } }),
      remove: async () => {},
    },
    experimental: {
      workspace: {
        warp: async () => ({ error: null }),
        list: async () => ({ error: null, data: [] }),
        status: async () => ({ error: null, data: [] }),
      },
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

describe('Loop Runtime', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runtime-test-'))
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
      sessionId: 'loop-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/nonexistent-worktree-for-test',
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

  function createRuntime(overrides: {
    v2Client?: OpencodeClient
    loopConfig?: Partial<PluginConfig>
    serviceLoopConfig?: LoopConfig
  } = {}): { loop: Loop; clientState: MockClientState; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const clientState: MockClientState = {
      deleteCalls: [],
      createCalls: [],
      publishCalls: [],
      selectCalls: [],
      deleteThrows: false,
      abortCalls: [],
      promptCalls: [],
      messagesResult: null,
    }

    const v2Client = overrides.v2Client ?? createMockV2Client(clientState)
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
      sandboxManager: undefined,
      dataDir: tempDir,
    })

    return { loop, clientState, logger, logs }
  }

  describe('idle coding session advances to auditing', () => {
    test('idle event on a coding phase transitions to auditing phase', async () => {
      const { loop, clientState } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Audit passed.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        decompositionStatus: 'completed',
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('auditing')
    })
  })

  describe('clean non-sectioned audit terminates completed', () => {
    test('audit session returning clean assistant message terminates with completed', async () => {
      const { loop, clientState } = createRuntime()

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        decompositionStatus: 'completed',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      // Mock the audit session's assistant message (clean result with no findings)
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'All clear. No issues found.' }],
        },
      ]

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After processing a clean audit result, the loop should terminate with completed
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('completed')
    })
  })

  describe('abort during decomposing terminates user aborted', () => {
    test('aborting a decomposer session terminates the loop with user_aborted', async () => {
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'decomposing',
        decompositionStatus: 'running',
        decompositionSessionId: 'decomp-sess-1',
        sessionId: 'decomp-sess-1',
        totalSections: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: 'decomp-sess-1',
          error: { name: 'MessageAbortedError' },
        },
      })

      const terminatedState = loopService.getAnyState(state.loopName)
      expect(terminatedState).not.toBeNull()
      expect(terminatedState!.active).toBe(false)
      expect(terminatedState!.terminationReason).toBe('user_aborted')
    })
  })

  describe('decomposing transition to coding', () => {
    test('in-place loops select the new code session before prompting', async () => {
      const { loop, clientState } = createRuntime()
      const state = makeState({
        phase: 'decomposing',
        sessionId: 'decomp-sess-1',
        decompositionSessionId: 'decomp-sess-1',
        decompositionStatus: 'completed',
        decompositionMode: 'agent',
        totalSections: 1,
        worktree: false,
        worktreeDir: tempDir,
      })
      loopService.setState(state.loopName, state)
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [{ index: 0, title: 'Setup', content: '## Setup\nDo the work' }],
      })

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'decomp-sess-1',
        },
      })

      expect(clientState.selectCalls).toEqual([{ sessionID: 'sess' }])
      expect(clientState.createCalls[0].permission).toBeUndefined()
      expect(clientState.promptCalls[0]).toEqual({ sessionID: 'sess', agent: 'code' })
      expect(loopService.getActiveState(state.loopName)!.decompositionSessionId).toBeNull()
    })

    test('worktree loops select the bound code session after transitioning', async () => {
      vi.useFakeTimers()
      try {
        const { loop, clientState } = createRuntime()
        const state = makeState({
          phase: 'decomposing',
          sessionId: 'decomp-sess-1',
          decompositionSessionId: 'decomp-sess-1',
          decompositionStatus: 'completed',
          decompositionMode: 'agent',
          totalSections: 1,
          worktree: true,
          worktreeDir: tempDir,
          workspaceId: 'ws-1',
        })
        loopService.setState(state.loopName, state)
        sectionPlansRepo.bulkInsert({
          projectId: PROJECT_ID,
          loopName: state.loopName,
          sections: [{ index: 0, title: 'Setup', content: '## Setup\nDo the work' }],
        })

        await loop.tick({
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'decomp-sess-1',
          },
        })

        expect(clientState.selectCalls).toEqual([{ sessionID: 'sess', workspace: 'ws-1' }])
        expect(loopService.getActiveState(state.loopName)!.decompositionSessionId).toBeNull()

        expect(clientState.deleteCalls).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

describe('runtime re-provisioning updates state.workspaceId', () => {
  test('ensureWorkspaceForLoop provisions workspace and sets workspaceId', async () => {
    const clientState: MockClientState = {
      deleteCalls: [],
      createCalls: [],
      publishCalls: [],
      selectCalls: [],
      deleteThrows: false,
      abortCalls: [],
      promptCalls: [],
      messagesResult: [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Audit passed.' }],
        },
      ],
    }

    const wsCreateMock = vi.fn().mockResolvedValue({
      data: { id: 'ws_new', directory: '/tmp/wt/new', branch: 'opencode/new' },
    })
    const warpMock = vi.fn().mockResolvedValue({ error: null })

    const v2Client = {
      ...createMockV2Client(clientState),
      experimental: {
        workspace: {
          create: wsCreateMock,
          warp: warpMock,
        },
      },
    } as unknown as OpencodeClient

    const { logger } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig }

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
      sandboxManager: undefined,
      dataDir: tempDir,
    })

    const state = makeState({
      phase: 'coding',
      totalSections: 0,
      decompositionStatus: 'completed',
      auditCount: 0,
      worktree: true,
      workspaceId: undefined,
      worktreeBranch: 'test/original-branch',
      worktreeDir: '/tmp/wt/original',
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // workspaceId IS persisted to DB by setWorkspaceId
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.workspaceId).toBe('ws_new')

    // createBuiltinWorktreeWorkspace was invoked (proves internal state mutation occurred)
    expect(wsCreateMock).toHaveBeenCalledTimes(1)
    expect(wsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'forge', extra: { loopName: 'test-loop', projectDirectory: expect.any(String) } }),
    )
  })
})

describe('stall handling terminates with stall timeout when configured cap is reached', () => {
    test('repeated stall recovery attempts eventually terminate with stall_timeout', async () => {
      // Create a runtime with low stall limits for testing
      // Need to also configure the loopService with matching stall settings
      const stallConfig: LoopConfig = {
        stallTimeoutMs: 50,
        maxConsecutiveStalls: 2,
      }

      loopService = createLoopService(
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        PROJECT_ID,
        { log: () => {}, error: () => {}, debug: () => {} },
        stallConfig,
        undefined,
        undefined,
        sectionPlansRepo,
      )

      const clientState: MockClientState = {
        deleteCalls: [],
        createCalls: [],
        publishCalls: [],
        selectCalls: [],
        deleteThrows: false,
        abortCalls: [],
        promptCalls: [],
        messagesResult: null,
      }

      const v2Client = createMockV2Client(clientState)
      const { logger, logs } = createCapturingLogger()
      const config: PluginConfig = { ...mockConfig }

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
        sandboxManager: undefined,
        dataDir: tempDir,
        loopConfig: stallConfig,
      })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        decompositionStatus: 'completed',
      })
      loopService.setState(state.loopName, state)

      // Start watchdog
      loop.startWatchdog(state.loopName)
      loop.recordActivity(state.loopName, 'initial')

      // Wait long enough for the first stall to be detected and recovered
      await new Promise(resolve => setTimeout(resolve, 150))

      // Record activity again and wait for another stall detection cycle
      loop.recordActivity(state.loopName, 'after-recovery')
      await new Promise(resolve => setTimeout(resolve, 150))

      // After two stalls (exceeding max of 2), the loop must be terminated with stall_timeout
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('stall_timeout')
    })
  })
})
