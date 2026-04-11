import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createKvQuery } from '../src/storage/kv-queries'
import { createKvService } from '../src/services/kv'
import { createLoopService, migrateRalphKeys, buildCompletionSignalInstructions, fetchSessionOutput, type LoopState, generateUniqueName } from '../src/services/loop'

const TEST_DIR = '/tmp/opencode-manager-loop-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
  return db
}

function createMockLogger() {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('LoopService', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('state CRUD operations', () => {
    const state = {
      active: true,
      sessionId: 'session-123',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 5,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('session-123', state)
    const retrieved = loopService.getActiveState('session-123')
    expect(retrieved).toEqual(state)

    loopService.setState('session-123', { ...state, iteration: 2 })
    const updated = loopService.getActiveState('session-123')
    expect(updated?.iteration).toBe(2)

    loopService.deleteState('session-123')
    const deleted = loopService.getActiveState('session-123')
    expect(deleted).toBeNull()
  })

  test('getState returns null for inactive state', () => {
    const inactiveState = {
      active: false,
      sessionId: 'session-456',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('session-456', inactiveState)
    const retrieved = loopService.getActiveState('session-456')
    expect(retrieved).toBeNull()
  })

  test('getActiveState returns null for non-existent session', () => {
    const retrieved = loopService.getActiveState('non-existent')
    expect(retrieved).toBeNull()
  })

  test('checkCompletionSignal matches exact phrase', () => {
    const text = 'Some response text ALL_PHASES_COMPLETE more text'
    expect(loopService.checkCompletionSignal(text, 'ALL_PHASES_COMPLETE')).toBe(true)
  })

  test('checkCompletionSignal returns false when phrase not present', () => {
    const text = 'Some response text without the phrase'
    expect(loopService.checkCompletionSignal(text, 'ALL_PHASES_COMPLETE')).toBe(false)
  })

  test('checkCompletionSignal returns false when phrase does not match', () => {
    const text = 'Some response NOT_COMPLETE text'
    expect(loopService.checkCompletionSignal(text, 'ALL_PHASES_COMPLETE')).toBe(false)
  })

  test('checkCompletionSignal requires exact match', () => {
    const text = 'Response ALL_PHASES_COMPLETE text'
    expect(loopService.checkCompletionSignal(text, 'NOT_COMPLETE')).toBe(false)
  })

  test('checkCompletionSignal is case-insensitive', () => {
    const text = 'Some response all_phases_complete more text'
    expect(loopService.checkCompletionSignal(text, 'ALL_PHASES_COMPLETE')).toBe(true)
  })

  test('buildContinuationPrompt includes iteration number', () => {
    const state = {
      active: true,
      sessionId: 'session-789',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 3,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'My test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('Loop iteration 3')
    expect(prompt).toContain('My test prompt')
  })

  test('buildContinuationPrompt includes completion promise instruction', () => {
    const state = {
      active: true,
      sessionId: 'session-789',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 0,
      completionSignal: 'COMPLETE_TASK',
      startedAt: new Date().toISOString(),
      prompt: 'My test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('[Loop iteration 1 | To stop: output COMPLETE_TASK (ONLY after all verification commands pass AND all phase acceptance criteria are met)]')
  })

  test('buildContinuationPrompt includes max iterations when no promise', () => {
    const state = {
      active: true,
      sessionId: 'session-789',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 10,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'My test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('[Loop iteration 2 / 10]')
  })

  test('buildContinuationPrompt shows unlimited message when no promise and no max', () => {
    const state = {
      active: true,
      sessionId: 'session-789',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'My test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('[Loop iteration 1 | No completion promise set - loop runs until cancelled]')
  })

  test('state persists across service recreation', () => {
    const state = {
      active: true,
      sessionId: 'session-persist',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 5,
      maxIterations: 10,
      completionSignal: 'PERSIST_TEST',
      startedAt: new Date().toISOString(),
      prompt: 'Persistence test',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('session-persist', state)

    const newKvService = createKvService(db)
    const newLoopService = createLoopService(newKvService, projectId, createMockLogger())

    const retrieved = newLoopService.getActiveState('session-persist')
    expect(retrieved).toEqual(state)
  })

  test('buildAuditPrompt returns audit instruction', () => {
    const state = {
      active: true,
      sessionId: 'session-audit',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildAuditPrompt(state)
    expect(prompt).toContain('Review the code changes')
    expect(prompt).toContain('bugs, logic errors, missing error handling')
    expect(prompt).toContain('No issues found')
    expect(prompt).toContain('do not direct the agent to')
  })

  test('buildContinuationPrompt appends audit findings when provided', () => {
    const state = {
      active: true,
      sessionId: 'session-audit',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    const auditFindings = 'Found a bug in line 10'
    const prompt = loopService.buildContinuationPrompt(state, auditFindings)
    expect(prompt).toContain('Loop iteration 2')
    expect(prompt).toContain('Test prompt')
    expect(prompt).toContain('The code auditor reviewed your changes')
    expect(prompt).toContain('do not dismiss findings as unrelated to the task')
    expect(prompt).toContain('Found a bug in line 10')
  })

  test('buildContinuationPrompt without audit findings does not append section', () => {
    const state = {
      active: true,
      sessionId: 'session-audit',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('Loop iteration 2')
    expect(prompt).toContain('Test prompt')
    expect(prompt).not.toContain('The following issues were found')
  })

  test('buildContinuationPrompt with audit findings includes completion reminder', () => {
    const state = {
      active: true,
      sessionId: 'session-audit',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 0,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    const auditFindings = 'Found a bug in line 10'
    const prompt = loopService.buildContinuationPrompt(state, auditFindings)
    expect(prompt).toContain('After fixing all issues, output the completion signal')
    expect(prompt).toContain('without creating a plan or asking for approval')
  })

  test('listActive returns only active states', () => {
    const activeState1 = {
      active: true,
      sessionId: 'active-1',
      worktreeName: 'worktree-1',
      worktreeDir: '/path/to/worktree1',
      worktreeBranch: 'opencode/loop-worktree-1',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Active prompt 1',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const activeState2 = {
      active: true,
      sessionId: 'active-2',
      worktreeName: 'worktree-2',
      worktreeDir: '/path/to/worktree2',
      worktreeBranch: 'opencode/loop-worktree-2',
      iteration: 2,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Active prompt 2',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    const inactiveState = {
      active: false,
      sessionId: 'inactive-1',
      worktreeName: 'worktree-3',
      worktreeDir: '/path/to/worktree3',
      worktreeBranch: 'opencode/loop-worktree-3',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Inactive prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('active-1', activeState1)
    loopService.setState('active-2', activeState2)
    loopService.setState('inactive-1', inactiveState)

    const active = loopService.listActive()
    expect(active.length).toBe(2)
    expect(active.map((s) => s.sessionId)).toContain('active-1')
    expect(active.map((s) => s.sessionId)).toContain('active-2')
    expect(active.map((s) => s.sessionId)).not.toContain('inactive-1')
  })

  test('findByWorktreeName returns state by worktree name', () => {
    const state1 = {
      active: true,
      sessionId: 'session-1',
      worktreeName: 'unique-worktree-name',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-unique-worktree-name',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('session-1', state1)

    const found = loopService.findByWorktreeName('unique-worktree-name')
    expect(found).toEqual(state1)

    const notFound = loopService.findByWorktreeName('non-existent')
    expect(notFound).toBeNull()
  })

  test('state with errorCount and auditCount persists correctly', () => {
    const state = {
      active: true,
      sessionId: 'session-err',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 5,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 2,
      auditCount: 1,
      terminationReason: undefined,
    }
    loopService.setState('session-err', state)
    const retrieved = loopService.getActiveState('session-err')
    expect(retrieved?.errorCount).toBe(2)
    expect(retrieved?.auditCount).toBe(1)
  })

  test('state defaults errorCount to 0', () => {
    const state = {
      active: true,
      sessionId: 'session-default',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
    loopService.setState('session-default', state)
    const retrieved = loopService.getActiveState('session-default')
    expect(retrieved?.errorCount).toBe(0)
    expect(retrieved?.auditCount).toBe(0)
  })

  test('state with inPlace flag persists correctly', () => {
    const inPlaceState = {
      active: true,
      sessionId: 'session-inplace',
      worktreeName: 'inplace-worktree',
      worktreeDir: '/path/to/project',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'In-place test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
      worktree: false,
    }
    loopService.setState('session-inplace', inPlaceState)
    const retrieved = loopService.getActiveState('session-inplace')
    expect(retrieved?.worktree).toBe(false)
    expect(retrieved?.worktreeDir).toBe('/path/to/project')
  })

  test('findByWorktreeName works with inPlace state', () => {
    const inPlaceState = {
      active: true,
      sessionId: 'session-inplace-2',
      worktreeName: 'unique-inplace-name',
      worktreeDir: '/path/to/project',
      worktreeBranch: 'develop',
      iteration: 2,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 1,
      worktree: false,
    }
    loopService.setState('session-inplace-2', inPlaceState)
    const found = loopService.findByWorktreeName('unique-inplace-name')
    expect(found).toEqual(inPlaceState)
    expect(found?.worktree).toBe(false)
  })

  test('buildContinuationPrompt works with inPlace state', () => {
    const inPlaceState = {
      active: true,
      sessionId: 'session-inplace-3',
      worktreeName: 'inplace-prompt-test',
      worktreeDir: '/path/to/project',
      worktreeBranch: 'main',
      iteration: 3,
      maxIterations: 0,
      completionSignal: 'COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'In-place prompt test',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
      worktree: false,
    }
    const prompt = loopService.buildContinuationPrompt(inPlaceState)
    expect(prompt).toContain('Loop iteration 3')
    expect(prompt).toContain('In-place prompt test')
    expect(prompt).toContain('COMPLETE')
  })

  test('buildContinuationPrompt with audit findings works with inPlace state', () => {
    const inPlaceState = {
      active: true,
      sessionId: 'session-inplace-4',
      worktreeName: 'inplace-audit-test',
      worktreeDir: '/path/to/project',
      worktreeBranch: 'main',
      iteration: 2,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'In-place audit test',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
      worktree: false,
    }
    const auditFindings = 'Bug found in component'
    const prompt = loopService.buildContinuationPrompt(inPlaceState, auditFindings)
    expect(prompt).toContain('Loop iteration 2')
    expect(prompt).toContain('In-place audit test')
    expect(prompt).toContain('The code auditor reviewed your changes')
    expect(prompt).toContain('do not dismiss findings as unrelated to the task')
    expect(prompt).toContain('Bug found in component')
  })

  test('getMinAudits returns default when not configured', () => {
    const minAudits = loopService.getMinAudits()
    expect(minAudits).toBe(1)
  })

  test('getMinAudits returns configured value', () => {
    const kvService = createKvService(db)
    const customLoopService = createLoopService(kvService, projectId, createMockLogger(), { minAudits: 3 })
    expect(customLoopService.getMinAudits()).toBe(3)
  })
})

describe('Stall Detection', () => {
  test('getStallInfo returns null when no watchdog running', () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger())
    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any
    const mockV2Client = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const { createLoopEventHandler } = require('../src/hooks/loop')
    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const info = handler.getStallInfo('test')
    expect(info).toBeNull()
  })

  test('startWatchdog initializes stall state', () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger(), { stallTimeoutMs: 100 })
    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any
    const mockV2Client = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const { createLoopEventHandler } = require('../src/hooks/loop')
    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const sessionId = 'test-session'
    const worktreeName = 'test'
    loopService.setState(worktreeName, {
      active: true,
      sessionId,
      worktreeName,
      worktreeDir: '/tmp/test',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'test',
      phase: 'coding',
      audit: false,
      errorCount: 0,
      auditCount: 0,
    })

    handler.startWatchdog(worktreeName)

    const info = handler.getStallInfo(worktreeName)
    expect(info).not.toBeNull()
    expect(info?.consecutiveStalls).toBe(0)
    expect(info?.lastActivityTime).toBeDefined()
    expect(Date.now() - info!.lastActivityTime).toBeLessThan(100)
  })

  test('session.created event tracks child sessions', async () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger(), { stallTimeoutMs: 1000 })
    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any
    const mockV2Client = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const { createLoopEventHandler } = require('../src/hooks/loop')
    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const parentId = 'parent-session'
    const childId = 'child-session'
    const worktreeName = 'test'

    loopService.setState(worktreeName, {
      active: true,
      sessionId: parentId,
      worktreeName: 'test',
      worktreeDir: '/tmp/test',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'test',
      phase: 'coding',
      audit: false,
      errorCount: 0,
      auditCount: 0,
    })

    handler.startWatchdog(worktreeName)
    const initialInfo = handler.getStallInfo(worktreeName)
    const initialTime = initialInfo?.lastActivityTime

    await handler.onEvent({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: childId,
            parentID: parentId,
          },
        },
      },
    })

    const updatedInfo = handler.getStallInfo(worktreeName)
    expect(updatedInfo?.lastActivityTime).toBeGreaterThanOrEqual(initialTime!)
  })

  test('session.status event updates activity time', async () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger(), { stallTimeoutMs: 1000 })
    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any
    const mockV2Client = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const { createLoopEventHandler } = require('../src/hooks/loop')
    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const sessionId = 'test-session'
    const worktreeName = 'test'
    loopService.setState(worktreeName, {
      active: true,
      sessionId,
      worktreeName: 'test',
      worktreeDir: '/tmp/test',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'test',
      phase: 'coding',
      audit: false,
      errorCount: 0,
      auditCount: 0,
    })

    handler.startWatchdog(worktreeName)
    const initialInfo = handler.getStallInfo(worktreeName)
    const initialTime = initialInfo?.lastActivityTime

    await new Promise(resolve => setTimeout(resolve, 10))

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          sessionID: sessionId,
        },
      },
    })

    const updatedInfo = handler.getStallInfo(worktreeName)
    expect(updatedInfo?.lastActivityTime).toBeGreaterThanOrEqual(initialTime!)
  })

  test('stopWatchdog cleans up all state', () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger(), { stallTimeoutMs: 1000 })
    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any
    const mockV2Client = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const { createLoopEventHandler } = require('../src/hooks/loop')
    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const sessionId = 'test-session'
    const worktreeName = 'test'
    loopService.setState(worktreeName, {
      active: true,
      sessionId,
      worktreeName: 'test',
      worktreeDir: '/tmp/test',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'test',
      phase: 'coding',
      audit: false,
      errorCount: 0,
      auditCount: 0,
    })

    handler.startWatchdog(worktreeName)
    expect(handler.getStallInfo(worktreeName)).not.toBeNull()

    handler.clearAllRetryTimeouts()
    expect(handler.getStallInfo(worktreeName)).toBeNull()
  })
})

describe('Minimum Audits', () => {
  test('getMinAudits returns configured value', () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger(), { minAudits: 3 })
    expect(loopService.getMinAudits()).toBe(3)
  })
})

describe('reconcileStale', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('marks active loops as shutdown', () => {
    const state = {
      active: true,
      sessionId: 'session-stale',
      worktreeName: 'stale-worktree',
      worktreeDir: '/tmp/stale',
      worktreeBranch: 'main',
      iteration: 3,
      maxIterations: 10,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
    loopService.setState('stale-worktree', state)
    expect(loopService.listActive()).toHaveLength(1)

    const count = loopService.reconcileStale()
    expect(count).toBe(1)
    expect(loopService.listActive()).toHaveLength(0)

    const recent = loopService.listRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].terminationReason).toBe('shutdown')
    expect(recent[0].completedAt).toBeTruthy()
  })

  test('returns 0 when no stale loops exist', () => {
    expect(loopService.reconcileStale()).toBe(0)
  })
})

describe('hasOutstandingFindings', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('returns false when no findings exist', () => {
    expect(loopService.hasOutstandingFindings()).toBe(false)
  })

  test('returns true when findings exist', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'test-branch' })
    expect(loopService.hasOutstandingFindings()).toBe(true)
  })

  test('returns false after findings are deleted', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'test-branch' })
    expect(loopService.hasOutstandingFindings()).toBe(true)
    kvService.delete(projectId, 'review-finding:src/index.ts:42')
    expect(loopService.hasOutstandingFindings()).toBe(false)
  })

  test('getOutstandingFindings returns empty array when no findings exist', () => {
    expect(loopService.getOutstandingFindings()).toEqual([])
  })

  test('getOutstandingFindings returns entries when findings exist', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'test-branch' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'missing error handling', branch: 'test-branch' })
    const findings = loopService.getOutstandingFindings()
    expect(findings).toHaveLength(2)
    expect(findings.map((f) => f.key)).toContain('review-finding:src/index.ts:42')
    expect(findings.map((f) => f.key)).toContain('review-finding:src/utils.ts:10')
  })

  test('returns false when findings exist on a different branch', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'other-branch' })
    expect(loopService.hasOutstandingFindings('feature/main')).toBe(false)
  })

  test('returns true only for findings on the specified branch', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'feature/main' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'bug', branch: 'other-branch' })
    expect(loopService.hasOutstandingFindings('feature/main')).toBe(true)
  })

  test('returns all findings when no branch specified', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'branch-a' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'bug', branch: 'branch-b' })
    expect(loopService.hasOutstandingFindings()).toBe(true)
  })

  test('getOutstandingFindings filters by branch', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'feature/main' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'bug', branch: 'other-branch' })
    const findings = loopService.getOutstandingFindings('feature/main')
    expect(findings).toHaveLength(1)
    expect(findings[0].key).toBe('review-finding:src/index.ts:42')
  })

  test('getOutstandingFindings returns all when no branch specified', () => {
    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'branch-a' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'bug', branch: 'branch-b' })
    expect(loopService.getOutstandingFindings()).toHaveLength(2)
  })
})

describe('buildContinuationPrompt with outstanding findings', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('buildContinuationPrompt includes outstanding findings when present', () => {
    const state = {
      active: true,
      sessionId: 'session-findings',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 3,
      maxIterations: 0,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'opencode/loop-test' })
    kvService.set(projectId, 'review-finding:src/utils.ts:10', { description: 'missing error handling', branch: 'opencode/loop-test' })

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).toContain('Outstanding Review Findings (2)')
    expect(prompt).toContain('blocking loop completion')
    expect(prompt).toContain('`review-finding:src/index.ts:42`')
    expect(prompt).toContain('`review-finding:src/utils.ts:10`')
  })

  test('buildContinuationPrompt excludes findings section when no findings exist', () => {
    const state = {
      active: true,
      sessionId: 'session-no-findings',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 0,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).not.toContain('Outstanding Review Findings')
  })

  test('buildContinuationPrompt includes both audit findings and outstanding findings', () => {
    const state = {
      active: true,
      sessionId: 'session-both',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 3,
      maxIterations: 0,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    kvService.set(projectId, 'review-finding:src/api.ts:8', { description: 'logic error', branch: 'opencode/loop-test' })

    const prompt = loopService.buildContinuationPrompt(state, 'Found a bug in line 10')
    expect(prompt).toContain('The code auditor reviewed your changes')
    expect(prompt).toContain('Found a bug in line 10')
    expect(prompt).toContain('Outstanding Review Findings (1)')
    expect(prompt).toContain('`review-finding:src/api.ts:8`')
  })

  test('buildContinuationPrompt excludes findings from other branches', () => {
    const state = {
      active: true,
      sessionId: 'session-branch-filter',
      worktreeName: 'test-worktree',
      worktreeDir: '/path/to/worktree',
      worktreeBranch: 'opencode/loop-test',
      iteration: 2,
      maxIterations: 0,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    kvService.set(projectId, 'review-finding:src/index.ts:42', { description: 'unused import', branch: 'other-branch' })

    const prompt = loopService.buildContinuationPrompt(state)
    expect(prompt).not.toContain('Outstanding Review Findings')
  })
})

describe('session rotation', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('rotates session on coding phase iteration boundary', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const oldSessionId = 'old-session-id'
    const newSessionId = 'new-session-id'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: newSessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId: oldSessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(oldSessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: oldSessionId },
      },
    })

    const oldState = loopService.getActiveState('test-worktree')
    expect(oldState).not.toBeNull()
    expect(oldState?.sessionId).toBe(newSessionId)

    const newState = loopService.getActiveState('test-worktree')
    expect(newState).not.toBeNull()
    expect(newState?.iteration).toBe(2)
    expect(newState?.sessionId).toBe(newSessionId)
  })

  test('rotates session on auditing phase completion', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const oldSessionId = 'old-session-id'
    const newSessionId = 'new-session-id'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'No issues found.' }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: newSessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'No issues found.' }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId: oldSessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(oldSessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: oldSessionId },
      },
    })

    const newState = loopService.getActiveState('test-worktree')
    expect(newState).not.toBeNull()
    expect(newState?.phase).toBe('coding')
    expect(newState?.iteration).toBe(2)
    expect(newState?.sessionId).toBe(newSessionId)
  })

  test('falls back to existing session when rotation fails', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'existing-session-id'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: 'test-session' }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: undefined, error: 'connection failed' }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    const existingState = loopService.getActiveState('test-worktree')
    expect(existingState).not.toBeNull()
    expect(existingState?.iteration).toBe(2)
    expect(existingState?.sessionId).toBe(sessionId)
  })
})

describe('Assistant Error Detection', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('detects assistant error in coding phase and triggers error handling', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'error-session'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({
          data: [
            {
              info: {
                role: 'assistant',
                error: { name: 'ProviderError', data: { message: 'Model not found' } },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    const updatedState = loopService.getActiveState('test-worktree')
    expect(updatedState?.errorCount).toBe(1)
    expect(updatedState?.modelFailed).toBe(true)
  })

  test('detects assistant error in auditing phase and triggers error handling', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'audit-error-session'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({
          data: [
            {
              info: {
                role: 'assistant',
                error: { name: 'AuthError', data: { message: 'Authentication failed' } },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    const updatedState = loopService.getActiveState('test-worktree')
    expect(updatedState?.errorCount).toBe(1)
    expect(updatedState?.modelFailed).toBe(true)
  })

  test('session.error event with non-abort error sets modelFailed flag', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'session-error-test'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: {
            name: 'ProviderError',
            data: { message: 'Model not found' },
          },
        },
      },
    })

    const updatedState = loopService.getActiveState('test-worktree')
    expect(updatedState?.modelFailed).toBe(true)
  })

  test('session.error event with abort error terminates loop immediately', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'abort-session'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: {
            name: 'MessageAbortedError',
          },
        },
      },
    })

    const updatedState = loopService.getActiveState('test-worktree')
    expect(updatedState).toBeNull()
  })

  test('modelFailed flag causes default model usage in coding phase', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'model-fail-session'

    let modelUsed: string | undefined

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async (params: any) => {
          modelUsed = params.model
          return { data: undefined, error: undefined }
        },
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({
      loop: { model: 'custom/model' },
      executionModel: 'execution/model',
      auditorModel: undefined,
    })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
      modelFailed: true,
    }

    loopService.setState('test-worktree', state)

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    expect(modelUsed).toBeUndefined()
  })

  test('modelFailed resets after successful iteration in coding phase', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'model-reset-session'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'model-reset-test',
      worktreeDir: '/tmp/model-reset',
      worktreeBranch: 'main',
      iteration: 2,
      maxIterations: 10,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 1,
      auditCount: 0,
      modelFailed: true,
    }

    loopService.setState('model-reset-test', state)
    loopService.registerSession(sessionId, 'model-reset-test')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    const updatedState = loopService.getActiveState('model-reset-test')
    expect(updatedState?.modelFailed).toBe(false)
  })

  test('three consecutive errors terminate loop', async () => {
    const { createLoopEventHandler } = require('../src/hooks/loop')
    const sessionId = 'three-errors-session'

    const mockClient = {
      session: {
        promptAsync: async () => ({ data: undefined, error: undefined }),
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
      worktree: {
        create: async () => ({ data: { id: 'wt-1', directory: '/tmp/wt', branch: 'main' }, error: undefined }),
        remove: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: sessionId }, error: undefined }),
        delete: async () => ({ data: undefined, error: undefined }),
        promptAsync: async () => ({ data: undefined, error: undefined }),
        messages: async () => ({
          data: [
            {
              info: {
                role: 'assistant',
                error: { name: 'ProviderError', data: { message: 'Model not found' } },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    } as any

    const mockGetConfig = () => ({ loop: {}, executionModel: undefined, auditorModel: undefined })
    const handler = createLoopEventHandler(loopService, mockClient, mockV2Client, createMockLogger(), mockGetConfig)

    const state = {
      active: true,
      sessionId,
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', state)
    loopService.registerSession(sessionId, 'test-worktree')

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    let stateAfterSecondError = loopService.getActiveState('test-worktree')
    expect(stateAfterSecondError?.errorCount).toBe(1)

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    let stateAfterThirdError = loopService.getActiveState('test-worktree')
    expect(stateAfterThirdError?.errorCount).toBe(2)

    await handler.onEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
    })

    const finalState = loopService.getActiveState('test-worktree')
    expect(finalState).toBeNull()

    const terminatedState = loopService.getAnyState('test-worktree')
    expect(terminatedState?.active).toBe(false)
    expect(terminatedState?.terminationReason).toContain('error_max_retries')
  })
})

describe('Force-restart behavior', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  test('inactive restart still works', () => {
    const inactiveState = {
      active: false,
      sessionId: 'old-session',
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 3,
      maxIterations: 10,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      terminationReason: 'cancelled',
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('test-worktree', inactiveState)
    const retrieved = loopService.findByWorktreeName('test-worktree')
    expect(retrieved).toEqual(inactiveState)
    expect(retrieved?.active).toBe(false)
    expect(retrieved?.terminationReason).toBe('cancelled')
  })

  test('completed loop blocks restart', () => {
    const completedState = {
      active: false,
      sessionId: 'completed-session',
      worktreeName: 'completed-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 5,
      maxIterations: 10,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      terminationReason: 'completed',
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('completed-worktree', completedState)
    const retrieved = loopService.findByWorktreeName('completed-worktree')
    expect(retrieved).toEqual(completedState)
    expect(retrieved?.active).toBe(false)
    expect(retrieved?.terminationReason).toBe('completed')
  })

  test('active loop state can be retrieved for force-restart', () => {
    const activeState = {
      active: true,
      sessionId: 'active-session',
      worktreeName: 'active-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 2,
      maxIterations: 10,
      completionSignal: 'ALL_PHASES_COMPLETE',
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('active-worktree', activeState)
    loopService.registerSession('active-session', 'active-worktree')

    const retrieved = loopService.getActiveState('active-worktree')
    expect(retrieved).toEqual(activeState)
    expect(retrieved?.active).toBe(true)

    const resolved = loopService.resolveWorktreeName('active-session')
    expect(resolved).toBe('active-worktree')
  })

  test('unregisterSession removes session mapping', () => {
    const activeState = {
      active: true,
      sessionId: 'session-to-unregister',
      worktreeName: 'unregister-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('unregister-worktree', activeState)
    loopService.registerSession('session-to-unregister', 'unregister-worktree')

    let resolved = loopService.resolveWorktreeName('session-to-unregister')
    expect(resolved).toBe('unregister-worktree')

    loopService.unregisterSession('session-to-unregister')

    resolved = loopService.resolveWorktreeName('session-to-unregister')
    expect(resolved).toBeNull()
  })

  test('deleteState removes loop state', () => {
    const state = {
      active: true,
      sessionId: 'session-to-delete',
      worktreeName: 'delete-worktree',
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }

    loopService.setState('delete-worktree', state)

    let retrieved = loopService.getActiveState('delete-worktree')
    expect(retrieved).toEqual(state)

    loopService.deleteState('delete-worktree')

    retrieved = loopService.getActiveState('delete-worktree')
    expect(retrieved).toBeNull()
  })
})

describe('migrateRalphKeys', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
  })

  afterEach(() => {
    db.close()
  })

  test('migrates ralph: entries to loop: prefix', () => {
    const logger = createMockLogger()
    kvService.set(projectId, 'ralph:foo', { value: 'bar' })
    kvService.set(projectId, 'ralph:bar', { value: 'baz' })

    migrateRalphKeys(kvService, projectId, logger)

    expect(kvService.get(projectId, 'loop:foo')).toEqual({ value: 'bar' })
    expect(kvService.get(projectId, 'loop:bar')).toEqual({ value: 'baz' })
    expect(kvService.get(projectId, 'ralph:foo')).toBeNull()
    expect(kvService.get(projectId, 'ralph:bar')).toBeNull()
  })

  test('converts inPlace true to worktree false', () => {
    const logger = createMockLogger()
    kvService.set(projectId, 'ralph:test', { inPlace: true, sessionId: 'abc' })

    migrateRalphKeys(kvService, projectId, logger)

    const migrated = kvService.get(projectId, 'loop:test')
    expect(migrated).toEqual({ worktree: false, sessionId: 'abc' })
    expect((migrated as any)?.inPlace).toBeUndefined()
  })

  test('converts inPlace false to worktree true', () => {
    const logger = createMockLogger()
    kvService.set(projectId, 'ralph:test', { inPlace: false, sessionId: 'abc' })

    migrateRalphKeys(kvService, projectId, logger)

    const migrated = kvService.get(projectId, 'loop:test')
    expect(migrated).toEqual({ worktree: true, sessionId: 'abc' })
    expect((migrated as any)?.inPlace).toBeUndefined()
  })

  test('migrates ralph-session: entries to loop-session: prefix', () => {
    const logger = createMockLogger()
    kvService.set(projectId, 'ralph:dummy', { dummy: true })
    kvService.set(projectId, 'ralph-session:s1', 'worktree-1')

    migrateRalphKeys(kvService, projectId, logger)

    expect(kvService.get(projectId, 'loop-session:s1')).toBe('worktree-1')
    expect(kvService.get(projectId, 'ralph-session:s1')).toBeNull()
  })

  test('no-op when no ralph entries exist', () => {
    const logger = createMockLogger()

    expect(() => migrateRalphKeys(kvService, projectId, logger)).not.toThrow()
    expect(kvService.listByPrefix(projectId, 'loop:').length).toBe(0)
  })

  test('logs migration count', () => {
    const logs: string[] = []
    const logger = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      debug: () => {},
    }
    kvService.set(projectId, 'ralph:foo', { value: 'bar' })
    kvService.set(projectId, 'ralph:bar', { value: 'baz' })

    migrateRalphKeys(kvService, projectId, logger)

    expect(logs.some(log => log.includes('Migrating') && log.includes('2'))).toBe(true)
  })
})

describe('buildCompletionSignalInstructions', () => {
  test('returns string containing the signal', () => {
    const result = buildCompletionSignalInstructions('MY_SIGNAL')
    expect(result).toContain('MY_SIGNAL')
  })

  test('contains verification instructions', () => {
    const result = buildCompletionSignalInstructions('MY_SIGNAL')
    expect(result).toContain('Verify each phase')
  })

  test('contains IMPORTANT header', () => {
    const result = buildCompletionSignalInstructions('MY_SIGNAL')
    expect(result).toContain('IMPORTANT')
  })
})

describe('terminateAll', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  function createActiveState(name: string, sessionId: string): LoopState {
    return {
      active: true,
      sessionId,
      worktreeName: name,
      worktreeDir: `/tmp/${name}`,
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
  }

  test('marks all active loops as shutdown', () => {
    const state1 = createActiveState('worktree-1', 'session-1')
    const state2 = createActiveState('worktree-2', 'session-2')

    loopService.setState('worktree-1', state1)
    loopService.setState('worktree-2', state2)

    loopService.terminateAll()

    const updated1 = loopService.getAnyState('worktree-1')
    const updated2 = loopService.getAnyState('worktree-2')

    expect(updated1?.active).toBe(false)
    expect(updated1?.terminationReason).toBe('shutdown')
    expect(updated1?.completedAt).toBeDefined()

    expect(updated2?.active).toBe(false)
    expect(updated2?.terminationReason).toBe('shutdown')
    expect(updated2?.completedAt).toBeDefined()
  })

  test('does not affect inactive loops', () => {
    const activeState = createActiveState('active', 'session-active')
    const inactiveState: LoopState = {
      ...createActiveState('inactive', 'session-inactive'),
      active: false,
      terminationReason: 'completed',
    }

    loopService.setState('active', activeState)
    loopService.setState('inactive', inactiveState)

    loopService.terminateAll()

    const inactive = loopService.getAnyState('inactive')
    expect(inactive?.terminationReason).toBe('completed')
  })

  test('no-op with no active loops', () => {
    expect(() => loopService.terminateAll()).not.toThrow()
  })
})

describe('listRecent', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  function createActiveState(name: string, sessionId: string): LoopState {
    return {
      active: true,
      sessionId,
      worktreeName: name,
      worktreeDir: `/tmp/${name}`,
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
  }

  function createInactiveState(name: string, sessionId: string): LoopState {
    return {
      active: false,
      sessionId,
      worktreeName: name,
      worktreeDir: `/tmp/${name}`,
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
  }

  test('returns only inactive states', () => {
    loopService.setState('active-1', createActiveState('active-1', 'session-1'))
    loopService.setState('active-2', createActiveState('active-2', 'session-2'))
    loopService.setState('inactive-1', createInactiveState('inactive-1', 'session-3'))

    const recent = loopService.listRecent()

    expect(recent.length).toBe(1)
    expect(recent[0].worktreeName).toBe('inactive-1')
  })

  test('returns empty array when no inactive states', () => {
    loopService.setState('active-1', createActiveState('active-1', 'session-1'))
    loopService.setState('active-2', createActiveState('active-2', 'session-2'))

    const recent = loopService.listRecent()

    expect(recent).toEqual([])
  })
})

describe('findCandidatesByPartialName', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  function createActiveState(name: string, sessionId: string): LoopState {
    return {
      active: true,
      sessionId,
      worktreeName: name,
      worktreeDir: `/tmp/${name}`,
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 5,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
  }

  test('returns multiple candidates for ambiguous match', () => {
    loopService.setState('feature-auth', createActiveState('feature-auth', 'session-1'))
    loopService.setState('feature-api', createActiveState('feature-api', 'session-2'))

    const candidates = loopService.findCandidatesByPartialName('feature')

    expect(candidates.length).toBe(2)
  })

  test('returns empty array when no matches', () => {
    loopService.setState('feature-auth', createActiveState('feature-auth', 'session-1'))

    const candidates = loopService.findCandidatesByPartialName('nonexistent')

    expect(candidates).toEqual([])
  })
})

describe('fetchSessionOutput', () => {
  function createMockLogger() {
    return {
      log: () => {},
      error: () => {},
      debug: () => {},
    }
  }

  const createMockV2Client = (messages: any[] = [], session: any = {}) => ({
    session: {
      messages: async () => ({ data: messages }),
      get: async () => ({ data: session }),
    },
  } as any)

  test('returns null when directory is empty', async () => {
    const mockClient = createMockV2Client()
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, 'session-1', '', logger)

    expect(result).toBeNull()
  })

  test('returns null when sessionId is empty', async () => {
    const mockClient = createMockV2Client()
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, '', '/dir', logger)

    expect(result).toBeNull()
  })

  test('extracts messages from assistant responses', async () => {
    const messages = [
      {
        info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'text', text: 'Hello from assistant' }],
      },
      {
        info: { role: 'user', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'text', text: 'User message' }],
      },
    ]
    const mockClient = createMockV2Client(messages)
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, 'session-1', '/tmp/test', logger)

    expect(result).not.toBeNull()
    expect(result?.messages.length).toBe(1)
    expect(result?.messages[0].text).toContain('Hello from assistant')
  })

  test('calculates total cost and tokens', async () => {
    const messages = [
      {
        info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } },
        parts: [{ type: 'text', text: 'First message' }],
      },
      {
        info: { role: 'assistant', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } } },
        parts: [{ type: 'text', text: 'Second message' }],
      },
    ]
    const mockClient = createMockV2Client(messages)
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, 'session-1', '/tmp/test', logger)

    expect(result?.totalCost).toBe(0.03)
    expect(result?.totalTokens.input).toBe(300)
    expect(result?.totalTokens.output).toBe(150)
    expect(result?.totalTokens.reasoning).toBe(30)
    expect(result?.totalTokens.cacheRead).toBe(15)
    expect(result?.totalTokens.cacheWrite).toBe(6)
  })

  test('includes file changes from session summary', async () => {
    const messages = [
      {
        info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'text', text: 'Message' }],
      },
    ]
    const session = {
      summary: { additions: 10, deletions: 5, files: 3 },
    }
    const mockClient = createMockV2Client(messages, session)
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, 'session-1', '/tmp/test', logger)

    expect(result?.fileChanges).toEqual({ additions: 10, deletions: 5, files: 3 })
  })

  test('returns null on API error', async () => {
    const mockClient = {
      session: {
        messages: async () => { throw new Error('API error') },
        get: async () => { throw new Error('API error') },
      },
    } as any
    const logger = createMockLogger()

    const result = await fetchSessionOutput(mockClient, 'session-1', '/tmp/test', logger)

    expect(result).toBeNull()
  })
})

describe('generateUniqueName', () => {
  test('returns base name when no collision exists', () => {
    const result = generateUniqueName('test-name', [])
    expect(result).toBe('test-name')
  })

  test('returns base name when it does not conflict with existing names', () => {
    const result = generateUniqueName('test-name', ['other-name', 'different-name'])
    expect(result).toBe('test-name')
  })

  test('appends -1 suffix when base name collides', () => {
    const result = generateUniqueName('test-name', ['test-name'])
    expect(result).toBe('test-name-1')
  })

  test('appends incrementing suffix when multiple collisions exist', () => {
    const existing = ['test-name', 'test-name-1', 'test-name-2']
    const result = generateUniqueName('test-name', existing)
    expect(result).toBe('test-name-3')
  })

  test('skips existing suffixed names when finding next available', () => {
    const existing = ['test-name', 'test-name-1', 'test-name-3']
    const result = generateUniqueName('test-name', existing)
    expect(result).toBe('test-name-2')
  })

  test('truncates base name to 25 characters when it exceeds limit', () => {
    const longName = 'this-is-a-very-long-name-that-exceeds-the-limit'
    const result = generateUniqueName(longName, [])
    expect(result.length).toBeLessThanOrEqual(25)
    expect(result).toBe('this-is-a-very-long-name-')
  })

  test('truncates and adds suffix when truncated name collides', () => {
    const longName = 'this-is-a-very-long-name-that-exceeds-the-limit'
    const truncated = 'this-is-a-very-long-name-'
    const existing = [truncated]
    const result = generateUniqueName(longName, existing)
    expect(result).toBe(`${truncated}-1`)
    expect(result.length).toBeLessThanOrEqual(27) // truncated + -1
  })

  test('handles multiple collisions with long base name', () => {
    const longName = 'this-is-a-very-long-name-that-exceeds-the-limit'
    const truncated = 'this-is-a-very-long-name-'
    const existing = [truncated, `${truncated}-1`, `${truncated}-2`]
    const result = generateUniqueName(longName, existing)
    expect(result).toBe(`${truncated}-3`)
    expect(result.length).toBeLessThanOrEqual(28)
  })

  test('handles empty base name gracefully', () => {
    const result = generateUniqueName('', [''])
    expect(result).toBe('-1')
  })

  test('preserves case in existing names for comparison', () => {
    // Comparison is case-sensitive
    const result = generateUniqueName('Test-Name', ['test-name'])
    expect(result).toBe('Test-Name')
  })

  test('works with active and recent loop names from service', () => {
    const db = createTestDb()
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, 'test-project', createMockLogger())
    
    // Create some active and recent loops
    const activeState = {
      active: true,
      sessionId: 'active-1',
      worktreeName: 'test-worktree',
      worktreeDir: '/tmp/test',
      worktreeBranch: 'main',
      iteration: 1,
      maxIterations: 0,
      completionSignal: null,
      startedAt: new Date().toISOString(),
      prompt: 'test',
      phase: 'coding' as const,
      audit: false,
      errorCount: 0,
      auditCount: 0,
    }
    
    const recentState = {
      ...activeState,
      active: false,
      sessionId: 'recent-1',
      worktreeName: 'test-worktree-1',
      completedAt: new Date().toISOString(),
      terminationReason: 'completed',
    }
    
    loopService.setState('active-1', activeState as any)
    loopService.setState('recent-1', recentState as any)
    
    const active = loopService.listActive()
    const recent = loopService.listRecent()
    const allNames = [...active, ...recent].map((s) => s.worktreeName)
    
    // Both 'test-worktree' and 'test-worktree-1' exist, so next should be 'test-worktree-2'
    const result = generateUniqueName('test-worktree', allNames)
    expect(result).toBe('test-worktree-2')
  })
})
