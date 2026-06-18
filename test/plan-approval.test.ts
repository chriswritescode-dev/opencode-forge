import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
// Database is resolved via vitest alias to better-sqlite3 at runtime
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { join } from 'path'

// Mock ForgeRpcError for error handling
class MockForgeRpcError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message)
  }
}

import { createLoopService } from '../src/loop/service'
import { generateUniqueName } from '../src/loop/name-uniqueness'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'

import { openForgeDatabase } from '../src/storage/database'
import type { Logger } from '../src/types'
import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from '../src/hooks/plan-approval'
import type { ToolContext } from '../src/tools/types'
import type { PluginConfig } from '../src/types'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const TEST_DIR = '/tmp/opencode-manager-plan-approval-test-' + Date.now()

function createTestDb(): any {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('Plan Approval Tool Interception', () => {
  let db: any
  let loopService: ReturnType<typeof createLoopService>
  let plansRepo: ReturnType<typeof createPlansRepo>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  const PLAN_APPROVAL_LABELS = ['New session', 'Execute here', 'Loop']

  const approvalArgs = {
    questions: [{
      question: 'How would you like to proceed?',
      options: [
        { label: 'New session', description: 'Create new session' },
        { label: 'Execute here', description: 'Execute here' },
        { label: 'Loop', description: 'Loop' },
      ],
    }],
  }

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
        status: 'running' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: true,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
      }
      loopService.setState(loopName, state as any)
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
            output.output = `${output.output}\n\n<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, ask the question tool again with one of: "New session", "Execute here", or "Loop". If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>`
          }
        }
      }
      return
    }

    if (!sessionActive) return

    const LOOP_BLOCKED_TOOLS: Record<string, string> = {
      question: 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
      loop: 'The loop tool is not available during a loop. Focus on executing the current plan.',
    }

    if (!(tool in LOOP_BLOCKED_TOOLS)) return

    output.title = 'Tool blocked'
    output.output = LOOP_BLOCKED_TOOLS[tool]!
  }

  test('Detects plan approval question and handles "New session" programmatically', () => {
    const output = { title: '', output: 'New session', metadata: {} }

    simulateToolExecuteAfter('question', approvalArgs, output)

    expect(output.output).toContain('New session')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Detects plan approval question and handles "Execute here" with abort', () => {
    const output = { title: '', output: 'Execute here', metadata: {} }

    simulateToolExecuteAfter('question', approvalArgs, output)

    expect(output.output).toContain('Execute here')
    expect(output.output).toContain('Switching to code agent')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Detects plan approval question and handles "Loop" programmatically', () => {
    const output = { title: '', output: 'Loop', metadata: {} }

    simulateToolExecuteAfter('question', approvalArgs, output)

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
          { label: 'Loop', description: 'Loop' },
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
          { label: 'Loop', description: 'Loop' },
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
          { label: 'Loop', description: 'Loop' },
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

    simulateToolExecuteAfter('plan-read', {}, output)

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

  test('Loop blocking works for loop tool', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('loop', {}, output, true)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('loop tool is not available')
  })

  test('Loop blocking does not affect non-blocked tools', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('plan-read', {}, output, true)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Loop blocking only applies when loop is active', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('loop', {}, output, false)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Matches metadata answer exactly', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    // Write a plan for the session so resolveCurrentSessionPlan succeeds
    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toBe('Execute here')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    expect(abortSpy).toHaveBeenCalled()
  })

  test('Matches metadata answer by prefix', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    // Write a plan for the session so resolveCurrentSessionPlan succeeds
    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'User has answered your questions: ...',
      metadata: { answers: [['New session (Recommended)']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toBe('User has answered your questions: ...')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    expect(abortSpy).toHaveBeenCalledWith({ sessionID, directory: "/test" })
  })

  test('Does not match middle-of-string text', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    // Write a plan for the session so resolveCurrentSessionPlan succeeds
    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'User has answered your questions: ...',
      metadata: { answers: [['Please use New session']] },
    }

    await hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toContain('<system-reminder>')
    expect(abortSpy).not.toHaveBeenCalled()
  })

  test('Falls back to output when metadata answers are missing', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    // Write a plan for the session so resolveCurrentSessionPlan succeeds
    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: {},
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toContain('New session')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    
    expect(abortSpy).toHaveBeenCalledWith({ sessionID, directory: "/test" })
  })

  test('Execute here approval schedules source abort and returns without throwing', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toBe('Execute here')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    
    expect(abortSpy).toHaveBeenCalledWith({ sessionID, directory: "/test" })
  })

  test('New session approval schedules source abort and returns without throwing', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: createLoopsRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sandboxManager: null,
    } as unknown as ToolContext

    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toContain('New session')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    
    expect(abortSpy).toHaveBeenCalledWith({ sessionID, directory: "/test" })
  })

  test('Loop approval does not abort and defers to the loop tool', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
    
    const ctx = {
      loop: { service: loopService },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo,
      reviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    expect(abortSpy).not.toHaveBeenCalled()
    expect(output.output).toContain('loop')
    expect(output.output).toContain('<system-reminder>')
  })

  test('does not dispatch loop.start when Loop is selected (defers to loop tool)', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const uniqueSessionId = `loop-dispatch-${Date.now()}`
    const ctx = {
      loop: { service: loopService },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test-dispatch',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo,
      reviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    plansRepo.writeForSession(projectId, uniqueSessionId, '# Dispatch Test Plan\n\nUnique plan for dispatch test.')

    const executionModule = await import('../src/services/execution')
    let capturedCommand: any = null
    vi.spyOn(executionModule, 'createForgeExecutionService').mockImplementation((deps: any) => ({
      dispatch: async (_execCtx: any, command: any) => {
        capturedCommand = command
        return { ok: true, data: {} as any }
      },
    }))

    try {
      const hook = createToolExecuteAfterHook(ctx)

      const args = {
        questions: [{
          question: 'How would you like to proceed?',
          options: [
            { label: 'New session', description: 'Create new session' },
            { label: 'Execute here', description: 'Execute here' },
            { label: 'Loop', description: 'Loop' },
          ],
        }],
      }
      const output = {
        title: 'Asked 1 question',
        output: 'Loop',
        metadata: { answers: [['Loop']] },
      }

      await expect(hook(
        { tool: 'question', sessionID: uniqueSessionId, callID: 'dispatch-test-call', args },
        output
      )).resolves.toBeUndefined()

      // The scheduled dispatch fires synchronously before the first await in the IIFE.
      // Since our mock service.dispatch resolves immediately, the task completes within one microtask.
      await new Promise(resolve => setTimeout(resolve, 10))

      expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
      expect(abortSpy).not.toHaveBeenCalled()
      expect(capturedCommand).toBeNull()
      expect(output.output).toContain('<system-reminder>')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('Tool blocking hook', () => {
  const sessionID = 'outside-session'
  const loopSessionID = 'loop-session'
  const loopName = 'active-loop'

  function createContextForLoopState(state: { active: boolean; sessionId: string; phase?: string } | null): ToolContext {
    return {
      loop: {
        service: {
          resolveLoopName: () => state ? loopName : null,
          getActiveState: () => state,
        },
      },
      logger: createMockLogger(),
    } as unknown as ToolContext
  }

  test('does not block question when resolved loop belongs to another session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      phase: 'auditing',

    }))!

    await expect(hook({ tool: 'question', sessionID, callID: 'call-1' }, { args: {} })).resolves.toBeUndefined()
  })

  test('blocks question for active loop session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      phase: 'auditing',

    }))!

    await expect(hook({ tool: 'question', sessionID: loopSessionID, callID: 'call-1' }, { args: {} })).rejects.toThrow('question tool is not available')
  })

  test('blocks question for active audit session', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      phase: 'auditing',

    }))!

    await expect(hook({ tool: 'question', sessionID: loopSessionID, callID: 'call-1' }, { args: {} })).rejects.toThrow('question tool is not available')
  })

  test('blocks question for child sessions resolved into an active loop', async () => {
    const hook = createToolExecuteBeforeHook(createContextForLoopState(null), {
      resolveActiveLoopForSession: async (sessionID) => sessionID === 'child-session'
        ? { active: true, loopName, phase: 'auditing' }
        : null,
    })!

    await expect(hook({ tool: 'question', sessionID: 'child-session', callID: 'call-1' }, { args: {} })).rejects.toThrow('question tool is not available')
  })

  test('rewrites blocked question output for child sessions resolved into an active loop', async () => {
    const hook = createToolExecuteAfterHook(createContextForLoopState(null), {
      resolveActiveLoopForSession: async (sessionID) => sessionID === 'child-session'
        ? { active: true, loopName, phase: 'auditing' }
        : null,
    })!
    const output = { title: '', output: 'original output', metadata: {} }

    await hook({ tool: 'question', sessionID: 'child-session', callID: 'call-1', args: {} }, output)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('question tool is not available')
  })

  test('does not rewrite after-hook output when resolved loop belongs to another session', async () => {
    const hook = createToolExecuteAfterHook(createContextForLoopState({
      active: true,
      sessionId: loopSessionID,
      phase: 'auditing',

    }))!
    const output = { title: '', output: 'original output', metadata: {} }

    await hook({ tool: 'loop', sessionID, callID: 'call-1', args: {} }, output)

    expect(output.title).toBe('')
    expect(output.output).toBe('original output')
  })
})

describe('Execute here bypass', () => {
  const projectId = 'test-project'
  const sessionID = 'test-session-456'
  const testDir = '/test/dir'
  const openDbs: any[] = []

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs.length = 0
  })

  function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
    const mockClient = {
      session: {
        abort: async () => {},
        promptAsync: async () => {},
        create: async () => ({ id: 'new-session-id' }),
        status: async () => ({}),
        get: async () => ({}),
        messages: async () => [],
        update: async () => {},
        delete: async () => {},
      },
      workspace: {
        create: async () => ({ id: 'mock-ws', directory: '', branch: '' }),
        list: async () => [],
        status: async () => [],
        syncList: async () => {},
        remove: async () => {},
        warp: async () => {},
      },
      tui: {
        publish: async () => {},
        selectSession: async () => {},
      },
      sync: {
        start: async () => {},
      },
    }

    const mockConfig = {
      executionModel: 'test-provider/test-model',
    } as PluginConfig

    const mockLogger = createMockLogger()

    const db = createTestDb()
    openDbs.push(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const plansRepo = createPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)

    return {
      projectId,
      directory: testDir,
      config: mockConfig,
      logger: mockLogger,
      db,
      loop: { service: loopService },
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      client: mockClient,
      ...overrides,
    } as unknown as ToolContext
  }

  test('Execute here bypasses directive injection and triggers abort', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(output.output).toBe('Execute here')
    expect((output.metadata as any).forgePlanApprovalHandled).toBe(true)
    
    expect(abortSpy).toHaveBeenCalledWith({ sessionID, directory: "/test/dir" })
  })

  test('session.idle event triggers promptAsync for pending execution', async () => {
    const promptSpy = vi.fn(() => Promise.resolve())
    const ctx = createMockContext({
      client: {
        session: {
          abort: async () => {},
          promptAsync: promptSpy,
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
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
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(afterHook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    await eventHook({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      },
    })

    expect(promptSpy).toHaveBeenCalled()
    const callArgs = (promptSpy.mock.calls[0]?.[0] as any)
    expect(callArgs?.sessionID).toBe(sessionID)
    expect(callArgs?.agent).toBe('code')
    expect(callArgs?.parts[0].text).toContain('The architect agent has created an implementation plan')

    await eventHook({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      },
    })

    expect(promptSpy).toHaveBeenCalledTimes(1)
  })

  test('New session injects directives but Loop defers to loop tool', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    // Test "New session" first
    const newSessionArgs = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const nsOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call-0', args: newSessionArgs },
      nsOutput
    )).resolves.toBeUndefined()

    expect(nsOutput.output).not.toContain('<system-reminder>')
    expect(nsOutput.output).toBe('New session')
    expect(abortSpy).toHaveBeenCalledTimes(1)

    // Reset abort spy for next test
    abortSpy.mockClear()

    // Test "Loop" — defers to agent, no dispatch
    const loopArgs = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const loopOutput = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call-1', args: loopArgs },
      loopOutput
    )).resolves.toBeUndefined()

    expect(loopOutput.output).toContain('Loop')
    expect(loopOutput.output).toContain('<system-reminder>')
    expect(abortSpy).not.toHaveBeenCalled()
  })

  test('session.idle for non-pending session is a no-op', async () => {
    const promptSpy = vi.fn(() => Promise.resolve())
    const ctx = createMockContext({
      client: {
        session: {
          abort: async () => {},
          promptAsync: promptSpy,
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
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
    
    const abortSpy = vi.fn(() => Promise.resolve())
    
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
    
    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      loop: { service: loopService },
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'unused' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    } as unknown as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    const duplicateOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      duplicateOutput
    )).resolves.toBeUndefined()

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after dispatch
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
    // Abort should have been called (on the port client)
    expect(abortSpy).toHaveBeenCalled()
    // Duplicate should preserve original output and add duplicate metadata
    expect(duplicateOutput.output).toBe('New session')
    expect((duplicateOutput.metadata as any).forgePlanApprovalDuplicate).toBe(true)
  })

  test('Execute here path reads plan from session-scoped repo and plan persists after dispatch', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-execute-here'

    const plansRepo = createPlansRepo(db)

    const originalPlan = '# Execute Here Plan\n\nThis plan should persist after Execute here.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const abortSpy = vi.fn(() => Promise.resolve())

    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loop: { service: loopService },
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: '' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    } as unknown as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan persists in session-scoped repo after dispatch
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
  })

  test('Loop defers to agent (no dispatch, no abort, plan preserved)', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-loop'

    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const originalPlan = '# Loop Plan\n\nThis plan should persist after Loop selection.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const abortSpy = vi.fn(() => Promise.resolve())

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model', loop: { defaultMaxIterations: 5 } } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loop: { service: loopService },
      loopHandler: {
        startWatchdog: vi.fn(() => {}),
      },
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'loop-session-123' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: 'ws-loop-test', directory: `${TEST_DIR}/loop-workspace`, branch: 'opencode/loop' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      db,
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo,
      reviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    // No abort or dispatch — deferring to agent loop tool
    expect(abortSpy).not.toHaveBeenCalled()
    expect(output.output).toContain('<system-reminder>')

    // Plan persists in session-scoped repo (not consumed by dispatch)
    const planAfter = plansRepo.getForSession(projectId, testSessionID)
    expect(planAfter?.content).toBe(originalPlan)
  })

  test('Loop defers to agent even when session create would fail (no dispatch)', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testSessionID = 'test-session-loop-fail'

    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())

    const originalPlan = '# Failed Loop Plan\n\nThis plan should persist.'
    plansRepo.writeForSession(projectId, testSessionID, originalPlan)

    const abortSpy = vi.fn(() => Promise.resolve())
    const tuiPublishSpy = vi.fn(() => Promise.resolve())

    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model', loop: { defaultMaxIterations: 5 } } as PluginConfig,
      logger: createMockLogger(),
      plansRepo,
      loop: { service: loopService },
      loopHandler: {
        startWatchdog: vi.fn(() => {}),
      },
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => { throw new Error('Failed to create session') },
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: tuiPublishSpy,
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      db,
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo,
      reviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    // No abort or dispatch — deferring to agent loop tool
    expect(abortSpy).not.toHaveBeenCalled()
    expect(tuiPublishSpy).not.toHaveBeenCalled()
    expect(output.output).toContain('<system-reminder>')

    // Plan persists (not consumed by dispatch)
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

describe('Fire-and-forget dispatch behavior', () => {
  const projectId = 'test-project-fire-forget'
  const sessionID = 'test-session-fire-forget'
  const testDir = '/test/dir'
  const openDbs: any[] = []
  let nextTestId = 0

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs.length = 0
  })

  function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
    const mockClient = {
      session: {
        abort: async () => {},
        promptAsync: async () => {},
        create: async () => ({ id: 'new-session-id' }),
        status: async () => ({}),
        get: async () => ({}),
        messages: async () => [],
        update: async () => {},
        delete: async () => {},
      },
      workspace: {
        create: async () => ({ id: '', directory: '', branch: '' }),
        list: async () => [],
        status: async () => [],
        syncList: async () => {},
        remove: async () => {},
        warp: async () => {},
      },
      tui: {
        publish: async () => {},
        selectSession: async () => {},
      },
      sync: {
        start: async () => {},
      },
    }

    const mockConfig = {
      executionModel: 'test-provider/test-model',
      loop: { defaultMaxIterations: 5 },
    } as PluginConfig

    const mockLogger = createMockLogger()
    const uid = nextTestId++

    const db = createTestDb()
    openDbs.push(db)
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const plansRepo = createPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)

    return {
      projectId,
      directory: `/test/dir/ff-${uid}`,
      config: mockConfig,
      logger: mockLogger,
      db,
      loop: { service: loopService },
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      client: mockClient,
      loopHandler: {
        startWatchdog: vi.fn(() => {}),
      },
      sandboxManager: null,
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      ...overrides,
    } as unknown as ToolContext
  }

  test('New session approval returns before promptAsync resolves', async () => {
    const sid = 'fire-new-session-' + (++nextTestId)
    let resolvePrompt: () => void
    const pendingPromise = new Promise<any>((resolve) => {
      resolvePrompt = resolve
    })
    
    const abortSpy = vi.fn(() => Promise.resolve())
    
    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: () => pendingPromise,
          create: () => pendingPromise,
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sid, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    // Race hook against short timeout - hook should reject immediately
    const hookPromise = hook(
      { tool: 'question', sessionID: sid, callID: 'test-call', args },
      output
    )

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 50)
    })

    // Hook should resolve before timeout
    await Promise.race([
      hookPromise.then(() => {
        // Hook resolved as expected
      }),
      timeoutPromise.then(() => {
        throw new Error('Hook did not resolve in time')
      }),
    ])
    
    // Output should be preserved immediately
    expect(output.output).toContain('New session')
    
    
    // Abort should be called
    expect(abortSpy).toHaveBeenCalled()
    
    // Clean up pending promise
    resolvePrompt!()
  })

  test('Loop approval returns before promptAsync resolves (defers to loop tool)', async () => {
    let resolvePrompt: () => void
    const pendingPromise = new Promise<any>((resolve) => {
      resolvePrompt = resolve
    })
    
    const abortSpy = vi.fn(() => Promise.resolve())
    
    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: () => pendingPromise,
          create: () => pendingPromise,
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      config: { executionModel: 'test-provider/test-model', loop: { defaultMaxIterations: 5 } } as PluginConfig,
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Loop',
      metadata: { answers: [['Loop']] },
    }

    // Race hook against short timeout - hook should resolve immediately
    const hookPromise = hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 50)
    })

    // Hook should resolve before timeout
    await Promise.race([
      hookPromise.then(() => {
        // Hook resolved as expected
      }),
      timeoutPromise.then(() => {
        throw new Error('Hook did not resolve in time')
      }),
    ])
    
    // Output should contain system-reminder directing agent to use loop tool
    expect(output.output).toContain('Loop')
    expect(output.output).toContain('<system-reminder>')
    
    // No abort or dispatch — deferring to agent loop tool
    expect(abortSpy).not.toHaveBeenCalled()
    
    // Clean up pending promise
    resolvePrompt!()
  })

  test('Duplicate New session approval schedules one dispatch', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    
    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    // First call
    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call-1', args },
      output
    )).resolves.toBeUndefined()

    // Duplicate call with same callID
    const duplicateOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call-1', args },
      duplicateOutput
    )).resolves.toBeUndefined()

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Abort is called for each approval call (both original and duplicate)
    expect(abortSpy).toHaveBeenCalledTimes(2)
    // Duplicate should preserve original output and add duplicate metadata
    expect(duplicateOutput.output).toBe('New session')
    expect((duplicateOutput.metadata as any).forgePlanApprovalDuplicate).toBe(true)
  })

  test('Duplicate New session approval with a different callID schedules one dispatch', async () => {
    const abortSpy = vi.fn(() => Promise.resolve())
    const createSpy = vi.fn(() => Promise.resolve({ id: 'new-session-id' }))

    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: createSpy,
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\nThis is a test plan.')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }

    const firstOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    const firstHook = hook(
      { tool: 'question', sessionID, callID: 'test-call-1', args },
      firstOutput
    )

    const duplicateOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    const duplicateHook = hook(
      { tool: 'question', sessionID, callID: 'test-call-2', args },
      duplicateOutput
    )

    await expect(duplicateHook).resolves.toBeUndefined()
    await expect(firstHook).resolves.toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 200))

    // Only one dispatch session.create (claimed by first caller)
    expect(createSpy).toHaveBeenCalledTimes(1)
    // Abort is called for each approval call (both original and duplicate)
    expect(abortSpy).toHaveBeenCalledTimes(2)
    // Duplicate gets the flag
    expect((duplicateOutput.metadata as any).forgePlanApprovalDuplicate).toBe(true)

    // A third call with yet another callID is also a duplicate
    const laterDuplicateOutput = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await expect(hook(
      { tool: 'question', sessionID, callID: 'test-call-3', args },
      laterDuplicateOutput,
    )).resolves.toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 100))

    // Still only one dispatch
    expect(createSpy).toHaveBeenCalledTimes(1)
    // Abort called a third time
    expect(abortSpy).toHaveBeenCalledTimes(3)
    expect((laterDuplicateOutput.metadata as any).forgePlanApprovalDuplicate).toBe(true)
  })

  test('Dispatch IIFE survives slow source-session abort', async () => {
    let resolveAbort: () => void
    const abortSpy = vi.fn(() => new Promise<void>((resolve) => {
      resolveAbort = resolve
    }))

    const ctx = createMockContext({
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
    })

    ctx.plansRepo.writeForSession(projectId, sessionID, '# Test Plan\n\n')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: '?',
        options: [
          { label: 'New session', description: '' },
          { label: 'Execute here', description: '' },
          { label: 'Loop', description: '' },
        ],
      }],
    }
    const output = {
      title: '',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    // Start the hook (will block on abort)
    const hookPromise = hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    // Wait a tick for the hook to start executing and call abortSpy
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolveAbort).toBeDefined()
    // Now resolve the abort
    resolveAbort!()

    // Hook should resolve
    await expect(hookPromise).resolves.toBeUndefined()
  })

  test('Port abort is called on session.abort', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testPlansRepo = createPlansRepo(db)
    const testLoopsRepo = createLoopsRepo(db)
    const testReviewFindingsRepo = createReviewFindingsRepo(db)
    const abortSpy = vi.fn(() => Promise.resolve())
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: createMockLogger(),
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo: testPlansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: testLoopsRepo,
      reviewFindingsRepo: testReviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    testPlansRepo.writeForSession(projectId, 'test-sid', '# plan')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: 'test-sid', callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(abortSpy).toHaveBeenCalled()
  })

  test('Treats port abort throwing as a failure (logs error)', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const testPlansRepo = createPlansRepo(db)
    const testLoopsRepo = createLoopsRepo(db)
    const testReviewFindingsRepo = createReviewFindingsRepo(db)
    const abortError = new Error('Unable to connect')
    const abortSpy = vi.fn(() => Promise.reject(abortError))
    const errors: unknown[] = []
    const ctx = {
      loop: {
        service: {
          resolveLoopName: () => 'test-loop',
          getActiveState: () => null,
        },
      },
      logger: {
        log: () => {},
        error: (...args: unknown[]) => { errors.push(args) },
        debug: () => {},
      } as Logger,
      client: {
        session: {
          abort: abortSpy,
          promptAsync: async () => {},
          create: async () => ({ id: 'new-session-id' }),
          status: async () => ({}),
          get: async () => ({}),
          messages: async () => [],
          update: async () => {},
          delete: async () => {},
        },
        workspace: {
          create: async () => ({ id: '', directory: '', branch: '' }),
          list: async () => [],
          status: async () => [],
          syncList: async () => {},
          remove: async () => {},
          warp: async () => {},
        },
        tui: {
          publish: async () => {},
          selectSession: async () => {},
        },
        sync: {
          start: async () => {},
        },
      },
      plansRepo: testPlansRepo,
      config: {} as PluginConfig,
      projectId,
      directory: '/test',
      dataDir: TEST_DIR,
      cleanup: async () => {},
      systemPrompt: '',
      messages: [],
      loopsRepo: testLoopsRepo,
      reviewFindingsRepo: testReviewFindingsRepo,
      sandboxManager: null,
    } as unknown as ToolContext

    testPlansRepo.writeForSession(projectId, 'test-sid-error', '# plan')

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop', description: 'Loop' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await expect(hook(
      { tool: 'question', sessionID: 'test-sid-error', callID: 'test-call', args },
      output
    )).resolves.toBeUndefined()

    expect(errors.some(e => {
      const args = Array.isArray(e) ? e : [e]
      return args.some(a => a instanceof Error ? a.message.includes('Unable to connect') : String(a).includes('Unable to connect'))
    })).toBe(true)
  })
})
