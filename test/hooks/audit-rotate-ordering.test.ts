import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopState } from '../../src/loop/state'

interface Database {
  run: (sql: string) => void
  exec: (sql: string) => void
  prepare: (sql: string) => { 
    run: (...args: any[]) => { changes: number }
    get: (...args: any[]) => unknown
    all: (...args: any[]) => unknown[]
  }
  close: () => void
  transaction: (fn: () => void) => () => void
}

// In-memory store for loop data
interface LoopRowObject {
  project_id: string
  loop_name: string
  status: string
  current_session_id: string
  worktree: number
  worktree_dir: string
  worktree_branch: string | null
  project_dir: string
  max_iterations: number
  iteration: number
  audit_count: number
  error_count: number
  phase: string
  execution_model: string | null
  auditor_model: string | null
  model_failed: number
  sandbox: number
  sandbox_container: string | null
  started_at: number
  completed_at: number | null
  termination_reason: string | null
  completion_summary: string | null
  workspace_id: string | null
  host_session_id: string | null
}

const loopDataStore = new Map<string, LoopRowObject>()
const loopLargeStore = new Map<string, { prompt: string | null; last_audit_result: string | null }>()
const plansStore = new Map<string, any>()
const findingsStore = new Map<string, any>()

function createMockDatabase(): Database {
  return {
    run: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => {
      // INSERT INTO loops
      if (sql.includes('INSERT INTO loops') && sql.includes('VALUES')) {
        return {
          run: vi.fn((...args: any[]) => {
            const key = `${args[0]}:${args[1]}` // project_id:loop_name
            loopDataStore.set(key, {
              project_id: args[0],
              loop_name: args[1],
              status: args[2],
              current_session_id: args[3],
              worktree: args[4],
              worktree_dir: args[5],
              worktree_branch: args[6],
              project_dir: args[7],
              max_iterations: args[8],
              iteration: args[9],
              audit_count: args[10],
              error_count: args[11],
              phase: args[12],
              execution_model: args[13],
              auditor_model: args[14],
              model_failed: args[15],
              sandbox: args[16],
              sandbox_container: args[17],
              started_at: args[18],
              completed_at: args[19],
              termination_reason: args[20],
              completion_summary: args[21],
              workspace_id: args[22],
              host_session_id: args[23],
            })
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // INSERT INTO loop_large_fields
      if (sql.includes('INSERT INTO loop_large_fields')) {
        return {
          run: vi.fn((...args: any[]) => {
            const key = `${args[0]}:${args[1]}`
            loopLargeStore.set(key, {
              prompt: args[2],
              last_audit_result: args[3],
            })
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // SELECT FROM loops WHERE project_id = ? AND loop_name = ?
      if (sql.includes('SELECT') && sql.includes('FROM loops') && sql.includes('loop_name = ?')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn((...args: any[]) => {
            const key = `${args[0]}:${args[1]}`
            return loopDataStore.get(key) || null
          }),
          all: vi.fn(() => []),
        }
      }
      // SELECT FROM loops WHERE project_id = ? AND current_session_id = ?
      if (sql.includes('SELECT') && sql.includes('FROM loops') && sql.includes('current_session_id = ?')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn((...args: any[]) => {
            const projectId = args[0]
            const sessionId = args[1]
            for (const row of loopDataStore.values()) {
              if (row.project_id === projectId && row.current_session_id === sessionId) {
                return row
              }
            }
            return null
          }),
          all: vi.fn(() => []),
        }
      }
      // INSERT OR REPLACE INTO plans
      if (sql.includes('INSERT OR REPLACE INTO plans')) {
        return {
          run: vi.fn((...args: any[]) => {
            const key = `${args[0]}:${args[1] || args[2]}`
            plansStore.set(key, args)
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // SELECT FROM plans
      if (sql.includes('SELECT') && sql.includes('FROM plans')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // INSERT INTO review_findings (may have ON CONFLICT)
      if (sql.includes('INSERT') && sql.includes('review_findings')) {
        return {
          run: vi.fn((...args: any[]) => {
            const key = `${args[0]}:${args[1]}:${args[2]}:${args[3]}`
            findingsStore.set(key, args)
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // SELECT FROM review_findings WHERE project_id = ? AND loop_name = ?
      if (sql.includes('SELECT') && sql.includes('FROM review_findings') && sql.includes('loop_name = ?')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn(),
          all: vi.fn((...args: any[]) => {
            const projectId = args[0]
            const loopName = args[1]
            const results = []
            for (const [key, value] of findingsStore.entries()) {
              if (key.startsWith(`${projectId}:${loopName}:`)) {
                // Convert stored args to row format
                results.push({
                  project_id: value[0],
                  loop_name: value[1],
                  file: value[2],
                  line: value[3],
                  severity: value[4],
                  description: value[5],
                  scenario: value[6],
                  created_at: value[7],
                })
              }
            }
            return results
          }),
        }
      }
      // SELECT FROM review_findings (other queries)
      if (sql.includes('SELECT') && sql.includes('FROM review_findings')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // DELETE FROM review_findings WHERE project_id = ? AND loop_name = ? AND file = ? AND line = ?
      if (sql.includes('DELETE FROM review_findings') && sql.includes('loop_name')) {
        return {
          run: vi.fn((...args: any[]) => {
            const projectId = args[0]
            const loopName = args[1]
            const file = args[2]
            const line = args[3]
            const key = `${projectId}:${loopName}:${file}:${line}`
            const deleted = findingsStore.delete(key)
            return { changes: deleted ? 1 : 0 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // DELETE FROM review_findings WHERE project_id = ? AND file = ? AND line = ?
      if (sql.includes('DELETE FROM review_findings')) {
        return {
          run: vi.fn((...args: any[]) => {
            return { changes: 0 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // UPDATE loops SET current_session_id
      if (sql.includes('UPDATE loops SET') && sql.includes('current_session_id')) {
        return {
          run: vi.fn((...args: any[]) => {
            // Args: sessionId, phase, iteration, auditCount, projectId, loopName
            const projectId = args[4]
            const loopName = args[5]
            const key = `${projectId}:${loopName}`
            const existing = loopDataStore.get(key)
            if (existing) {
              existing.current_session_id = args[0]
              existing.phase = args[1]
              if (args[2] !== undefined) existing.iteration = args[2]
              if (args[3] !== undefined) existing.audit_count = args[3]
            }
            return { changes: existing ? 1 : 0 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // Default fallback
      return {
        run: vi.fn(() => ({ changes: 1 })),
        get: vi.fn(),
        all: vi.fn(() => []),
      }
    }),
    close: vi.fn(),
    transaction: vi.fn((fn: () => void) => {
      return vi.fn(() => fn())
    }),
  }
}

interface CallRecord {
  kind: string
  args: unknown
}

interface MockV2Client {
  session: {
    create: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: { id: string }; error?: unknown }>>>
    promptAsync: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
    delete: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: boolean }>>>
    get: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: { permission?: unknown }; error?: unknown }>>>
    messages: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: any[]; error?: unknown }>>>
    abort: ReturnType<typeof vi.fn<(params: any) => Promise<void>>>
  }
  experimental: {
    workspace: {
      create: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: { id: string }; error?: unknown }>>>
      warp: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
    }
  }
  tui: {
    selectSession: ReturnType<typeof vi.fn<(params: any) => Promise<void>>>
    publish: ReturnType<typeof vi.fn<(params: any) => Promise<void>>>
  }
}

interface MockClient {
  session: {
    create: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: { id: string } }>>>
    messages: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: any[] }>>>
    promptAsync: ReturnType<typeof vi.fn<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
  }
}

function createMockV2Client(callTracker?: CallRecord[], messagesRole?: 'assistant' | 'user'): MockV2Client {
  const tracker = callTracker ?? []
  const lastRole = messagesRole ?? 'assistant'
  return {
    session: {
      create: vi.fn(async (params: any) => {
        tracker.push({ kind: 'create', args: params })
        return { data: { id: 'new-code-1' } }
      }),
      promptAsync: vi.fn(async (params: any) => {
        tracker.push({ kind: 'prompt', args: params })
        return { data: {} }
      }),
      delete: vi.fn(async (params: any) => {
        tracker.push({ kind: 'delete', args: params })
        return { data: true }
      }),
      get: vi.fn(async () => ({ data: { permission: {} } })),
      messages: vi.fn(async () => ({ data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'test' }] },
        ...(lastRole === 'assistant' ? [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'audit findings: none' }] }] : []),
      ] })),
      abort: vi.fn(async () => {}),
    },
    experimental: {
      workspace: {
        create: vi.fn(async (params: any) => {
          tracker.push({ kind: 'workspace-create', args: params })
          return { data: { id: 'ws-1' } }
        }),
        warp: vi.fn(async (params: any) => {
          tracker.push({ kind: 'restore', args: params })
          return { data: {} }
        }),
      },
    },
    tui: {
      selectSession: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
    },
  }
}

function createMockClient(): MockClient {
  return {
    session: {
      create: vi.fn(() => Promise.resolve({ data: { id: 'sess_mock_123' } })),
      messages: vi.fn(() => Promise.resolve({ data: [] })),
      promptAsync: vi.fn(() => Promise.resolve({ data: {} })),
    },
  }
}

describe('audit→code rotation ordering', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let mockV2: MockV2Client
  let mockClient: MockClient
  let callTracker: CallRecord[]
  const projectId = 'test-project'

  const mockLogger: Logger = {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-rotate-ordering-test-'))
    db = createMockDatabase()

    // Clear stores
    loopDataStore.clear()
    loopLargeStore.clear()
    plansStore.clear()
    findingsStore.clear()

    loopsRepo = createLoopsRepo(db as any)
    plansRepo = createPlansRepo(db as any)
    reviewFindingsRepo = createReviewFindingsRepo(db as any)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
    callTracker = []
    mockV2 = createMockV2Client(callTracker)
    mockClient = createMockClient()
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup
    }
    vi.clearAllMocks()
  })

  test('successful audit→code rotation: create→bind→delete order', async () => {
    const loopName = 'test-rotate-order'
    const worktreeDir = join(tempDir, 'worktree')
    
    const state: LoopState = {
      active: true,
      sessionId: 'audit-1',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing',
      status: 'running',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
      workspaceId: 'ws-1',
      currentSectionIndex: 0,
      totalSections: 1,
      finalAuditDone: false,
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('audit-1', loopName)

    // Add an outstanding review finding so the successful audit path triggers
    // rotation instead of termination (checkAuditClearAndTerminate returns false)
    reviewFindingsRepo.write({
      projectId,
      loopName,
      file: 'src/example.ts',
      line: 10,
      severity: 'bug',
      description: 'Test finding to prevent audit all-clear',
    })

    // Create mock that returns successful assistant response to exercise the
    // successful audit→code rotation path (not the error continuation path)
    const successCallTracker: CallRecord[] = []
    const successMockV2 = createMockV2Client(successCallTracker, 'assistant')
    // Use default successful assistant response (no error) to test the
    // !assistantErrorDetected branch in handleAuditingPhase

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      mockClient as any,
      successMockV2 as any,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'audit-1',
        },
      },
    })

    const createIndex = successCallTracker.findIndex(c => c.kind === 'create')
    const restoreIndex = successCallTracker.findIndex(c => c.kind === 'restore')
    const deleteIndex = successCallTracker.findIndex(c =>
      c.kind === 'delete' && (c.args as any).sessionID === 'audit-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace → delete old session
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(restoreIndex).toBeLessThan(deleteIndex)

    const restoreCall = successCallTracker.find(c => c.kind === 'restore')
    expect((restoreCall?.args as any).id).toBe('ws-1')
    expect((restoreCall?.args as any).sessionID).toBe('new-code-1')
  })

  test('audit failure rotation: create→bind→delete order', async () => {
    const loopName = 'test-rotate-failure-order'
    const worktreeDir = join(tempDir, 'worktree')
    
    const state: LoopState = {
      active: true,
      sessionId: 'audit-fail-1',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing',
      status: 'running',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
      workspaceId: 'ws-1',
      currentSectionIndex: 0,
      totalSections: 1,
      finalAuditDone: false,
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('audit-fail-1', loopName)

    // Create a separate mock for failure path - no assistant message so it triggers rotation
    const failureCallTracker: CallRecord[] = []
    const failureMockV2 = createMockV2Client(failureCallTracker, 'user')

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      mockClient as any,
      failureMockV2 as any,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'audit-fail-1',
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    })

    const createIndex = failureCallTracker.findIndex(c => c.kind === 'create')
    const restoreIndex = failureCallTracker.findIndex(c => c.kind === 'restore')
    const deleteIndex = failureCallTracker.findIndex(c =>
      c.kind === 'delete' && (c.args as any).sessionID === 'audit-fail-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace → delete old session
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(restoreIndex).toBeLessThan(deleteIndex)

    const restoreCall = failureCallTracker.find(c => c.kind === 'restore')
    expect((restoreCall?.args as any).id).toBe('ws-1')
  })
})
