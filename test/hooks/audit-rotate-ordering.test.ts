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
import { createFakeForgeClient } from '../helpers/fake-client'
import { recordAuditorHandoff } from '../helpers/loop-handoff'

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

interface LoopHandoffRow {
  id: number
  project_id: string
  loop_name: string
  session_id: string
  role: string
  phase: string
  section_index: number | null
  iteration: number
  payload: string
  status: string
  created_at: number
  resolved_at: number | null
}

const loopDataStore = new Map<string, LoopRowObject>()
const loopLargeStore = new Map<string, { prompt: string | null; last_audit_result: string | null }>()
const plansStore = new Map<string, any>()
const findingsStore = new Map<string, any>()
const handoffsStore = new Map<string, LoopHandoffRow[]>()
let nextHandoffId = 1

function pendingHandoffs(projectId: string, loopName: string): LoopHandoffRow[] {
  return (handoffsStore.get(`${projectId}:${loopName}`) ?? []).filter((row) => row.status === 'pending')
}

function createMockDatabase(): Database {
  return {
    run: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => {
      // UPDATE loop_handoffs SET session_id = ... WHERE status = 'pending' (upsert an existing pending row)
      if (sql.includes('UPDATE loop_handoffs') && sql.includes('SET session_id = ?')) {
        return {
          run: vi.fn((...args: any[]) => {
            const [sessionId, role, phase, sectionIndex, iteration, payload, createdAt, projectId, loopName] = args
            const pending = pendingHandoffs(projectId, loopName)
            if (pending.length === 0) return { changes: 0 }
            const row = pending[pending.length - 1]
            row.session_id = sessionId
            row.role = role
            row.phase = phase
            row.section_index = sectionIndex ?? null
            row.iteration = iteration
            row.payload = payload
            row.created_at = createdAt
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // INSERT INTO loop_handoffs
      if (sql.includes('INSERT INTO loop_handoffs')) {
        return {
          run: vi.fn((...args: any[]) => {
            const [projectId, loopName, sessionId, role, phase, sectionIndex, iteration, payload, createdAt] = args
            const key = `${projectId}:${loopName}`
            const rows = handoffsStore.get(key) ?? []
            rows.push({
              id: nextHandoffId++,
              project_id: projectId,
              loop_name: loopName,
              session_id: sessionId,
              role,
              phase,
              section_index: sectionIndex ?? null,
              iteration,
              payload,
              status: 'pending',
              created_at: createdAt,
              resolved_at: null,
            })
            handoffsStore.set(key, rows)
            return { changes: 1 }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // UPDATE loop_handoffs SET status = 'applied' ... RETURNING
      if (sql.includes('UPDATE loop_handoffs') && sql.includes("status = 'applied'")) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn((...args: any[]) => {
            const [resolvedAt, projectId, loopName, sessionId] = args
            const pending = pendingHandoffs(projectId, loopName).filter((row) => row.session_id === sessionId)
            if (pending.length === 0) return null
            const row = pending[pending.length - 1]
            row.status = 'applied'
            row.resolved_at = resolvedAt
            return { ...row }
          }),
          all: vi.fn(() => []),
        }
      }
      // UPDATE loop_handoffs SET status = 'discarded'
      if (sql.includes('UPDATE loop_handoffs') && sql.includes("status = 'discarded'")) {
        return {
          run: vi.fn((...args: any[]) => {
            const [, projectId, loopName] = args
            let changes = 0
            for (const row of pendingHandoffs(projectId, loopName)) {
              row.status = 'discarded'
              changes += 1
            }
            return { changes }
          }),
          get: vi.fn(),
          all: vi.fn(() => []),
        }
      }
      // SELECT pending handoff
      if (sql.includes('FROM loop_handoffs') && sql.includes("status = 'pending'") && sql.includes('ORDER BY id DESC')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn((...args: any[]) => {
            const [projectId, loopName] = args
            const pending = pendingHandoffs(projectId, loopName)
            return pending.length > 0 ? { ...pending[pending.length - 1] } : null
          }),
          all: vi.fn(() => []),
        }
      }
      // SELECT handoff list
      if (sql.includes('FROM loop_handoffs') && sql.includes('ORDER BY id ASC')) {
        return {
          run: vi.fn(() => ({ changes: 0 })),
          get: vi.fn(),
          all: vi.fn((...args: any[]) => {
            const [projectId, loopName, limit] = args
            const rows = [...(handoffsStore.get(`${projectId}:${loopName}`) ?? [])]
              .sort((a, b) => a.id - b.id)
            const limited = typeof limit === 'number' && limit >= 0 ? rows.slice(0, limit) : rows
            return limited.map((row) => ({ ...row }))
          }),
        }
      }
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

/**
 * Build a ForgeClient fake whose recorded calls are unified, so call ordering
 * across namespaces can be asserted.
 * @param lastRole - The role of the last message in the messages response ('assistant' or 'user')
 */
function makeRotationFake(lastRole: 'assistant' | 'user' = 'assistant') {
  return createFakeForgeClient({
    session: {
      create: async () => ({ id: 'new-code-1' }),
      get: async () => ({ id: 'sess' }),
      messages: async () => [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'test' }] },
        ...(lastRole === 'assistant'
          ? [{ info: { role: 'assistant' as const, finish: 'stop' as const }, parts: [{ type: 'text' as const, text: 'response' }] }]
          : []),
      ],
    },
    workspace: {
      create: async () => ({ id: 'ws-1' }),
    },
  })
}

describe('audit→code rotation ordering', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
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
    handoffsStore.clear()
    nextHandoffId = 1

    loopsRepo = createLoopsRepo(db as any)
    plansRepo = createPlansRepo(db as any)
    reviewFindingsRepo = createReviewFindingsRepo(db as any)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
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

  test('successful audit→code rotation: create→bind order, audit session retained', async () => {
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
    const { client, calls } = makeRotationFake()
    // Use default successful assistant response (no error) to test the
    // !assistantErrorDetected branch in handleAuditingPhase

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      client,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      tempDir,
    )

    // The outstanding finding makes the section dirty, so the auditor hands
    // off without a summary.
    await recordAuditorHandoff(handler.loop, 'audit-1')

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'audit-1',
        },
      },
    })

    const createIndex = calls.findIndex(c => c.method === 'session.create')
    const restoreIndex = calls.findIndex(c => c.method === 'workspace.warp')
    const deleteIndex = calls.findIndex(c =>
      c.method === 'session.delete' && (c.params as any).sessionID === 'audit-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace. The audit session is
    // retained as the standby for the next same-section attempt, so it is not deleted.
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(deleteIndex).toBe(-1)

    const after = loopService.getActiveState(loopName)!
    expect(after.phase).toBe('coding')
    expect(after.sessionId).toBe('new-code-1')

    const restoreCall = calls.find(c => c.method === 'workspace.warp')
    expect((restoreCall?.params as any).id).toBe('ws-1')
    expect((restoreCall?.params as any).sessionID).toBe('new-code-1')
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
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('audit-fail-1', loopName)

    // Create a separate mock for failure path - no assistant message so it triggers rotation
    const { client, calls } = makeRotationFake('user')

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      client,
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

    const createIndex = calls.findIndex(c => c.method === 'session.create')
    const restoreIndex = calls.findIndex(c => c.method === 'workspace.warp')
    const deleteIndex = calls.findIndex(c =>
      c.method === 'session.delete' && (c.params as any).sessionID === 'audit-fail-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace → delete old session
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(restoreIndex).toBeLessThan(deleteIndex)

    const restoreCall = calls.find(c => c.method === 'workspace.warp')
    expect((restoreCall?.params as any).id).toBe('ws-1')
  })
})
