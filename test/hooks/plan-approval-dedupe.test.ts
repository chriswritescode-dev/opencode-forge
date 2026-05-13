import { describe, test, expect, vi } from 'vitest'
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
  publishMock?: ReturnType<typeof vi.fn>
}): ToolContext {
  const v2 = {
    session: {
      abort: opts.abortMock,
    },
    tui: opts.publishMock ? { publish: opts.publishMock } : undefined,
  }
  return {
    projectId: opts.projectId,
    directory: opts.directory,
    config: { executionModel: 'prov/exec', auditorModel: 'prov/aud' },
    logger: { log: () => {}, error: () => {}, debug: () => {} },
    plansRepo: opts.plansRepo,
    v2,
    input: {},
    // Fields not exercised on the question/"Execute here" path:
    db: undefined,
    dataDir: '/tmp',
    loopHandler: undefined,
    loop: { resolveLoopName: () => null, getActiveState: () => null },
    cleanup: async () => {},
    sandboxManager: null,
    reviewFindingsRepo: {},
    loopsRepo: {},
    sectionPlansRepo: {},
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
          { label: 'Loop', description: '' },
        ],
      },
    ],
  }
}

describe('plan-approval afterHook dedupes by plan content regardless of updatedAt', () => {
  test('two "Execute here" answers with same content but bumped updatedAt: second is duplicate', async () => {
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-1'
    const planContent = '# Plan Title\n\nSame body.'

    const initial = new Map<string, StubPlanState>([
      [`${projectId}::${sessionID}`, { content: planContent, updatedAt: 1000 }],
    ])
    const plansRepo = createStubPlansRepo(initial)
    const abortMock = vi.fn().mockResolvedValue({})

    const ctx = buildToolContext({ projectId, directory, plansRepo, abortMock })
    const hook = createToolExecuteAfterHook(ctx)
    if (!hook) throw new Error('hook not registered')

    const args = planApprovalQuestionArgs()

    const output1 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-A', args }, output1)

    // First call: handled but not duplicate
    const meta1 = output1.metadata as { forgePlanApprovalHandled?: boolean; forgePlanApprovalDuplicate?: boolean }
    expect(meta1.forgePlanApprovalHandled).toBe(true)
    expect(meta1.forgePlanApprovalDuplicate).toBeUndefined()

    // Simulate touch-on-write: same content, new updatedAt
    await new Promise(r => setTimeout(r, 2))
    plansRepo.writeForSession(projectId, sessionID, planContent)
    const fresh = plansRepo.getForSession(projectId, sessionID)
    expect(fresh?.updatedAt).toBeGreaterThan(1000)

    const output2 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-B', args }, output2)

    const meta2 = output2.metadata as { forgePlanApprovalHandled?: boolean; forgePlanApprovalDuplicate?: boolean }
    expect(meta2.forgePlanApprovalHandled).toBe(true)
    expect(meta2.forgePlanApprovalDuplicate).toBe(true)
  })

  test('two "Execute here" answers with different plan content: second is NOT duplicate', async () => {
    const projectId = `proj-${Math.random().toString(36).slice(2)}`
    const directory = `/tmp/${projectId}`
    const sessionID = 'sess-2'

    const initial = new Map<string, StubPlanState>([
      [`${projectId}::${sessionID}`, { content: '# Plan A', updatedAt: 1000 }],
    ])
    const plansRepo = createStubPlansRepo(initial)
    const abortMock = vi.fn().mockResolvedValue({})

    const ctx = buildToolContext({ projectId, directory, plansRepo, abortMock })
    const hook = createToolExecuteAfterHook(ctx)
    if (!hook) throw new Error('hook not registered')
    const args = planApprovalQuestionArgs()

    const output1 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-A', args }, output1)
    const meta1 = output1.metadata as { forgePlanApprovalDuplicate?: boolean }
    expect(meta1.forgePlanApprovalDuplicate).toBeUndefined()

    // Replace plan with different content
    plansRepo.writeForSession(projectId, sessionID, '# Plan B — different body')

    const output2 = { title: '', output: '', metadata: { answers: [['Execute here']] } }
    await hook({ tool: 'question', sessionID, callID: 'call-B', args }, output2)
    const meta2 = output2.metadata as { forgePlanApprovalDuplicate?: boolean }
    expect(meta2.forgePlanApprovalDuplicate).toBeUndefined()
  })
})
