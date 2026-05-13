import { describe, test, expect, vi } from 'vitest'

const mockDispatch = vi.fn().mockResolvedValue({ ok: true, data: {} })
const capturedCommands: unknown[] = []

vi.mock('../../src/services/execution', () => ({
  createForgeExecutionService: () => ({
    dispatch: (...args: unknown[]) => {
      capturedCommands.push(args[1])
      return mockDispatch(...args)
    },
  }),
  buildStartLoopCommand: vi.fn((input: unknown) => {
    const cmd = {
      type: 'loop.start',
      ...(input as Record<string, unknown>),
    }
    return cmd
  }),
}))

import { createToolExecuteAfterHook } from '../../src/hooks/plan-approval'
import type { ToolContext } from '../../src/tools/types'
import type { PlanRow, PlansRepo } from '../../src/storage/repos/plans-repo'

interface StubPlanState {
  content: string
  updatedAt: number
}

function createStubPlansRepo(initial: Map<string, StubPlanState> = new Map()): PlansRepo {
  const store = initial
  return {
    writeForSession: (projectId, sessionId, content) => {
      store.set(`${projectId}::${sessionId}`, { content, updatedAt: Date.now() })
    },
    writeForLoop: () => {},
    getForSession: (projectId, sessionId): PlanRow | null => {
      const v = store.get(`${projectId}::${sessionId}`)
      if (!v) return null
      return {
        projectId,
        loopName: null,
        sessionId,
        content: v.content,
        updatedAt: v.updatedAt,
      }
    },
    getForLoop: () => null,
    getForLoopOrSession: () => null,
    promote: () => false,
    deleteForSession: () => {},
    deleteForLoop: () => {},
  }
}

function buildToolContext(opts: {
  projectId: string
  directory: string
  plansRepo: PlansRepo
  abortMock: ReturnType<typeof vi.fn>
}): ToolContext {
  const v2 = {
    session: {
      abort: opts.abortMock,
    },
  }
  return {
    projectId: opts.projectId,
    directory: opts.directory,
    config: {
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      loop: { defaultMaxIterations: 5 },
    },
    logger: { log: () => {}, error: () => {}, debug: () => {} },
    plansRepo: opts.plansRepo,
    v2,
    input: {},
    db: undefined,
    dataDir: '/tmp',
    loopHandler: undefined,
    loop: {
      resolveLoopName: () => null,
      getActiveState: () => null,
      generateUniqueLoopName: (name: string) => `${name}-unique`,
    },
    cleanup: async () => {},
    sandboxManager: null,
    reviewFindingsRepo: {},
    loopsRepo: {},
    sectionPlansRepo: {},
    workspaceStatusRegistry: { awaitConnected: () => Promise.resolve(), recordEvent: () => {} },
  } as unknown as ToolContext
}

function planApprovalQuestionArgs() {
  return {
    questions: [
      {
        question: 'How do you want to proceed?',
        options: [
          { label: 'New session', description: '' },
          { label: 'Execute here', description: '' },
          { label: 'Loop (worktree)', description: '' },
          { label: 'Loop', description: '' },
        ],
      },
    ],
  }
}

describe('plan-approval worktree timing', () => {
  test('"Loop (worktree)" sets lifecycle.selectSessionTiming to "after-create"', async () => {
    capturedCommands.length = 0
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-loop-wt'
    const planContent = '# Loop Plan\n\nWorktree loop.'

    const plansRepo = createStubPlansRepo(
      new Map([[`${projectId}::${sessionID}`, { content: planContent, updatedAt: 1000 }]])
    )
    const abortMock = vi.fn().mockResolvedValue({})
    const ctx = buildToolContext({ projectId, directory, plansRepo, abortMock })
    const hook = createToolExecuteAfterHook(ctx)
    if (!hook) throw new Error('hook not registered')

    const args = planApprovalQuestionArgs()
    const output = { title: '', output: '', metadata: { answers: [['Loop (worktree)']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-wt', args }, output)

    const meta = output.metadata as { forgePlanApprovalHandled?: boolean }
    expect(meta.forgePlanApprovalHandled).toBe(true)

    expect(capturedCommands.length).toBeGreaterThanOrEqual(1)
    const cmd = capturedCommands[capturedCommands.length - 1] as {
      lifecycle?: { selectSession?: boolean; selectSessionTiming?: string; startWatchdog?: boolean; abortSourceSessionOnSuccess?: boolean }
    }
    expect(cmd.lifecycle?.selectSession).toBe(true)
    expect(cmd.lifecycle?.selectSessionTiming).toBe('after-create')
    expect(cmd.lifecycle?.startWatchdog).toBe(true)
    expect(cmd.lifecycle?.abortSourceSessionOnSuccess).toBe(false)
  })

  test('"Loop" sets lifecycle.selectSessionTiming to "after-create"', async () => {
    capturedCommands.length = 0
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-loop-inplace'
    const planContent = '# Loop Plan\n\nIn-place loop.'

    const plansRepo = createStubPlansRepo(
      new Map([[`${projectId}::${sessionID}`, { content: planContent, updatedAt: 1000 }]])
    )
    const abortMock = vi.fn().mockResolvedValue({})
    const ctx = buildToolContext({ projectId, directory, plansRepo, abortMock })
    const hook = createToolExecuteAfterHook(ctx)
    if (!hook) throw new Error('hook not registered')

    const args = planApprovalQuestionArgs()
    const output = { title: '', output: '', metadata: { answers: [['Loop']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-ip', args }, output)

    const meta = output.metadata as { forgePlanApprovalHandled?: boolean }
    expect(meta.forgePlanApprovalHandled).toBe(true)

    expect(capturedCommands.length).toBeGreaterThanOrEqual(1)
    const cmd = capturedCommands[capturedCommands.length - 1] as {
      lifecycle?: { selectSession?: boolean; selectSessionTiming?: string; startWatchdog?: boolean; abortSourceSessionOnSuccess?: boolean }
    }
    expect(cmd.lifecycle?.selectSession).toBe(true)
    expect(cmd.lifecycle?.selectSessionTiming).toBe('after-create')
    expect(cmd.lifecycle?.startWatchdog).toBe(true)
    expect(cmd.lifecycle?.abortSourceSessionOnSuccess).toBe(false)
  })
})
