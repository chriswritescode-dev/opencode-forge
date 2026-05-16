import { describe, test, expect, vi } from 'vitest'
import { performTerminationSideEffects } from '../../src/hooks/host-side-effects'
import type { LoopState, TerminationReason } from '../../src/loop'
import type { PluginConfig } from '../../src/types'

function buildState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: 'coding',
    active: false,
    sessionId: 'sess_worktree',
    hostSessionId: 'sess_host',
    loopName: 'feat-x',
    worktreeDir: '/tmp/wt/feat-x',
    projectDir: '/tmp/project',
    worktreeBranch: 'forge/feat-x',
    iteration: 3,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    currentSectionIndex: 0,
    totalSections: 1,
    finalAuditDone: false,
    worktree: true,
    workspaceId: 'ws_abc',
    ...overrides,
  } as LoopState
}

function buildCtx(overrides?: {
  tuiPublish?: ReturnType<typeof vi.fn>
  workspaceRemove?: ReturnType<typeof vi.fn>
  log?: ReturnType<typeof vi.fn>
  error?: ReturnType<typeof vi.fn>
}) {
  const tuiPublish = overrides?.tuiPublish ?? vi.fn().mockResolvedValue({ data: {} })
  const workspaceRemove = overrides?.workspaceRemove ?? vi.fn().mockResolvedValue({ data: {} })
  const log = overrides?.log ?? vi.fn()
  const error = overrides?.error ?? vi.fn()

  return {
    ctx: {
      v2Client: {
        tui: { publish: tuiPublish },
        experimental: { workspace: { remove: workspaceRemove } },
      } as never,
      logger: { log, error, debug: () => {} },
      getConfig: () => ({}) as PluginConfig,
    },
    tuiPublish,
    workspaceRemove,
    log,
    error,
  }
}

const completed: TerminationReason = { kind: 'completed' }

describe('performTerminationSideEffects unwarp', () => {
  test('publishes select to host session in projectDir before workspace.remove', async () => {
    const callOrder: string[] = []
    const tuiPublish = vi.fn().mockImplementation(async (arg: unknown) => {
      const body = (arg as { body: { type: string } }).body
      if (body.type === 'tui.session.select') callOrder.push('select')
      if (body.type === 'tui.toast.show') callOrder.push('toast')
      return { data: {} }
    })
    const workspaceRemove = vi.fn().mockImplementation(async () => {
      callOrder.push('remove')
      return { data: {} }
    })
    const { ctx } = buildCtx({ tuiPublish, workspaceRemove })

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    const selectCall = tuiPublish.mock.calls.find(
      (c) => (c[0] as { body: { type: string } }).body.type === 'tui.session.select',
    )
    expect(selectCall).toBeTruthy()
    const arg = selectCall![0] as {
      directory: string
      body: { type: string; properties: { sessionID: string; workspace?: string } }
    }
    expect(arg.directory).toBe('/tmp/project')
    expect(arg.body.properties.sessionID).toBe('sess_host')
    expect(arg.body.properties.workspace).toBeUndefined()
    expect(callOrder.indexOf('select')).toBeLessThan(callOrder.indexOf('remove'))
  })

  test('skips unwarp when hostSessionId missing', async () => {
    const { ctx, tuiPublish, workspaceRemove } = buildCtx()
    const state = buildState({ hostSessionId: undefined })

    await performTerminationSideEffects(state, completed, 'sess_worktree', ctx)

    const selectCall = tuiPublish.mock.calls.find(
      (c) => (c[0] as { body: { type: string } }).body.type === 'tui.session.select',
    )
    expect(selectCall).toBeUndefined()
    expect(workspaceRemove).toHaveBeenCalled()
  })

  test('skips unwarp when projectDir missing', async () => {
    const { ctx, tuiPublish, workspaceRemove } = buildCtx()
    const state = buildState({ projectDir: undefined })

    await performTerminationSideEffects(state, completed, 'sess_worktree', ctx)

    const selectCall = tuiPublish.mock.calls.find(
      (c) => (c[0] as { body: { type: string } }).body.type === 'tui.session.select',
    )
    expect(selectCall).toBeUndefined()
    expect(workspaceRemove).toHaveBeenCalled()
  })

  test('unwarp failure does not block workspace.remove', async () => {
    const tuiPublish = vi.fn().mockImplementation(async (arg: unknown) => {
      const body = (arg as { body: { type: string } }).body
      if (body.type === 'tui.session.select') throw new Error('publish failed')
      return { data: {} }
    })
    const { ctx, workspaceRemove, error } = buildCtx({ tuiPublish })

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_abc' })
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('unwarp publish failed for feat-x'),
      expect.any(Error),
    )
  })
})
