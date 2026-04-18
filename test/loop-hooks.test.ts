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
  messagesCalls?: Array<{ lastMessageRole: string; text?: string }>
  promptAsyncResult?: { error: unknown | null }
  statusType?: string
}): MockV2Client {
  const callIndex = { value: 0 }
  
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
              info: { role },
              parts: [{ type: 'text' as const, text }],
            },
          ],
        }
      },
      promptAsync: async () => {
        return { data: {}, error: options.promptAsyncResult?.error ?? null }
      },
      abort: async () => {},
      status: async () => {
        return { data: { 'test-session': { type: options.statusType ?? 'idle' } } }
      },
      create: async (opts) => {
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
        audit                INTEGER NOT NULL,
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
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT NOT NULL,
        branch TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, file, line)
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
    
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, testProjectId, logger, testConfig)
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

  function createTestHandler(v2Client: MockV2Client) {
    const logger = createTestLogger()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    
    const service = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, testProjectId, logger, testConfig)
    
    const getConfig = () => testConfig as PluginConfig
    
    return {
      handler: createLoopEventHandler(service, {} as any, v2Client as any, logger, getConfig),
      logger,
      service: service,
    }
  }

  describe('worktree completion log writing', () => {
    it('writes completion log when audit clears and no bug findings', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed, no issues found.' }],
        statusType: 'idle',
      })
      
      const { handler, service } = createTestHandler(v2Client as any)
      
      const loopName = 'test-loop-completion'
      const sessionId = 'test-session-123'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-test-branch'
      
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
        audit: true,
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

    it('does not write log when bug findings block termination', async () => {
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'Code reviewed.' }],
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
        audit: true,
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
      
      const state = service.getAnyState(loopName)
      expect(state?.active).toBe(true)
      expect(state?.terminationReason).toBeUndefined()
      
      const logFiles = readdirSync(testLogDir).filter(f => f.endsWith('.md'))
      expect(logFiles.length).toBe(0)
      
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
        audit: true,
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
        audit: true,
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
      expect(state?.active).toBe(true)
      
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
        audit: true,
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
})
