import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import type { PluginConfig } from '../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

const TEST_PROJECT_DIR_BASE = mkdtempSync(join(tmpdir(), 'forge-inplace-test-'))

function createTestDB() {
  const dbPath = join(tmpdir(), `forge-loop-inplace-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL,
      current_session_id   TEXT NOT NULL,
            worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
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
    CREATE TABLE review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      scenario TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(project_id, branch, file, line)
    )
  `)

  db.run(`
    CREATE TABLE plans (
      project_id TEXT NOT NULL,
      loop_name TEXT,
      session_id TEXT,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id, loop_name)
    )
  `)

  return { db, dbPath }
}

interface MockV2Client {
  session: {
    messages: (opts: { sessionID: string; directory: string; limit?: number }) => Promise<{ data?: unknown[]; error?: unknown }>
    promptAsync: (opts: { sessionID: string; directory: string; parts: unknown[]; agent?: string; model?: unknown }) => Promise<{ data: unknown; error: unknown | null }>
    abort: (opts: { sessionID: string }) => Promise<unknown>
    delete: (opts: { sessionID: string; directory: string }) => Promise<unknown>
    create: (opts: { title: string; directory: string; permission?: unknown }) => Promise<{ data?: { id: string }; error?: unknown }>
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
}): MockV2Client {
  const callIndex = { value: 0 }
  const sessionCounter = { value: 0 }
  
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
      abort: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      create: async () => {
        sessionCounter.value++
        const id = `session-${sessionCounter.value}`
        return { data: { id } }
      },
    } as any,
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

describe('in-place loop iteration', () => {
  let db: Database
  let dbPath: string
  let loopService: ReturnType<typeof createLoopService>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let testProjectId: string
  let testConfig: PluginConfig
  let v2Client: MockV2Client
  let loopHandler: ReturnType<typeof createLoopEventHandler>
  let codingSessionCounter: { value: number }
  let auditSessionCounter: { value: number }
  let testProjectDir: string

  beforeEach(() => {
    const { db: newDb, dbPath: newPath } = createTestDB()
    db = newDb
    dbPath = newPath
    testProjectDir = join(TEST_PROJECT_DIR_BASE, `test-${Date.now()}`)
    v2Client = createMockV2Client({
      messagesCalls: [],
      promptAsyncCalls: [],
    })
    
    testConfig = {
      loop: {
        enabled: true,
        maxIterations: 0,
        stallTimeoutMs: 60000,
        model: 'anthropic/claude-sonnet-4-20250514',
        auditorModel: 'anthropic/claude-sonnet-4-20250514',
        sandbox: { enabled: false },
      },
      plan: {
        captureOnSave: false,
        autoApprove: false,
      },
      review: {
        enabled: true,
      },
    } as any

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    testProjectId = 'test-inplace-project'
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, testProjectId, createTestLogger() as any)

    loopHandler = createLoopEventHandler(
      loopService,
      {} as any,
      v2Client as unknown as OpencodeClient,
      createTestLogger() as any,
      () => testConfig,
      undefined,
      testProjectId,
      testProjectDir,
    )
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(dbPath, { force: true })
      rmSync(testProjectDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  async function fireIdleEvent(sessionId: string) {
    await loopHandler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          sessionID: sessionId,
          directory: testProjectDir,
          status: { type: 'idle' },
        },
      },
    })
  }

  describe('basic in-place iteration cycle', () => {
    it('should cycle coding → auditing → coding → auditing → terminate when findings clear', async () => {
      const loopName = 'test-inplace-loop-1'
      
      // Insert initial finding so loop doesn't terminate immediately
      reviewFindingsRepo.write({
        projectId: testProjectId,
        branch: 'main',
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test finding 1',
      })

      // Set up initial in-place loop state
      const initialState = {
        active: true,
        sessionId: 'L1',
        loopName,
        worktreeDir: testProjectDir,
        projectDir: testProjectDir,
        worktreeBranch: 'main',
        iteration: 1,
        maxIterations: 0,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: false,
        sandbox: false,
        executionModel: undefined,
        auditorModel: undefined,
        workspaceId: undefined,
        hostSessionId: undefined,
      }

      loopService.setState(loopName, initialState)
      loopService.registerLoopSession('L1', loopName)

      // Fire idle for L1 (coding session)
      await fireIdleEvent('L1')

      // Expect: phase should be 'auditing' and phase should be auditing
      let state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      const auditSessionId1 = state!.sessionId

      // Fire idle for audit session A1
      await fireIdleEvent(auditSessionId1)

      // Expect: phase back to 'coding', phase changed to coding, current_session_id rotated, audit_count === 1
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('coding')
      expect(state?.sessionId).not.toBe('L1')
      expect(state?.auditCount).toBe(1)
      const codingSessionId2 = state!.sessionId

      // Insert another finding so next audit doesn't clear
      reviewFindingsRepo.write({
        projectId: testProjectId,
        branch: 'main',
        file: 'test2.ts',
        line: 2,
        severity: 'warning',
        description: 'Test finding 2',
      })

      // Fire idle for L2 (coding session)
      await fireIdleEvent(codingSessionId2)

      // Expect: phase back to 'auditing', new audit session A2
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      const auditSessionId2 = state!.sessionId

      // Fire idle for audit session A2
      await fireIdleEvent(auditSessionId2)

      // Expect: phase back to 'coding', rotated to L3, audit_count 2, loop still active
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('coding')
      expect(state?.sessionId).not.toBe(codingSessionId2)
      expect(state?.auditCount).toBe(2)
      const codingSessionId3 = state!.sessionId

      // Delete all findings
      const findings = loopService.getOutstandingFindings('main')
      findings.forEach((f) => {
        reviewFindingsRepo.delete(testProjectId, f.file, f.line, f.branch ?? undefined)
      })

      // Fire idle for L3 (coding session)
      await fireIdleEvent(codingSessionId3)

      // Expect: phase should be 'auditing'
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      const auditSessionId3 = state!.sessionId

      // Fire idle for audit session A3
      await fireIdleEvent(auditSessionId3)

      // Expect: loop terminated with 'completed' because findings == 0 and audit_count >= 1
      state = loopService.getActiveState(loopName)
      // getActiveState returns null when loop is no longer active
      expect(state).toBeNull()
      // Check final state via getAnyState which returns completed loops too
      const finalState = loopService.getAnyState(loopName)
      expect(finalState).toBeDefined()
      expect(finalState!.active).toBe(false)
      expect(finalState!.terminationReason).toBe('completed')
    })
  })

  describe('audit phase never re-enters auditing', () => {
    it('should ignore stray idle events for old coding session ids while auditing', async () => {
      const loopName = 'test-inplace-loop-2'
      
      // Insert a finding so loop doesn't terminate
      reviewFindingsRepo.write({
        projectId: testProjectId,
        branch: 'main',
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test finding',
      })

      // Set up initial in-place loop state
      const initialState = {
        active: true,
        sessionId: 'L1',
        loopName,
        worktreeDir: testProjectDir,
        projectDir: testProjectDir,
        worktreeBranch: 'main',
        iteration: 1,
        maxIterations: 0,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: false,
        sandbox: false,
        executionModel: undefined,
        auditorModel: undefined,
        workspaceId: undefined,
        hostSessionId: undefined,
      }

      loopService.setState(loopName, initialState)
      loopService.registerLoopSession('L1', loopName)

      // Fire idle for L1 (coding session) to transition to auditing
      await fireIdleEvent('L1')

      let state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      const auditSessionId = state!.sessionId
      const initialAuditCount = state!.auditCount ?? 0

      // Fire stray idle for OLD coding session L1
      await fireIdleEvent('L1')

      // Expect: state unchanged - still auditing
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      expect(state?.auditCount).toBe(initialAuditCount)
    })
  })

  describe('phase guard rejects coding handler while auditing', () => {
    it('should not create new audit session when idle fired for arbitrary unknown session while auditing', async () => {
      const loopName = 'test-inplace-loop-3'
      
      // Insert a finding so loop doesn't terminate
      reviewFindingsRepo.write({
        projectId: testProjectId,
        branch: 'main',
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test finding',
      })

      // Set up initial in-place loop state
      const initialState = {
        active: true,
        sessionId: 'L1',
        loopName,
        worktreeDir: testProjectDir,
        projectDir: testProjectDir,
        worktreeBranch: 'main',
        iteration: 1,
        maxIterations: 0,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: false,
        sandbox: false,
        executionModel: undefined,
        auditorModel: undefined,
        workspaceId: undefined,
        hostSessionId: undefined,
      }

      loopService.setState(loopName, initialState)
      loopService.registerLoopSession('L1', loopName)

      // Fire idle for L1 (coding session) to transition to auditing
      await fireIdleEvent('L1')

      let state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      const auditSessionId = state!.sessionId
      const initialAuditCount = state!.auditCount ?? 0

      // Fire idle for arbitrary unknown session id
      await fireIdleEvent('unknown-session-xyz')

      // Expect: state unchanged - still auditing, audit_count unchanged
      state = loopService.getActiveState(loopName)
      expect(state?.phase).toBe('auditing')
      expect(state?.auditCount).toBe(initialAuditCount)
    })
  })
})
