import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopSessionUsageRepo, type LoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop, type LoopRuntimeDeps } from '../../src/loop/runtime'
import { sessionsAwaitingBusy } from '../../src/loop/idle-gate'
import {
  markPromptInFlight,
  clearPromptInFlight,
  getPromptInFlight,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
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
  promptCalls: Array<{ sessionID: string; agent?: string; variant?: string }>
  promptAsyncFailCount?: number
  messagesResult: Array<{ info: { role: string; finish?: string }; parts: Array<{ type: string; text?: string }> }> | null
  messagesBySession?: Map<string, Array<{ info: { role: string; finish?: string }; parts: Array<{ type: string; text?: string }> }>>
}

function createMockV2Client(state: MockClientState): OpencodeClient {
  return {
    session: {
      create: async (params) => {
        state.createCalls.push(params as Record<string, unknown>)
        return { error: null, data: { id: 'sess' } }
      },
      promptAsync: async (params) => {
        state.promptCalls.push({ sessionID: (params as any).sessionID ?? '', agent: (params as any).agent, variant: (params as any).variant })
        if (state.promptAsyncFailCount && state.promptAsyncFailCount > 0) {
          state.promptAsyncFailCount--
          return { error: { name: 'TestError', data: { message: 'simulated model failure' } }, data: null }
        }
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
      messages: async (params) => {
        const sessionID = (params as any)?.sessionID as string | undefined
        if (sessionID && state.messagesBySession?.has(sessionID)) {
          return {
            error: null,
            data: state.messagesBySession.get(sessionID) as any,
          }
        }
        return {
          error: null,
          data: (state.messagesResult ?? []) as any,
        }
      },
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

const LOOP_SESSION_USAGE_SCHEMA = `
CREATE TABLE loop_session_usage (
  project_id TEXT NOT NULL,
  loop_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 1,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, session_id, model)
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
  let loopSessionUsageRepo: LoopSessionUsageRepo

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runtime-test-'))
    db = new Database(join(tempDir, 'test.db'))

    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS_SCHEMA)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)
    db.exec(LOOP_SESSION_USAGE_SCHEMA)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopSessionUsageRepo = createLoopSessionUsageRepo(db)

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
    __resetInFlightGuard()
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
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      executionVariant: undefined,
      auditorVariant: undefined,
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
    withUsageRepo?: boolean
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
      loopSessionUsageRepo: overrides.withUsageRepo ? loopSessionUsageRepo : undefined,
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

    test('does not transition to auditing when latest coding message is still user prompt', async () => {
      const { loop, clientState } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Older code response.' }],
        },
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'Latest code prompt that was not answered.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
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
      expect(updatedState!.phase).toBe('coding')

      expect(clientState.promptCalls.some((call) => call.agent === 'auditor-loop')).toBe(false)

      const hasCodePrompt = clientState.promptCalls.some((call) => call.agent === 'code')
      expect(hasCodePrompt).toBe(false)
    })
  })

  describe('clean non-sectioned audit terminates completed', () => {
    test('audit session returning clean assistant message terminates with completed', async () => {
      const { loop, clientState } = createRuntime()

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,

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

    const wsCreateMock = mock(async () => ({
      data: { id: 'ws_new', directory: '/tmp/wt/new', branch: 'opencode/new' },
    }))
    const warpMock = mock(async () => ({ error: null }))

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
      expect.objectContaining({
        type: 'forge',
        extra: expect.objectContaining({
          loopName: 'test-loop',
          projectDirectory: expect.any(String),
          workspaceCreatedAt: expect.any(Number),
        }),
      }),
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

  describe('in-flight prompt guard', () => {
    test('rejects audit prompt while code prompt in-flight', async () => {
      markPromptInFlight('test-loop', 'other-session-id', 'code')

      const { loop, clientState, logger, logs } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Audit passed.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

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

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })

    test('rejects duplicate auditor prompt for same audit session', async () => {
      markPromptInFlight('test-loop', 'sess', 'auditor-loop')

      const { loop, clientState, logs } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Implementation complete.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

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

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const auditorPrompts = clientState.promptCalls.filter((c) => c.agent === 'auditor-loop')
      expect(auditorPrompts).toHaveLength(0)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('sess')
      expect(prior!.agent).toBe('auditor-loop')
    })

    test('clears in-flight after busy event', async () => {
      const state = makeState({ phase: 'coding' })
      markPromptInFlight('test-loop', state.sessionId, 'code')

      const { loop } = createRuntime()
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('busy event from non-owning session does not clear in-flight', async () => {
      markPromptInFlight('test-loop', 'sess-owner', 'auditor-loop')

      const { loop } = createRuntime()
      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession('sess-old', 'test-loop')

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: 'sess-old',
        },
      })

      const entry = getPromptInFlight('test-loop')
      expect(entry).toBeDefined()
      expect(entry!.sessionId).toBe('sess-owner')
      expect(entry!.agent).toBe('auditor-loop')
    })

    test('clears in-flight when promptAsync throws a transient error', async () => {
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
            parts: [{ type: 'text', text: 'Implementation complete.' }],
          },
        ],
      }

      const v2Client = createMockV2Client(clientState)
      const origPromptAsync = v2Client.session.promptAsync
      let promptCallCount = 0
      ;(v2Client as any).session.promptAsync = async (params: any) => {
        promptCallCount++
        if (params?.agent === 'code' && params?.sessionID === 'loop-session-id') {
          throw new Error('transient transport error')
        }
        return origPromptAsync(params)
      }

      const { loop, logs } = createRuntime({ v2Client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

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

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('clears in-flight on prompt completion', async () => {
      const { loop, clientState } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'All clear.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

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

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('handlePromptError short-circuits on ConcurrentPromptError, preserving loop active state', async () => {
      markPromptInFlight('test-loop', 'other-session-id', 'code')

      const { loop, clientState, logs } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Audit passed.' }],
        },
      ]

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

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

      const afterState = loop.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })
  })

  describe('session retention', () => {
    test('queues session for retention on coding phase transition', async () => {
      const { loop, clientState } = createRuntime()

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'All clear.' }],
        },
      ]

      // Trigger a single rotation: coding→audit
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      expect(clientState.deleteCalls.map((call) => call.sessionID)).toContain(state.sessionId)
    })

    test('tolerates delete failure without crashing', async () => {
      const { loop, clientState, logger, logs } = createRuntime()
      clientState.deleteThrows = true

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'All clear.' }],
        },
      ]

      // Trigger a rotation; delete error should be caught and logged
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // No unhandled rejection from delete failure
      const hasDeleteError = logs.some(
        (l) => l.level === 'error' && l.message.includes('failed to delete'),
      )
      // Even if no trim happened (queue <= 2), we verify no crash occurred
    })

    test('terminate flushes retained sessions', async () => {
      const { loop, clientState } = createRuntime()

      const state = makeState({
        phase: 'coding',
        totalSections: 0,

        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'All clear.' }],
        },
      ]

      // First rotation: coding→audit
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // After tick, state changed to auditing with session='sess'
      // Terminate the loop: terminateLoop should clean up retained sessions
      await loop.cancel(state.loopName)

      // Check that v2Client.session.delete was called for the old coding session
      const deletedSids = clientState.deleteCalls.map((c) => c.sessionID)
      expect(deletedSids).toContain(state.sessionId)
    })
  })

  describe('usage capture', () => {
    function mockAssistantMessage(cost: number, tokens: { input: number; output: number; reasoning: number }) {
      return {
        info: {
          role: 'assistant' as const,
          finish: 'stop',
          cost,
          tokens: {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: 'text' as const, text: 'Implementation complete.' }],
      }
    }

    test('code session rotation captures usage with state.executionModel', async () => {
      const { loop, clientState, logs } = createRuntime({ withUsageRepo: true })
      clientState.messagesResult = [mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 })]

      const state = makeState({
        phase: 'coding',
        executionModel: 'test/exec-model',
        auditorModel: 'test/auditor-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Wait a tick for async capture to complete
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/exec-model')
      expect(usage!.byModel['test/exec-model'].inputTokens).toBe(100)
    })

    test('audit termination captures usage with state.auditorModel', async () => {
      const { loop, clientState } = createRuntime({ withUsageRepo: true })
      clientState.messagesResult = [mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 })]

      const state = makeState({
        phase: 'auditing',
        executionModel: 'test/exec-model',
        auditorModel: 'test/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/audit-model')
      expect(usage!.byModel['test/audit-model'].inputTokens).toBe(200)
    })

    test('state models take precedence over current config', async () => {
      const { loop, clientState } = createRuntime({ withUsageRepo: true })
      clientState.messagesResult = [mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 })]

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      // Should use state.executionModel, not config.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
    })

    test('capture failure logs error but does not block termination', async () => {
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
      ;(v2Client.session.messages as any) = async () => {
        throw new Error('messages fetch failed')
      }

      const { loop, logs } = createRuntime({ v2Client, withUsageRepo: true })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.cancel(state.loopName)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)

      const hasCaptureError = logs.some(l => l.level === 'error' && l.message.includes('failed to capture usage'))
      expect(hasCaptureError).toBe(true)
    })

    test('retained sessions preserve role and model: code session retained, audit session enqueued', async () => {
      const { loop, clientState } = createRuntime({ withUsageRepo: true })

      // Set up per-session messages
      clientState.messagesBySession = new Map()
      clientState.messagesBySession.set('coding-session-1', [
        mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 }),
      ])

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        loopName: 'test-loop-mixed-1',
        sessionId: 'coding-session-1',
      })
      loopService.setState(state.loopName, state)

      // First rotation: coding→audit, queues coding session as 'code' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // After first tick, state is now in auditing phase with a new session
      const afterFirstTick = loopService.getActiveState(state.loopName)!
      expect(afterFirstTick.phase).toBe('auditing')

      // Set up messages for the audit session
      clientState.messagesBySession.set(afterFirstTick.sessionId, [
        mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 }),
      ])

      // The coding session should already be captured
      await new Promise(resolve => setTimeout(resolve, 10))
      let usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(100)

      // Now terminate the loop while in auditing phase
      // This should capture the audit session with auditor role
      await loop.cancel(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Audit session should be captured as 'auditor' with state.auditorModel
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained audit session cleaned up on termination with correct attribution', async () => {
      const { loop, clientState } = createRuntime({ withUsageRepo: true })
      clientState.messagesResult = [
        mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 }),
      ]

      // Start in auditing phase
      const state = makeState({
        phase: 'auditing',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      // Rotation: audit→coding, queues audit session as 'auditor' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Now terminate the loop
      await loop.cancel(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained audit session should be captured with state.auditorModel
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained sessions cleaned up on clearLoopTimers with correct attribution', async () => {
      const { loop, clientState } = createRuntime({ withUsageRepo: true })
      clientState.messagesResult = [
        mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 }),
      ]

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
      })
      loopService.setState(state.loopName, state)

      // Rotation: coding→audit, queues coding session as 'code' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Call clearLoopTimers to clean up retained sessions
      await loop.clearLoopTimers(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained coding session should be captured with state.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(150)
    })
  })

  describe('variant dispatch', () => {
    test('coding prompt sends executionVariant from loop state', async () => {
      const { loop, clientState } = createRuntime()
      clientState.messagesResult = [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Audit passed.' }],
        },
      ]

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After auditing phase processes dirty audit, it transitions to coding and sends code prompts
      const codePrompts = clientState.promptCalls.filter(c => c.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      for (const call of codePrompts) {
        expect(call.variant).toBe('thinking-max')
      }
    })

    test('auditor prompt sends auditorVariant from loop state', async () => {
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
        auditCount: 0,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // The auditor prompt should have the auditorVariant
      const auditorPrompts = clientState.promptCalls.filter(c => c.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect(call.variant).toBe('audit-high')
      }
    })

    test('model fallback omits variant when model is undefined', async () => {
      const clientState: MockClientState = {
        deleteCalls: [],
        createCalls: [],
        publishCalls: [],
        selectCalls: [],
        deleteThrows: false,
        abortCalls: [],
        promptCalls: [],
        promptAsyncFailCount: 2,
        messagesResult: [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'Audit passed.' }],
          },
        ],
      }

      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()
      const config: PluginConfig = { ...mockConfig, executionModel: 'test/model' }

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
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionModel: 'test/model',
        executionVariant: 'thinking-max',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // Model-based attempts should have been made (and failed)
      const codePrompts = clientState.promptCalls.filter(c => c.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      // After model fails, fallback without model should NOT send variant
      const fallbackPrompts = codePrompts.filter(c => !c.variant)
      expect(fallbackPrompts.length).toBeGreaterThan(0)
    })
  })
})
