import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { PluginConfig } from '../src/types'

const TEST_DB_PATH = join(tmpdir(), `forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
const TEST_LOG_DIR = mkdtempSync(join(tmpdir(), 'forge-log-test-'))

interface MockV2Client {
  session: {
    messages: (opts: { sessionID: string; directory: string; limit?: number }) => Promise<{ data?: unknown[]; error?: unknown }>
    promptAsync: (opts: { sessionID: string; directory: string; parts: unknown[]; agent?: string; model?: unknown }) => Promise<{ data: unknown; error: unknown | null }>
    abort: (opts: { sessionID: string }) => Promise<void>
    status: (opts: { directory: string }) => Promise<{ data?: Record<string, { type: string }> }>
    create: (opts: { title: string; directory: string; permission?: unknown }) => Promise<{ data?: { id: string }; error?: unknown }>
    delete: (opts: { sessionID: string; directory: string }) => Promise<void>
  }
  tui: {
    publish: (opts: unknown) => Promise<void>
    selectSession: (opts: { sessionID: string }) => Promise<void>
  }
  worktree: {
    create: (opts: unknown) => Promise<{ data?: { directory: string; branch: string }; error?: unknown }>
    remove: (opts: unknown) => Promise<void>
  }
}

function createMockV2Client(options: {
  messagesCalls?: Array<{ lastMessageRole: string; text?: string; finish?: string }>
  promptAsyncResult?: { error: unknown | null }
  promptAsyncCalls?: Array<{ agent?: string; sessionID?: string }>
  statusType?: string
  createCalls?: Array<{ data?: { id: string }; error?: unknown }>
  statusThrows?: boolean
}): MockV2Client {
  const callIndex = { value: 0 }
  const createCallIndex = { value: 0 }
  
  return {
    session: {
      messages: async () => {
        const callConfig = options.messagesCalls?.[callIndex.value] || { lastMessageRole: 'assistant', text: '' }
        callIndex.value++
        const role = callConfig.lastMessageRole
        const text = callConfig.text ?? ''
        return {
          data: [
            {
              info: { role, ...(callConfig.finish ? { finish: callConfig.finish } : {}) },
              parts: [{ type: 'text' as const, text }],
            },
          ],
        }
      },
      promptAsync: async (opts: { agent?: string; sessionID?: string }) => {
        options.promptAsyncCalls?.push({ agent: opts.agent, sessionID: opts.sessionID })
        return { data: {}, error: options.promptAsyncResult?.error ?? null }
      },
      abort: async () => {},
      status: async () => {
        if (options.statusThrows) {
          throw new Error('status check failed')
        }
        return { data: { 'test-session': { type: options.statusType ?? 'idle' } } }
      },
      create: async (opts) => {
        const callConfig = options.createCalls?.[createCallIndex.value]
        createCallIndex.value++
        if (callConfig) {
          if (callConfig.error) {
            return { data: undefined, error: callConfig.error }
          }
          return { data: callConfig.data ?? { id: `mock-session-${Date.now()}` }, error: undefined }
        }
        return { data: { id: `mock-session-${Date.now()}` }, error: undefined }
      },
      delete: async () => {},
    },
    tui: {
      publish: async () => {},
      selectSession: async () => {},
    },
    worktree: {
      create: async () => {
        return { data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }
      },
      remove: async () => {},
    },
  }
}

function createTestLogger() {
  const logs: { level: 'log' | 'error' | 'debug'; message: string }[] = []
  return {
    log: (message: string) => logs.push({ level: 'log', message }),
    error: (message: string) => logs.push({ level: 'error', message }),
    debug: (message: string) => logs.push({ level: 'debug', message }),
    logs,
  }
}

describe('loop-hooks integration', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let testProjectId: string
  let testConfig: PluginConfig
  let testLogDir: string

  beforeEach(() => {
    db = new Database(TEST_DB_PATH)
    db.run('PRAGMA busy_timeout=5000')
    
    // Create tables
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
        workspace_id   TEXT,
        host_session_id   TEXT,
        audit_session_id  TEXT,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
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
        branch TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, branch, file, line)
      )
    `)
    
    testProjectId = `test-project-${Date.now()}`
    testLogDir = mkdtempSync(join(TEST_LOG_DIR, `log-${Date.now()}`))
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const logger = createTestLogger()
    
    testConfig = {
      loop: {
        enabled: true,
        worktreeLogging: {
          enabled: true,
          directory: testLogDir,
        },
      },
    } as PluginConfig
    
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, testProjectId, logger, testConfig as any)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true })
    }
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true })
    }
  })

  function createTestHandler(v2Client: MockV2Client, pluginClient: unknown = {}) {
    const logger = createTestLogger()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    
    const service = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, testProjectId, logger, testConfig as any)
    
    const getConfig = () => testConfig as PluginConfig
    
    return {
      handler: createLoopEventHandler(service, pluginClient as any, v2Client as any, logger, getConfig),
      logger,
      service: service,
    }
  }

  describe('stall watchdog', () => {
    it('does not process auditing phase while the audit session is busy', async () => {
      testConfig.loop = {
        ...testConfig.loop,
        stallTimeoutMs: 20,
      }

      let messageReads = 0
      let sessionDeletes = 0
      const v2Client = {
        session: {
          messages: async () => {
            messageReads++
            return {
              data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }],
            }
          },
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({
            data: {
              'coding-session': { type: 'idle' },
              'audit-session': { type: 'busy' },
            },
          }),
          create: async () => ({ data: { id: 'new-coding-session' }, error: undefined }),
          delete: async () => {
            sessionDeletes++
          },
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-loop-audit-watchdog'
      const loopsRepo = createLoopsRepo(db)
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: 'coding-session',
        worktree: false,
        worktreeDir,
        worktreeBranch: null,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      handler.startWatchdog(loopName)
      await new Promise(resolve => setTimeout(resolve, 70))
      handler.clearLoopTimers(loopName)

      const state = service.getAnyState(loopName)
      expect(state?.phase).toBe('auditing')
      expect(state?.sessionId).toBe('coding-session')
      expect(messageReads).toBe(0)
      expect(sessionDeletes).toBe(0)

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('audit abort events', () => {
    it('processes audit result when an audit abort event arrives after assistant response', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: 'Code reviewed, no issues found.' },
          { lastMessageRole: 'assistant', text: 'Code reviewed, no issues found.' },
        ],
        statusType: 'idle',
      })

      const { handler, service, logger } = createTestHandler(v2Client as any)
      const loopName = 'test-loop-audit-abort-after-response'
      const sessionId = 'test-session-audit-abort'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-audit-abort-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.error' as const,
          properties: {
            sessionID: sessionId,
            error: { name: 'MessageAbortedError' },
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 100))

      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('completed')
      expect(logger.logs.some((entry) => entry.message.includes('processing audit result'))).toBe(true)

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('worktree completion log writing', () => {
    it('writes completion log when audit clears and no bug findings', async () => {
      const loopName = 'test-loop-completion'
      const sessionId = 'test-session-123'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-test-branch'
      
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed, no issues found.' }],
        statusType: 'idle',
      })
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('completed')
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBeGreaterThan(0)
      
      const logContent = readFileSync(join(testLogDir, logFiles[0]), 'utf-8')
      expect(logContent).toContain(`## ${loopName}`)
      expect(logContent).toContain('- **Completed:**')
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('does not terminate while branch review findings remain', async () => {
      const promptAsyncCalls: Array<{ agent?: string; sessionID?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed.' }],
        promptAsyncCalls,
        statusType: 'idle',
      })
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-bug-blocked'
      const sessionId = 'test-session-456'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-bug-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      reviewFindingsRepo.write({
        projectId: testProjectId,
        file: 'test.ts',
        line: 10,
        severity: 'warning',
        description: 'Test review finding',
        scenario: 'Test scenario',
        branch: worktreeBranch,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('coding')
      expect(state?.terminationReason).toBeUndefined()
      expect(promptAsyncCalls).toContainEqual({ agent: 'code', sessionID: state?.sessionId })
       
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBe(0)
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('continues in-place loops when v2 message reads fail but plugin client can read audit results', async () => {
      const promptCalls: Array<{ agent?: string; sessionID?: string }> = []
      const v2Client = {
        session: {
          messages: async () => ({ error: new Error('v2 unavailable') }),
          promptAsync: async (opts: { agent?: string; sessionID?: string }) => {
            promptCalls.push({ agent: opts.agent, sessionID: opts.sessionID })
            return { data: {}, error: null }
          },
          abort: async () => {},
          status: async () => ({ data: { 'coding-session': { type: 'idle' } } }),
          create: async () => ({ data: { id: 'next-coding-session' }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const pluginClient = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Found issues to fix.' }] }],
          }),
        },
      }

      const { handler, service } = createTestHandler(v2Client as any, pluginClient)
      const loopName = 'test-in-place-fallback-continuation'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'in-place-loop-'))
      const loopsRepo = createLoopsRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: 'coding-session',
        
        worktree: false,
        worktreeDir,
        worktreeBranch: null,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      reviewFindingsRepo.write({
        projectId: testProjectId,
        file: 'test.ts',
        line: 10,
        severity: 'bug',
        description: 'Test bug finding',
        scenario: 'Test scenario',
        branch: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: 'coding-session',
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 100))

      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('coding')
      expect(state?.iteration).toBe(2)
      expect(state?.auditCount).toBe(1)
      expect(state?.sessionId).toBe('next-coding-session')
      expect(promptCalls).toContainEqual({ agent: 'code', sessionID: 'next-coding-session' })

      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('does not complete audit while the latest assistant message is still making tool calls', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Still reviewing.', finish: 'tool-calls' }],
        statusType: 'idle',
      })

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-loop-audit-tool-calls'
      const sessionId = 'coding-session-tool-calls'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        
        worktree: false,
        worktreeDir,
        worktreeBranch: 'dev',
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 100))

      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('auditing')
      expect(state?.auditCount).toBe(0)
      expect(state?.terminationReason).toBeUndefined()

      handler.clearLoopTimers(loopName)
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('retries once when idle event arrives before assistant message', async () => {
      let callCount = 0
      const v2Client = {
        session: {
          messages: async () => {
            callCount++
            if (callCount === 1) {
              return {
                data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] }],
              }
            }
            return {
              data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }],
            }
          },
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async () => ({ data: { id: 'mock-session' }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-retry'
      const sessionId = 'test-session-789'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-retry-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      
      expect(callCount).toBe(1)
      
      await new Promise(resolve => setTimeout(resolve, 1600))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('completed')
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBeGreaterThan(0)
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('retries coding phase when idle event arrives before assistant message', async () => {
      let callCount = 0
      let createdAuditSessionId = ''
      const v2Client = {
        session: {
          messages: async () => {
            callCount++
            if (callCount === 1) {
              return {
                data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] }],
              }
            }
            return {
              data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Implemented.' }] }],
            }
          },
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async () => {
            createdAuditSessionId = 'audit-session-after-retry'
            return { data: { id: createdAuditSessionId }, error: undefined }
          },
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)

      const loopName = 'test-coding-retry'
      const sessionId = 'test-coding-session-789'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'loop-coding-retry-branch',
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
              }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      })

      expect(callCount).toBe(1)

      await new Promise(resolve => setTimeout(resolve, 1600))

      const state = service.getAnyState(loopName)
      expect(state?.phase).toBe('auditing')
      expect(state?.sessionId).toBe(createdAuditSessionId)

      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('starts audit after coding retry even when messages remain unavailable', async () => {
      let callCount = 0
      let createdAuditSessionId = ''
      const v2Client = {
        session: {
          messages: async () => {
            callCount++
            return {
              data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] }],
            }
          },
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async () => {
            createdAuditSessionId = 'audit-session-after-empty-messages'
            return { data: { id: createdAuditSessionId }, error: undefined }
          },
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)

      const loopName = 'test-coding-empty-messages'
      const sessionId = 'test-coding-session-empty'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'loop-coding-empty-branch',
        projectDir: worktreeDir,
        maxIterations: 0,
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
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
              }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 1600))

      const state = service.getAnyState(loopName)
      expect(callCount).toBe(2)
      expect(state?.phase).toBe('auditing')
      expect(state?.sessionId).toBe(createdAuditSessionId)

      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('exhausts retry after two non-assistant responses', async () => {
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] }],
          }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async () => ({ data: { id: 'mock-session' }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client
      
      const { handler, service, logger } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-retry-exhaust'
      const sessionId = 'test-session-999'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-exhaust-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      
      await new Promise(resolve => setTimeout(resolve, 1700))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('audit_retry_exhausted')
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBe(0)
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('logs error but completes loop when write fails', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Reviewed.' }],
        statusType: 'idle',
      })
      
      const { handler, service, logger } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-write-fail'
      const sessionId = 'test-session-fail'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-fail-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('completed')
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('session rotation with workspace binding', () => {
    it('binds rotated session to existing workspace', async () => {
      const workspaceId = 'test-workspace-123'
      let bindCalled = false
      let boundSessionId: string | null = null
      let createArgs: any = null
      
      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Reviewed.' }] }] }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts: any) => {
            createArgs = opts
            const newId = `mock-session-${Date.now()}`
            return { data: { id: newId }, error: undefined }
          },
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async (opts: any) => {
              bindCalled = true
              boundSessionId = opts.sessionID
              return { data: {}, error: null }
            },
          },
        },
      } as any
      
      const { handler, service } = createTestHandler(v2Client)
      
      const loopName = 'test-loop-rotate-workspace'
      const sessionId = 'test-session-rotate'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-rotate-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const now = Date.now()
      
      const insertOk = loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 1,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId,
        hostSessionId: 'host-123',
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      // Add an outstanding bug finding so the loop doesn't terminate (needs to continue rotating)
      reviewFindingsRepo.write({
        projectId: testProjectId,
        file: 'test.ts',
        line: 10,
        severity: 'bug',
        description: 'Test bug finding',
        scenario: 'Test scenario',
        branch: worktreeBranch,
      })
      
      // Verify the state was inserted with workspaceId
      expect(insertOk).toBe(true)
      expect(service.getAnyState(loopName)?.workspaceId).toBe(workspaceId)

      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      expect(bindCalled).toBe(true)
      expect(boundSessionId).not.toBeNull()
      const newState = service.getAnyState(loopName)
      expect(newState?.workspaceId).toBe(workspaceId)
      expect(createArgs).toEqual(expect.objectContaining({
        workspaceID: workspaceId,
      }))
      expect(createArgs).not.toHaveProperty('parentID')
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('clears workspaceId but preserves hostSessionId when bind fails during rotation', async () => {
      const workspaceId = 'test-workspace-fail'
      const hostSessionId = 'host-preserve-456'
      const toastCalls: Array<{ variant?: string; message?: string }> = []
      let createArgs: any = null

      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Reviewed.' }] }] }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts: any) => {
            createArgs = opts
            return { data: { id: `mock-session-${Date.now()}` }, error: undefined }
          },
          delete: async () => {},
        },
        tui: {
          publish: async (opts: any) => {
            const props = opts?.body?.properties ?? {}
            toastCalls.push({ variant: props.variant, message: props.message })
          },
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async () => {
              throw new Error('workspace gone')
            },
          },
        },
      } as any

      const { handler, service } = createTestHandler(v2Client)

      const loopName = 'test-loop-bind-fail'
      const sessionId = 'test-session-bind-fail'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-bind-fail-branch'

      const loopsRepo = createLoopsRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 1,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId,
        hostSessionId,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      reviewFindingsRepo.write({
        projectId: testProjectId,
        file: 'test.ts',
        line: 10,
        severity: 'bug',
        description: 'Test bug finding',
        scenario: 'Test scenario',
        branch: worktreeBranch,
      })

      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }

      await handler.onEvent(idleEvent)
      await new Promise(resolve => setTimeout(resolve, 100))

      const newState = service.getAnyState(loopName)
      expect(newState).toBeDefined()
      // workspaceId should be cleared
      expect(newState?.workspaceId).toBeUndefined()
      // hostSessionId must be preserved so post-completion TUI redirect still works
      expect(newState?.hostSessionId).toBe(hostSessionId)
      // Loop must remain active (new session registered) despite bind failure
      expect(newState?.active).toBe(true)
      expect(newState?.sessionId).not.toBe(sessionId)
      // Warning toast should have been published to notify the user
      const warningToasts = toastCalls.filter((t) => t.variant === 'warning')
      expect(warningToasts.length).toBeGreaterThan(0)
      expect(warningToasts[0].message).toContain('Workspace attachment lost')
      // Rotated session should not have parentID
      expect(createArgs).not.toHaveProperty('parentID')

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('phase flow invariants', () => {
    it('final iteration runs audit before max_iterations termination', async () => {
      const promptCalls: Array<{ agent?: string; parts: unknown[] }> = []
      
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Code changes complete.' }] }],
          }),
          promptAsync: async (opts: any) => {
            promptCalls.push({ agent: opts.agent, parts: opts.parts })
            return { data: {}, error: null }
          },
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async () => ({ data: { id: 'mock-session' }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as any
      
      const { handler, service } = createTestHandler(v2Client)
      
      const loopName = 'test-loop-final-audit'
      const sessionId = 'test-session-final'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-final-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 3,
        auditCount: 2,
        errorCount: 0,
        phase: 'coding',

        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
              }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('auditing')
      
      expect(promptCalls.length).toBeGreaterThan(0)
      expect(promptCalls[0].agent).toBe('auditor-loop')
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('terminates with max_iterations only after audit runs at final iteration', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed.' }],
        statusType: 'idle',
      })
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-max-audit-done'
      const sessionId = 'test-session-max'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-max-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 3,
        auditCount: 3,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      reviewFindingsRepo.write({
        projectId: testProjectId,
        file: 'test.ts',
        line: 10,
        severity: 'bug',
        description: 'Outstanding bug finding',
        scenario: 'Test scenario',
        branch: worktreeBranch,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('max_iterations')
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBe(0)
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('terminates with completed when audit clears at final iteration', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed, no issues.' }],
        statusType: 'idle',
      })
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-clear-final'
      const sessionId = 'test-session-clear'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-clear-branch'
      
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()
      
      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 3,
        auditCount: 2,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })
      
      const idleEvent = {
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      }
      
      await handler.onEvent(idleEvent)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(false)
      expect(state?.terminationReason).toBe('completed')
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBeGreaterThan(0)
      
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('session deletion order', () => {
    it('handleCodingPhase deletes code session before creating audit session', async () => {
      const sessionDeletes: string[] = []
      const sessionCreates: string[] = []
      
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Done' }] }],
          }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts: { title: string }) => {
            const id = `created-${Date.now()}`
            sessionCreates.push(id)
            return { data: { id }, error: undefined }
          },
          delete: async (opts: { sessionID: string }) => {
            sessionDeletes.push(opts.sessionID)
          },
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)

      const loopName = 'test-delete-order'
      const sessionId = 'test-session-delete-order'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-delete-branch'

      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 2,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 200))

      const state = service.getAnyState(loopName)
      expect(state?.phase).toBe('auditing')
      expect(sessionDeletes).toContain(sessionId)
      expect(sessionDeletes.length).toBe(1)
      expect(sessionCreates.length).toBe(1)

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('B1 audit-creation failure during coding handoff', () => {
    it('recovers from transient audit-creation failure and transitions to auditing', async () => {
      const originalSessionId = 'code-session-to-delete'
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Done' }],
        statusType: 'idle',
        createCalls: [
          { error: new Error('create failed') },
          { data: { id: 'audit-session-after-retry' } },
        ],
      })
      ;(v2Client as any).session.status = async () => ({ data: { [originalSessionId]: { type: 'idle' } } })

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b1-recovery'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: originalSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'b1-branch',
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: originalSessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 2000))
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.sessionId).not.toBe(originalSessionId)
      expect(state?.phase).toBe('auditing')
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('rotates to fresh code session when audit creation fails MAX_RETRIES times', async () => {
      const originalSessionId = 'code-session-b1-fail'
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Done' }],
        statusType: 'idle',
        createCalls: [
          { error: new Error('create failed') },
          { error: new Error('create failed') },
          { error: new Error('create failed') },
        ],
      })
      ;(v2Client as any).session.status = async () => ({ data: { [originalSessionId]: { type: 'idle' } } })

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b1-exhausted'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: originalSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'b1-fail-branch',
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: originalSessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 3000))
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('coding')
      expect(state?.sessionId).not.toBe(originalSessionId)
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('B2 audit session abort/error rolls forward, not into a dead session', () => {
    it('aborts audit without assistant message and rotates to fresh coding session', async () => {
      const auditSessionId = 'audit-session-abort'
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] }],
          }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { [auditSessionId]: { type: 'idle' } } }),
          create: async () => ({ data: { id: `new-code-${Date.now()}` }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b2-abort'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'b2-abort-branch',
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      await handler.onEvent({
        event: {
          type: 'session.error' as const,
          properties: {
            sessionID: auditSessionId,
            error: { name: 'MessageAbortedError' },
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 100))
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('coding')
      expect(state?.sessionId).not.toBe(auditSessionId)
      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('audit session.error with non-abort error rotates to fresh coding session with modelFailed set', async () => {
      const auditSessionId = 'audit-session-error'
      const priorAuditResult = 'prior audit text'
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '' }] }],
          }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { [auditSessionId]: { type: 'idle' } } }),
          create: async () => ({ data: { id: `new-code-${Date.now()}` }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b2-error'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch: 'b2-error-branch',
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 1,
        auditCount: 1,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: priorAuditResult,
      })

      await handler.onEvent({
        event: {
          type: 'session.error' as const,
          properties: {
            sessionID: auditSessionId,
            error: { data: { message: 'provider quota exceeded' } },
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 100))
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.phase).toBe('coding')
      expect(state?.sessionId).not.toBe(auditSessionId)
      expect(state?.lastAuditResult).toBe(priorAuditResult)
      expect(state?.modelFailed).toBe(true)
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('B3 watchdog status-check failure is not a stall', () => {
    it('does not increment consecutiveStalls when session.status throws once', async () => {
      testConfig.loop = {
        ...testConfig.loop,
        stallTimeoutMs: 50,
      }

      let statusCallCount = 0
      const v2Client = {
        session: {
          messages: async () => ({
            data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Work in progress' }] }],
          }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => {
            statusCallCount++
            if (statusCallCount === 1) {
              throw new Error('status check failed')
            }
            return { data: { 'coding-session': { type: 'busy' } } }
          },
          create: async () => ({ data: { id: 'new-session' }, error: undefined }),
          delete: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        worktree: {
          create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
          remove: async () => {},
        },
      } as MockV2Client

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b3-status-fail'
      const loopsRepo = createLoopsRepo(db)
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: 'coding-session',
        worktree: false,
        worktreeDir,
        worktreeBranch: null,
        projectDir: worktreeDir,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: null,
      })

      handler.startWatchdog(loopName)
      await new Promise(resolve => setTimeout(resolve, 120))
      handler.clearLoopTimers(loopName)

      const stallInfo = handler.getStallInfo(loopName)
      expect(stallInfo?.consecutiveStalls).toBe(0)
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.terminationReason).toBeUndefined()
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('B4 lastAuditResult preserved when new audit text empty', () => {
    it('keeps prior lastAuditResult when audit returns empty assistant text', async () => {
      const priorAuditResult = 'prior audit findings'
      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: '' },
        ],
        statusType: 'idle',
      })

      const { handler, service } = createTestHandler(v2Client as any)
      const loopName = 'test-b4-empty-audit'
      const sessionId = 'audit-session-empty'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'b4-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
        projectDir: worktreeDir,
        maxIterations: 3,
        iteration: 1,
        auditCount: 1,
        errorCount: 0,
        phase: 'auditing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
      }, {
        prompt: 'Test prompt',
        lastAuditResult: priorAuditResult,
      })

      service.registerLoopSession(sessionId, loopName)

      // Add a review finding so checkAuditClearAndTerminate doesn't terminate
      db.run(`
        INSERT INTO review_findings (project_id, branch, file, line, severity, description, created_at)
        VALUES (?, 'b4-branch', 'test.ts', 1, 'bug', 'test finding', ?)
      `, testProjectId, now)

      await handler.onEvent({
        event: {
          type: 'session.status' as const,
          properties: {
            status: { type: 'idle' as const },
            sessionID: sessionId,
          },
        },
      })

      await new Promise(resolve => setTimeout(resolve, 500))
      const state = service.getAnyState(loopName)
      expect(state?.phase).toBe('coding')
      expect(state?.lastAuditResult).toBe(priorAuditResult)
      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })
})
