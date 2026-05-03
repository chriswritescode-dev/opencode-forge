import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { createLoopEventHandler, isWorkspaceNotFoundError, type LoopEventHandler } from '../src/hooks/loop'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { PluginConfig } from '../src/types'

const TEST_DB_PATH = join(tmpdir(), `forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

interface MockV2Client {
  session: {
    messages: (opts: { sessionID: string; directory: string; limit?: number }) => Promise<{ data?: unknown[]; error?: unknown }>
    promptAsync: (opts: { sessionID: string; directory: string; parts: unknown[]; agent?: string; model?: unknown }) => Promise<{ data: unknown; error: unknown | null }>
    abort: (opts: { sessionID: string }) => Promise<void>
    status: (opts: { directory: string }) => Promise<{ data?: Record<string, { type: string }> }>
    create: (opts: { title: string; directory: string; permission?: unknown; workspaceID?: string }) => Promise<{ data?: { id: string }; error?: unknown }>
    delete: (opts: { sessionID: string; directory: string }) => Promise<void>
    get: (opts: { sessionID: string; directory: string }) => Promise<{ data?: { permission?: unknown } }>
  }
  tui: {
    publish: (opts: unknown) => Promise<void>
    selectSession: (opts: { sessionID: string }) => Promise<void>
  }
  experimental?: {
    workspace?: {
      sessionRestore?: (opts: { id: string; sessionID: string }) => Promise<{ data?: unknown; error?: unknown }>
      create?: (opts: { type: string; branch: string | null; extra: unknown }) => Promise<{ data?: { id: string }; error?: unknown }>
    }
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

describe('workspace recovery', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let testProjectId: string
  let testConfig: PluginConfig
  let testLogDir: string
  const handlersToCleanup: Array<{ handler: LoopEventHandler; loopName: string }> = []

  beforeEach(() => {
    handlersToCleanup.length = 0
    db = new Database(TEST_DB_PATH)
    db.run('PRAGMA busy_timeout=5000')
    
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
    testLogDir = mkdtempSync(join(tmpdir(), 'forge-log-test-'))
    
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
    // Clear all loop timers to prevent watchdog interval leaks
    for (const { handler, loopName } of handlersToCleanup) {
      handler.clearLoopTimers(loopName)
      handler.clearAllRetryTimeouts()
    }
    handlersToCleanup.length = 0

    try {
      db.close()
    } catch {}
    if (db) {
      rmSync(TEST_DB_PATH, { force: true })
    }
    if (testLogDir) {
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

  describe('isWorkspaceNotFoundError', () => {
    it('returns true for Error with Workspace not found message', () => {
      const err = new Error('Workspace not found: wrk_x')
      expect(isWorkspaceNotFoundError(err)).toBe(true)
    })

    it('returns true for string message with Workspace not found', () => {
      const msg = 'Workspace not found: wrk_y'
      expect(isWorkspaceNotFoundError(msg)).toBe(true)
    })

    it('returns true for JSON-stringified error data', () => {
      const data = { message: 'Workspace not found' }
      expect(isWorkspaceNotFoundError(data)).toBe(true)
    })

    it('returns false for unrelated errors', () => {
      const err = new Error('Connection timeout')
      expect(isWorkspaceNotFoundError(err)).toBe(false)
    })

    it('handles null/undefined gracefully', () => {
      expect(isWorkspaceNotFoundError(null)).toBe(false)
      expect(isWorkspaceNotFoundError(undefined)).toBe(false)
    })
  })

  describe('recoverFromMissingWorkspace behavior', () => {
    it('happy path: audit session bind fails and recovery succeeds with new workspace id', async () => {
      const workspaceId = 'test-workspace-recover-123'
      const newWorkspaceId = 'test-workspace-recovered-456'
      let sessionRestoreCallCount = 0
      let createCalled = false
      const toastCalls: Array<{ variant?: string; message?: string }> = []

      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }] }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts) => {
            return { data: { id: `mock-session-${Date.now()}` }, error: undefined }
          },
          delete: async () => {},
          get: async () => ({ data: { permission: null } }),
        },
        tui: {
          publish: async (opts: any) => {
            const props = opts?.body?.properties ?? {}
            toastCalls.push({ variant: props.variant, message: props.message })
          },
          selectSession: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async (opts) => {
              sessionRestoreCallCount++
              // First call (during audit session creation) should throw to trigger bindFailed
              // Second call (during recovery) should succeed
              if (sessionRestoreCallCount === 1) {
                throw new Error('Workspace not found: wrk_test')
              }
              return { data: {}, error: null }
            },
            create: async (opts) => {
              createCalled = true
              return { data: { id: newWorkspaceId }, error: undefined }
            },
          },
        },
      } as any

      const { handler, service } = createTestHandler(v2Client)
      const loopName = 'test-loop-recover-happy'
      handlersToCleanup.push({ handler, loopName })
      const sessionId = 'test-session-recover'
      const auditSessionId = 'test-audit-session-recover'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-recover-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
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
        workspaceId,
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
      expect(createCalled).toBe(true)
      expect(state?.workspaceId).toBe(newWorkspaceId)
      expect(toastCalls.some(t => t.message?.includes('Workspace attachment lost'))).toBe(true)

      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('re-provision fails: createLoopWorkspace returns null', async () => {
      const workspaceId = 'test-workspace-stale'
      const toastCalls: Array<{ variant?: string; message?: string }> = []

      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }] }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts) => ({ data: { id: `mock-session-${Date.now()}` }, error: undefined }),
          delete: async () => {},
          get: async () => ({ data: { permission: null } }),
        },
        tui: {
          publish: async (opts: any) => {
            const props = opts?.body?.properties ?? {}
            toastCalls.push({ variant: props.variant, message: props.message })
          },
          selectSession: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async () => {
              throw new Error('Workspace not found: wrk_test')
            },
            create: async () => null,
          },
        },
      } as any

      const { handler, service } = createTestHandler(v2Client)
      const loopName = 'test-loop-reprovision-fail'
      handlersToCleanup.push({ handler, loopName })
      const sessionId = 'test-session-reprovision-fail'
      const auditSessionId = 'test-audit-session-reprovision-fail'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-reprovision-fail-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
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
        workspaceId,
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
      expect(state?.workspaceId).toBeUndefined()
      expect(toastCalls.some(t => t.message?.includes('Workspace attachment lost'))).toBe(true)

      rmSync(worktreeDir, { recursive: true, force: true })
    })

    it('rebind fails: new workspace created but bindSessionToWorkspace throws', async () => {
      const workspaceId = 'test-workspace-bind-fail'
      const newWorkspaceId = 'test-workspace-new-but-bind-fail'
      const toastCalls: Array<{ variant?: string; message?: string }> = []

      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }] }),
          promptAsync: async () => ({ data: {}, error: null }),
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts) => ({ data: { id: `mock-session-${Date.now()}` }, error: undefined }),
          delete: async () => {},
          get: async () => ({ data: { permission: null } }),
        },
        tui: {
          publish: async (opts: any) => {
            const props = opts?.body?.properties ?? {}
            toastCalls.push({ variant: props.variant, message: props.message })
          },
          selectSession: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async () => {
              throw new Error('bind failed')
            },
            create: async () => ({ data: { id: newWorkspaceId }, error: undefined }),
          },
        },
      } as any

      const { handler, service } = createTestHandler(v2Client)
      const loopName = 'test-loop-rebind-fail'
      handlersToCleanup.push({ handler, loopName })
      const sessionId = 'test-session-rebind-fail'
      const auditSessionId = 'test-audit-session-rebind-fail'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-rebind-fail-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
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
        workspaceId,
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
      expect(state?.workspaceId).toBe(workspaceId)
      expect(toastCalls.length).toBe(0)

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })

  describe('end-to-end audit prompt recovery', () => {
    it('simulates audit prompt workspace not found error and recovery', async () => {
      const workspaceId = 'test-workspace-e2e'
      const newWorkspaceId = 'test-workspace-e2e-recovered'
      let promptCalls = 0
      let sessionRestoreCallCount = 0
      const toastCalls: Array<{ variant?: string; message?: string }> = []

      const v2Client = {
        session: {
          messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Reviewed.' }] }] }),
          promptAsync: async (opts) => {
            promptCalls++
            // First prompt call should fail with workspace not found
            if (promptCalls === 1) {
              return { data: {}, error: new Error('Workspace not found: wrk_test') }
            }
            return { data: {}, error: null }
          },
          abort: async () => {},
          status: async () => ({ data: { 'test-session': { type: 'idle' } } }),
          create: async (opts) => ({ data: { id: `mock-session-${Date.now()}` }, error: undefined }),
          delete: async () => {},
          get: async () => ({ data: { permission: null } }),
        },
        tui: {
          publish: async (opts: any) => {
            const props = opts?.body?.properties ?? {}
            toastCalls.push({ variant: props.variant, message: props.message })
          },
          selectSession: async () => {},
        },
        experimental: {
          workspace: {
            sessionRestore: async (opts) => {
              sessionRestoreCallCount++
              // First call (during audit session creation) should throw to trigger bindFailed
              // Second call (during recovery re-bind) should succeed
              if (sessionRestoreCallCount === 1) {
                throw new Error('Workspace not found: wrk_test')
              }
              return { data: {}, error: null }
            },
            create: async () => ({ data: { id: newWorkspaceId }, error: undefined }),
          },
        },
      } as any

      const { handler, service } = createTestHandler(v2Client)
      const loopName = 'test-loop-e2e-recovery'
      handlersToCleanup.push({ handler, loopName })
      const sessionId = 'test-session-e2e'
      const auditSessionId = 'test-audit-session-e2e'
      const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'))
      const worktreeBranch = 'loop-e2e-branch'
      const loopsRepo = createLoopsRepo(db)
      const now = Date.now()

      loopsRepo.insert({
        projectId: testProjectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        auditSessionId,
        worktree: true,
        worktreeDir,
        worktreeBranch,
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
        workspaceId,
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
      // After recovery, prompt should be retried once
      expect(promptCalls).toBeGreaterThanOrEqual(1)
      expect(state?.workspaceId).toBe(newWorkspaceId)
      expect(toastCalls.some(t => t.message?.includes('Workspace attachment lost'))).toBe(true)

      rmSync(worktreeDir, { recursive: true, force: true })
    })
  })
})
