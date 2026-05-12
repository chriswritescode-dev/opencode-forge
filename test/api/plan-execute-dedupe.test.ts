import { describe, test, expect, vi, beforeEach } from 'vitest'

const mockDispatch = vi.fn()

vi.mock('../../src/api/handlers/_shared', () => ({
  buildService: () => ({
    service: { dispatch: mockDispatch },
    execCtx: { surface: 'api' as const, projectId: 'p1', directory: '/tmp/test' },
  }),
}))

const { handleExecutePlan } = await import('../../src/api/handlers/plan-execute')

describe('plan-execute RPC dedupe', () => {
  beforeEach(() => {
    mockDispatch.mockReset()
  })

  test('two concurrent plan.execute loop-worktree calls dispatch handleStartLoop only once', async () => {
    const loopResult = {
      ok: true,
      data: {
        operation: 'loop.start',
        mode: 'worktree',
        sessionId: 'session-loop-1',
        loopName: 'test-loop',
        displayName: 'Test Loop',
        executionName: 'Test Loop',
        worktreeDir: '/tmp/wt/abc',
        workspaceId: 'ws-test',
        hostSessionId: 's1',
        modelUsed: null,
        maxIterations: 0,
      },
    }

    mockDispatch.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(loopResult), 30)))

    const deps = {
      ctx: {
        plansRepo: { getForSession: () => ({ content: 'SAMPLE_PLAN', updatedAt: Date.now() }) },
        config: { executionModel: 'prov/exec', auditorModel: 'prov/aud' },
        logger: { log: () => {}, error: () => {}, debug: () => {} },
        dataDir: '/tmp',
        v2: {},
        loopsRepo: {},
        loopHandler: {},
        loop: {},
        sandboxManager: null,
        sectionPlansRepo: {},
      },
      logger: { log: () => {}, error: () => {}, debug: () => {} },
      projectId: 'p1',
      eventPublisher: vi.fn(),
    } as any

    const body = { mode: 'loop-worktree', title: 'Test Loop', plan: 'SAMPLE_PLAN' }

    const [r1, r2] = await Promise.all([
      handleExecutePlan(deps, { projectId: 'p1', sessionId: 's1' }, body),
      handleExecutePlan(deps, { projectId: 'p1', sessionId: 's1' }, body),
    ])

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
    expect((r1 as any).sessionId).toBe('session-loop-1')
    expect((r2 as any).sessionId).toBe('session-loop-1')
  })
})
