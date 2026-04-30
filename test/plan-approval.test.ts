import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLoopService, generateUniqueName } from '../src/services/loop'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createGraphStatusRepo } from '../src/storage/repos/graph-status-repo'
import { resolveGraphCacheDir } from '../src/storage/graph-projects'
import { handleExecutePlan } from '../src/api/handlers/plan-execute'
import { openForgeDatabase, resolveDataDir } from '../src/storage/database'
import type { Logger } from '../src/types'
import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from '../src/tools/plan-approval'
import type { ToolContext } from '../src/tools/types'
import type { PluginConfig } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-plan-approval-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
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
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`CREATE UNIQUE INDEX idx_loops_session ON loops(project_id, current_session_id)`)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
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
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id   TEXT NOT NULL,
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      branch       TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch)`)

  db.run(`
    CREATE TABLE IF NOT EXISTS graph_status (
      project_id   TEXT NOT NULL,
      cwd          TEXT NOT NULL,
      state        TEXT NOT NULL,
      ready        INTEGER NOT NULL DEFAULT 0,
      stats_json   TEXT,
      message      TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, cwd)
    )
  `)
  
  return db
}

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('Plan Approval Tool Interception', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let plansRepo: ReturnType<typeof createPlansRepo>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  const PLAN_APPROVAL_LABELS = ['New session', 'Execute here', 'Loop (worktree)', 'Loop']

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    plansRepo = createPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  function simulateToolExecuteAfter(
    tool: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown },
    sessionActive = false
  ) {
    if (sessionActive) {
      const loopName = 'test-loop'
      const state = {
        active: true,
        sessionId: sessionID,
        loopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
        worktree: true,
      }
      loopService.setState(loopName, state)
    }

    if (tool === 'question') {
      const questionArgs = args as { questions?: Array<{ options?: Array<{ label: string }> }> } | undefined
      const options = questionArgs?.questions?.[0]?.options
      if (options) {
        const labels = options.map((o) => o.label)
        const isPlanApproval = PLAN_APPROVAL_LABELS.every((l) => labels.includes(l))
        if (isPlanApproval) {
          const metadata = output.metadata as { answers?: string[][] } | undefined
          const answer = metadata?.answers?.[0]?.[0]?.trim() ?? output.output.trim()
          const matchedLabel = PLAN_APPROVAL_LABELS.find((l) => answer === l || answer.startsWith(l))
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            output.output = `${output.output}\n\nSwitching to code agent for execution...`
          } else if (matchedLabel) {
            // Programmatic dispatch - no directive injection
            output.output = `${output.output}\n\n[Programmatic dispatch - no directive]`
          } else {
            // Custom answer fallback
            output.output = `${output.output}\n\n<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, use the appropriate tool (plan-execute or loop) based on their intent. If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>`
          }
        }
      }
      return
    }

    if (!sessionActive) return

    const LOOP_BLOCKED_TOOLS: Record<string, string> = {
      question: 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
      'plan-execute': 'The plan-execute tool is not available during a loop. Focus on executing the current plan.',
      loop: 'The loop tool is not available during a loop. Focus on executing the current plan.',
    }

    if (!(tool in LOOP_BLOCKED_TOOLS)) return

    output.title = 'Tool blocked'
    output.output = LOOP_BLOCKED_TOOLS[tool]!
  }

  test('Detects plan approval question and handles "New session" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'New session', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('New session')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('plan-execute')
  })

  test('Detects plan approval question and handles "Execute here" with abort', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Execute here', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Execute here')
    expect(output.output).toContain('Switching to code agent')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Detects plan approval question and handles "Loop (worktree)" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Loop (worktree)', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Loop (worktree)')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('memory-loop')
  })

  test('Detects plan approval question and handles "Loop" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Loop', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Loop')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('memory-loop')
  })

  test('Injects directive for unknown answer', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Custom answer', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Custom answer')
    expect(output.output).toContain('<system-reminder>')
    expect(output.output).toContain('custom response')
    expect(output.output).toContain('respond accordingly')
  })

  test('Matches partial answer that starts with label', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'New session (with custom config)', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('New session (with custom config)')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Does not match partial label in middle of text', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'I want to create a session', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('I want to create a session')
    expect(output.output).toContain('<system-reminder>')
    expect(output.output).toContain('custom response')
  })

  test('Does not modify non-approval questions', () => {
    const args = {
      questions: [{
        question: 'What is your preference?',
        options: [
          { label: 'Option A', description: 'First option' },
          { label: 'Option B', description: 'Second option' },
        ],
      }],
    }
    const output = { title: '', output: 'Option A', metadata: {} }
    const originalOutput = output.output

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toBe(originalOutput)
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Does not modify non-question tools', () => {
    const output = { title: '', output: 'Some result', metadata: {} }
    const originalOutput = output.output

    simulateToolExecuteAfter('graph-status', {}, output)

    expect(output.output).toBe(originalOutput)
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Does not treat pre-plan approval question as execution approval', () => {
    const args = {
      questions: [{
        question: 'Should I write the implementation plan?',
        options: [
          { label: 'Yes', description: 'Write the plan' },
          { label: 'No', description: 'Not yet' },
        ],
      }],
    }
    const output = { title: '', output: 'Yes', metadata: {} }
    const originalOutput = output.output

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toBe(originalOutput)
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('Switching to code agent')
  })

  test('Loop blocking still works for question tool when loop is active', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('question', {}, output, true)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Loop blocking works for plan-execute tool', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('plan-execute', {}, output, true)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('plan-execute tool is not available')
  })

  test('Loop blocking works for loop tool', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('loop', {}, output, true)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('loop tool is not available')
  })

  test('Loop blocking does not affect non-blocked tools', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('graph-status', {}, output, true)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Loop blocking only applies when loop is active', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('plan-execute', {}, output, false)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })
})

describe('Tool blocking hook', () => {
  const sessionID = 'outside-session'
  const loopSessionID = 'loop-session'
  const auditSessionID = 'audit-session'
  const loopName = 'active-loop'

  function createContextForLoopState(state: { active: boolean; sessionId: string; auditSessionId?: string } | null): ToolContext {
    return {
      loopService: {
        resolveLoopName: () => state ? loopName : null,
        getActiveState: () => state,
      },
      logger: createMockLogger(),
    } as unknown as ToolContext
  }

  test('does not block question when resolved loop belongs to another session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      auditSessionId: auditSessionID,
    }))!

    await expect(hook({ tool: 'question', sessionID, callID: 'call-1' }, { args: {} })).resolves.toBeUndefined()
  })

  test('blocks question for active loop session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      auditSessionId: auditSessionID,
    }))!

    await expect(hook({ tool: 'question', sessionID: loopSessionID, callID: 'call-1' }, { args: {} })).rejects.toThrow('question tool is not available')
  })

  test('blocks question for active audit session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      auditSessionId: auditSessionID,
    }))!

    await expect(hook({ tool: 'question', sessionID: auditSessionID, callID: 'call-1' }, { args: {} })).rejects.toThrow('question tool is not available')
  })

  test('does not rewrite after-hook output when resolved loop belongs to another session', async () => {
    const hook = createToolExecuteAfterHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      auditSessionId: auditSessionID,
    }))!
    const output = { title: '', output: 'original output', metadata: {} }

    await hook({ tool: 'plan-execute', sessionID, callID: 'call-1', args: {} }, output)

    expect(output.title).toBe('')
    expect(output.output).toBe('original output')
  })
})

describe('Execute here bypass', () => {
  const projectId = 'test-project'
  const sessionID = 'test-session-456'
  const testDir = '/test/dir'
  const openDbs: Database[] = []

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs.length = 0
  })

  function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
    const mockV2 = {
      session: {
        abort: async () => ({ data: {} }),
        promptAsync: async () => ({ data: {} }),
        create: async () => ({ data: { id: 'new-session-id' } }),
      },
      tui: {
        selectSession: async () => ({ data: {} }),
      },
    } as unknown as ToolContext['v2']

    const mockConfig = {
      executionModel: 'test-provider/test-model',
    } as PluginConfig

    const mockLogger = createMockLogger()

    const db = createTestDb()
    openDbs.push(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const graphStatusRepo = createGraphStatusRepo(db)
    const plansRepo = createPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)

    return {
      projectId,
      directory: testDir,
      config: mockConfig,
      logger: mockLogger,
      db,
      loopService,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      graphStatusRepo,
      v2: mockV2,
      ...overrides,
    } as ToolContext
  }

  test('Execute here bypasses directive injection and triggers abort', async () => {
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: async () => ({ data: {} }),
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).toContain('Switching to code agent')
    expect(abortSpy).toHaveBeenCalledWith({ sessionID })
  })

  test('session.idle event triggers promptAsync for pending execution', async () => {
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: async () => ({ data: {} }),
          promptAsync: promptSpy,
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const afterHook = createToolExecuteAfterHook(ctx)
    const eventHook = createPlanApprovalEventHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await afterHook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    await eventHook({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      },
    })

    expect(promptSpy).toHaveBeenCalled()
    const callArgs = promptSpy.mock.calls[0][0]
    expect(callArgs.sessionID).toBe(sessionID)
    expect(callArgs.agent).toBe('code')
    expect(callArgs.parts[0].text).toContain('The architect agent has created an implementation plan')

    await eventHook({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      },
    })

    expect(promptSpy).toHaveBeenCalledTimes(1)
  })

  test('Other approval labels do not inject directives (programmatic dispatch)', async () => {
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: async () => ({ data: {} }),
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    const hook = createToolExecuteAfterHook(ctx)

    for (const label of ['New session', 'Loop (worktree)', 'Loop']) {
      const args = {
        questions: [{
          question: 'How would you like to proceed?',
          options: [
            { label: 'New session', description: 'Create new session' },
            { label: 'Execute here', description: 'Execute here' },
            { label: 'Loop (worktree)', description: 'Loop worktree' },
            { label: 'Loop', description: 'Loop in place' },
          ],
        }],
      }
      const output = {
        title: 'Asked 1 question',
        output: label,
        metadata: { answers: [[label]] },
      }

      await hook(
        { tool: 'question', sessionID, callID: 'test-call', args },
        output
      )

      expect(output.output).not.toContain('<system-reminder>')
      expect(abortSpy).not.toHaveBeenCalled()
      abortSpy.mockClear()
    }
  })

  test('session.idle for non-pending session is a no-op', async () => {
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: async () => ({ data: {} }),
          promptAsync: promptSpy,
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    const eventHook = createPlanApprovalEventHook(ctx)

    await eventHook({
      event: {
        type: 'session.status',
        properties: { sessionID: 'non-pending-session', status: { type: 'idle' } },
      },
    })

    expect(promptSpy).not.toHaveBeenCalled()
  })

  test('New session path reads plan from session-scoped repo and plan persists after dispatch', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-abc'
    
    const plansRepo = createPlansRepo(db)
    
    // Store a plan in session-scoped repo
    const originalPlan = '# Test Plan\n\nThis is a test plan.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)
    
    const createSpy = mock(() => Promise.resolve({ data: { id: 'new-session-123' } }))
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const graphStatusRepo = createGraphStatusRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
    
    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      graphStatusRepo,
      loopService,
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: promptSpy,
          create: createSpy,
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    } as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )

    const duplicateOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      duplicateOutput
    )

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after dispatch
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(abortSpy).toHaveBeenCalledWith({ sessionID: testSessionID })
    expect(duplicateOutput.output).toBe('Plan approval already handled.')
  })

  test('Execute here path reads plan from session-scoped repo and plan persists after dispatch', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-execute-here'

    const plansRepo = createPlansRepo(db)

    const originalPlan = '# Execute Here Plan\n\nThis plan should persist after Execute here.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const abortSpy = mock(() => Promise.resolve({ data: {} }))

    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loopService,
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: promptSpy,
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    } as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after dispatch
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
  })

  test('Loop path plan persists after successful setup', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-loop'

    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const originalPlan = '# Loop Plan\n\nThis plan should persist after Loop setup.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const createSpy = mock(() => Promise.resolve({ data: { id: 'loop-session-123' } }))
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    const selectSessionSpy = mock(() => Promise.resolve({ data: {} }))

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model', loop: { defaultMaxIterations: 5 } } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loopService,
      loopHandler: {
        startWatchdog: mock(() => {}),
      },
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: promptSpy,
          create: createSpy,
        },
        tui: {
          selectSession: selectSessionSpy,
        },
      } as unknown as ToolContext['v2'],
    } as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after loop setup
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)

    // Verify loop was created and prompt was stored in loop_large_fields
    const loopRow = db.prepare('SELECT loop_name FROM loops WHERE project_id = ?').get(projectId) as { loop_name: string } | null
    expect(loopRow).toBeDefined()
    if (loopRow) {
      const largeFields = db.prepare('SELECT prompt FROM loop_large_fields WHERE project_id = ? AND loop_name = ?').get(projectId, loopRow.loop_name) as { prompt: string } | null
      expect(largeFields?.prompt).toBe(originalPlan)
    }
  })

  test('Loop path plan persists after failed setup', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-loop-fail'

    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const originalPlan = '# Failed Loop Plan\n\nThis plan should persist after failed Loop setup.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const createSpy = mock(() => Promise.resolve({ data: null, error: 'Failed to create session' }))
    const abortSpy = mock(() => Promise.resolve({ data: {} }))

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model', loop: { defaultMaxIterations: 5 } } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loopService,
      loopHandler: {
        startWatchdog: mock(() => {}),
      },
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: mock(() => Promise.resolve({ data: {} })),
          create: createSpy,
        },
        tui: {
          selectSession: mock(() => Promise.resolve({ data: {} })),
        },
      } as unknown as ToolContext['v2'],
    } as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after failed loop setup
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
  })

  test('Two different sessions can store plans independently without collision', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const plansRepo = createPlansRepo(db)
    
    const session1 = 'session-1'
    const session2 = 'session-2'
    const plan1 = '# Plan for Session 1'
    const plan2 = '# Plan for Session 2'
    
    // Store different plans for different sessions
    plansRepo.writeForSession(projectId, session1, plan1)
    plansRepo.writeForSession(projectId, session2, plan2)
    
    // Verify each session can read its own plan
    const retrieved1 = plansRepo.getForSession(projectId, session1)
    const retrieved2 = plansRepo.getForSession(projectId, session2)
    
    expect(retrieved1?.content).toBe(plan1)
    expect(retrieved2?.content).toBe(plan2)
    expect(retrieved1?.content).not.toBe(plan2)
    expect(retrieved2?.content).not.toBe(plan1)
  })
})

describe('generateUniqueName for plan approval', () => {
  test('generates unique name when loop collision exists', () => {
    const existingNames = ['api-integration', 'api-integration-1']
    const result = generateUniqueName('api-integration', existingNames)
    expect(result).toBe('api-integration-2')
  })

  test('generates base name when no collision exists', () => {
    const existingNames = ['other-loop', 'different-loop']
    const result = generateUniqueName('new-loop', existingNames)
    expect(result).toBe('new-loop')
  })
})

describe('plan execute API loop dispatch', () => {
  const originalDataHome = process.env.XDG_DATA_HOME
  const originalConfigHome = process.env.XDG_CONFIG_HOME
  let testDataDir: string
  let testConfigDir: string
  let db: Database

  beforeEach(() => {
    testDataDir = `${TEST_DIR}-api-${Math.random().toString(36).slice(2)}`
    testConfigDir = `${TEST_DIR}-api-config-${Math.random().toString(36).slice(2)}`
    process.env.XDG_DATA_HOME = testDataDir
    process.env.XDG_CONFIG_HOME = testConfigDir
    mkdirSync(`${testConfigDir}/opencode`, { recursive: true })
    writeFileSync(`${testConfigDir}/opencode/forge-config.jsonc`, JSON.stringify({ sandbox: { mode: 'none' } }))
    mkdirSync(resolveDataDir(), { recursive: true })
    db = openForgeDatabase(`${resolveDataDir()}/graph.db`)
  })

  afterEach(() => {
    db?.close()
    if (originalDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalDataHome
    }
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome
    }
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
    }
  })

  function createApiDeps(overrides?: Partial<ToolContext>) {
    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const graphStatusRepo = createGraphStatusRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'api-project', createMockLogger())
    const promptAsync = mock(() => Promise.resolve({ data: {} }))
    const sessionCreate = mock(() => Promise.resolve({ data: { id: `session-${Math.random().toString(36).slice(2)}` } }))
    const sessionAbort = mock(() => Promise.resolve({ data: {} }))
    const worktreeCreate = mock(async () => {
      const directory = `${testDataDir}/worktree`
      mkdirSync(directory, { recursive: true })
      createGraphStatusRepo(db).write({
        projectId: 'api-project',
        cwd: directory,
        state: 'ready',
        ready: true,
        stats: { files: 1, symbols: 1, edges: 0, calls: 0 },
        message: null,
      })
      return { data: { directory, branch: 'opencode/loop-api-plan' }, error: undefined }
    })

    const ctx = {
      projectId: 'api-project',
      directory: '/repo',
      config: {
        executionModel: 'provider/default-exec',
        auditorModel: 'provider/default-auditor',
      } as PluginConfig,
      logger: createMockLogger(),
      db,
      dataDir: resolveDataDir(),
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      graphStatusRepo,
      loopService,
      sandboxManager: null,
      v2: {
        session: {
          create: sessionCreate,
          promptAsync,
          abort: sessionAbort,
        },
        worktree: {
          create: worktreeCreate,
        },
      } as unknown as ToolContext['v2'],
      ...overrides,
    } as ToolContext

    return { ctx, promptAsync, sessionCreate, sessionAbort, worktreeCreate, graphStatusRepo }
  }

  function apiDeps(ctx: ToolContext) {
    return { ctx, logger: ctx.logger, projectId: 'api-project', registry: {} as never }
  }

  test('loop mode launches an in-place loop and persists default auditor model', async () => {
    const { ctx, sessionCreate } = createApiDeps()
    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loop', title: 'API Plan', plan: '# API Plan' }),
    })

    const res = await handleExecutePlan(req, apiDeps(ctx), {
      projectId: 'api-project',
      sessionId: 'host-session',
    })

    expect(res.status).toBe(202)
    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo' }))
    const row = db.prepare('SELECT worktree, execution_model, auditor_model, host_session_id FROM loops WHERE project_id = ?').get('api-project') as {
      worktree: number
      execution_model: string
      auditor_model: string
      host_session_id: string
    }
    expect(row.worktree).toBe(0)
    expect(row.execution_model).toBe('provider/default-exec')
    expect(row.auditor_model).toBe('provider/default-auditor')
    expect(row.host_session_id).toBe('host-session')
  })

  test('loop-worktree mode launches a worktree loop and honors explicit auditor model', async () => {
    const { ctx, worktreeCreate } = createApiDeps()
    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'loop-worktree',
        title: 'API Worktree Plan',
        plan: '# API Worktree Plan',
        executionModel: 'provider/request-exec',
        auditorModel: 'provider/request-auditor',
      }),
    })

    const res = await handleExecutePlan(req, apiDeps(ctx), {
      projectId: 'api-project',
      sessionId: 'host-session',
    })

    expect(res.status).toBe(202)
    expect(worktreeCreate).toHaveBeenCalled()
    const row = db.prepare('SELECT worktree, worktree_dir, execution_model, auditor_model FROM loops WHERE project_id = ?').get('api-project') as {
      worktree: number
      worktree_dir: string
      execution_model: string
      auditor_model: string
    }
    expect(row.worktree).toBe(1)
    expect(row.worktree_dir).toBe(`${testDataDir}/worktree`)
    expect(row.execution_model).toBe('provider/request-exec')
    expect(row.auditor_model).toBe('provider/request-auditor')
  })

  test('loop-worktree mode persists sandbox container name', async () => {
    const sandboxManager = {
      start: mock(async () => ({ containerName: 'oc-forge-sandbox-api-worktree-plan' })),
      stop: mock(async () => {}),
    }
    const { ctx } = createApiDeps({
      config: {
        executionModel: 'provider/default-exec',
        auditorModel: 'provider/default-auditor',
        sandbox: { mode: 'docker' },
      } as PluginConfig,
      sandboxManager: sandboxManager as unknown as ToolContext['sandboxManager'],
    })
    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loop-worktree', title: 'API Worktree Plan', plan: '# API Worktree Plan' }),
    })

    const res = await handleExecutePlan(req, apiDeps(ctx), {
      projectId: 'api-project',
      sessionId: 'host-session',
    })

    expect(res.status).toBe(202)
    const row = db.prepare('SELECT sandbox, sandbox_container FROM loops WHERE project_id = ?').get('api-project') as {
      sandbox: number
      sandbox_container: string | null
    }
    expect(row.sandbox).toBe(1)
    expect(row.sandbox_container).toBe('oc-forge-sandbox-api-worktree-plan')
  })

  test('loop-worktree mode persists state before graph readiness polling', async () => {
    const { ctx, graphStatusRepo, promptAsync } = createApiDeps()
    const worktreeDir = `${testDataDir}/slow-graph-worktree`
    mkdirSync(worktreeDir, { recursive: true })
    ctx.v2.worktree.create = mock(async () => ({
      data: { directory: worktreeDir, branch: 'opencode/loop-api-worktree-plan' },
      error: undefined,
    })) as unknown as ToolContext['v2']['worktree']['create']

    let resolvePrompt!: () => void
    const promptHold = new Promise<{ data: Record<string, never> }>((resolve) => {
      resolvePrompt = () => resolve({ data: {} })
    })
    ctx.v2.session.promptAsync = mock(() => promptHold) as unknown as ToolContext['v2']['session']['promptAsync']

    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loop-worktree', title: 'API Worktree Plan', plan: '# API Worktree Plan' }),
    })

    const pending = handleExecutePlan(req, apiDeps(ctx), {
      projectId: 'api-project',
      sessionId: 'host-session',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(promptAsync).not.toHaveBeenCalled()
    expect(ctx.v2.session.promptAsync).toHaveBeenCalled()
    const row = db.prepare('SELECT loop_name, worktree, worktree_dir FROM loops WHERE project_id = ?').get('api-project') as {
      loop_name: string
      worktree: number
      worktree_dir: string
    } | null
    expect(row).not.toBeNull()
    expect(row?.loop_name).toBe('api-worktree-plan')
    expect(row?.worktree).toBe(1)
    expect(row?.worktree_dir).toBe(worktreeDir)

    graphStatusRepo.write({
      projectId: 'api-project',
      cwd: worktreeDir,
      state: 'ready',
      ready: true,
      stats: { files: 1, symbols: 1, edges: 0, calls: 0 },
      message: null,
    })
    resolvePrompt()

    const res = await pending
    expect(res.status).toBe(202)
  })

  test('loop-worktree mode rolls back session and loop state when sandbox startup fails', async () => {
    const sandboxManager = {
      start: mock(async () => { throw new Error('sandbox failed') }),
      stop: mock(async () => {}),
    }
    const { ctx, sessionAbort } = createApiDeps({
      config: {
        executionModel: 'provider/default-exec',
        auditorModel: 'provider/default-auditor',
        sandbox: { mode: 'docker' },
      } as PluginConfig,
      sandboxManager: sandboxManager as unknown as ToolContext['sandboxManager'],
    })
    const repoDir = `${testDataDir}/rollback-repo`
    const worktreeDir = `${testDataDir}/rollback-worktree`
    const runGit = (args: string[], cwd: string) => {
      const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
      expect(result.exitCode).toBe(0)
    }
    mkdirSync(repoDir, { recursive: true })
    runGit(['init'], repoDir)
    writeFileSync(join(repoDir, 'README.md'), 'test\n')
    runGit(['add', 'README.md'], repoDir)
    runGit(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'init'], repoDir)
    runGit(['worktree', 'add', worktreeDir, '-b', `rollback-${Date.now()}`], repoDir)
    ctx.v2.worktree.create = mock(async () => ({
      data: { directory: worktreeDir, branch: 'opencode/loop-api-worktree-plan' },
      error: undefined,
    })) as unknown as ToolContext['v2']['worktree']['create']
    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loop-worktree', title: 'API Worktree Plan', plan: '# API Worktree Plan' }),
    })

    let thrown: unknown
    try {
      await handleExecutePlan(req, apiDeps(ctx), {
        projectId: 'api-project',
        sessionId: 'host-session',
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(sessionAbort).toHaveBeenCalled()
    expect(sandboxManager.stop).toHaveBeenCalledWith('api-worktree-plan')
    expect(existsSync(worktreeDir)).toBe(false)
    const row = db.prepare('SELECT loop_name FROM loops WHERE project_id = ?').get('api-project')
    expect(row).toBeNull()
  })

  test('loop-worktree mode passes graph status repo for seeded worktree status', async () => {
    const { ctx, graphStatusRepo } = createApiDeps()
    const worktreeDir = `${testDataDir}/seeded-worktree`
    mkdirSync(worktreeDir, { recursive: true })
    const worktreeCreate = mock(async () => ({
      data: { directory: worktreeDir, branch: 'opencode/loop-api-worktree-plan' },
      error: undefined,
    }))
    ctx.v2.worktree.create = worktreeCreate as unknown as ToolContext['v2']['worktree']['create']

    const sourceCacheDir = resolveGraphCacheDir('api-project', '/repo', ctx.dataDir)
    mkdirSync(sourceCacheDir, { recursive: true })
    const sourceGraphDb = new Database(join(sourceCacheDir, 'graph.db'))
    sourceGraphDb.run('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT, mtimeMs INTEGER)')
    sourceGraphDb.close()
    writeFileSync(join(sourceCacheDir, 'graph-metadata.json'), JSON.stringify({
      projectId: 'api-project',
      cwd: '/repo',
      createdAt: Date.now() - 1000,
      lastIndexedAt: Date.now() - 500,
      indexedFileCount: 0,
      indexedMaxMtimeMs: 0,
    }))
    graphStatusRepo.write({
      projectId: 'api-project',
      cwd: '/repo',
      state: 'ready',
      ready: true,
      stats: { files: 0, symbols: 0, edges: 0, calls: 0 },
      message: null,
    })

    const req = new Request('http://test.local/execute', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loop-worktree', title: 'API Worktree Plan', plan: '# API Worktree Plan' }),
    })

    const res = await handleExecutePlan(req, apiDeps(ctx), {
      projectId: 'api-project',
      sessionId: 'host-session',
    })

    expect(res.status).toBe(202)
    const targetStatus = graphStatusRepo.read('api-project', worktreeDir)
    expect(targetStatus?.state).toBe('ready')
    expect(targetStatus?.ready).toBe(true)
  })
})
