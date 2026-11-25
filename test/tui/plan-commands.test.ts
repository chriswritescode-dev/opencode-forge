import { describe, expect, test, vi } from 'vitest'
import { createForgePlanCommands } from '../../src/tui/plan-commands'
import { openExecutionDialog } from '../../src/tui/execute-plan-panel'
import type { ForgeProjectClient } from '../../src/tui/project-client'
import type { ForgeTuiHost } from '../../src/tui/host'
import type { PluginConfig } from '../../src/types'
import type { LoopInfo } from '../../src/utils/tui-models'
import type { ExecutionContextCache } from '../../src/utils/tui-execution-context-cache'

vi.mock('../../src/tui/execute-plan-panel', () => ({ openExecutionDialog: vi.fn() }))

function loop(overrides: Partial<LoopInfo> = {}): LoopInfo {
  return {
    name: 'loop',
    status: 'completed',
    phase: 'coding',
    iteration: 1,
    maxIterations: 5,
    sessionId: 'ses_loop',
    restartable: true,
    restartRequiresForce: false,
    ...overrides,
  }
}

describe('createForgePlanCommands', () => {
  function setup(loadLoops: ForgeProjectClient['loadLoops'], sessionId: string | null = 'ses_1') {
    const toasts: Array<{ message: string; variant?: string }> = []
    const host = {
      toast: (input: { message: string; variant?: string }) => toasts.push(input),
      prompt: vi.fn(async () => undefined),
      colors: () => ({}),
    } as unknown as ForgeTuiHost
    const client = { loadLoops } as unknown as ForgeProjectClient
    const commands = createForgePlanCommands({
      host,
      pluginConfig: {} as PluginConfig,
      currentSessionId: () => sessionId,
      ensureClient: async () => ({ client, cache: null as unknown as ExecutionContextCache }),
    })
    return { commands, toasts }
  }

  test('restartLoop toasts the loops RPC error', async () => {
    const { commands, toasts } = setup(async () => ({ error: 'rpc.unavailable' }))

    await commands.restartLoop()

    expect(toasts.at(-1)).toMatchObject({ message: 'Could not list loops: rpc.unavailable', variant: 'warning' })
  })

  test('restartLoop toasts when no loops are restartable', async () => {
    const { commands, toasts } = setup(async () => ({ loops: [] }))

    await commands.restartLoop()

    expect(toasts.at(-1)).toMatchObject({ message: 'No restartable loops', variant: 'info' })
  })

  test('restartLoop surfaces the restart block reason when one exists', async () => {
    const { commands, toasts } = setup(async () => ({
      loops: [loop({ restartable: false, restartBlockedMessage: 'Loop is still running' })],
    }))

    await commands.restartLoop()

    expect(toasts.at(-1)).toMatchObject({ message: 'Loop is still running', variant: 'info' })
  })

  test('executePlan without a session opens restart and asks for a session when nothing is restartable', async () => {
    const loadLoops = vi.fn(async () => ({ loops: [] }))
    const { commands, toasts } = setup(loadLoops, null)

    await commands.executePlan()

    expect(loadLoops).toHaveBeenCalledTimes(1)
    expect(toasts.at(-1)).toMatchObject({ message: 'Open a session to execute a plan', variant: 'info' })
  })

  test('restartLoop falls back to the project cache default model, not another project\'s', async () => {
    const restartLoop = vi.fn(async () => ({ sessionId: 'ses_restart' }))
    const selectSession = vi.fn(async () => {})
    const client = {
      loadLoops: async () => ({ loops: [loop()] }),
      restartLoop,
      selectSession,
    } as unknown as ForgeProjectClient
    const cache = {
      snapshot: () => ({ openCodeDefault: 'b/default' }),
    } as unknown as ExecutionContextCache
    const host = {
      toast: () => {},
      prompt: vi.fn(async () => undefined),
      colors: () => ({}),
    } as unknown as ForgeTuiHost
    const commands = createForgePlanCommands({
      host,
      pluginConfig: {} as PluginConfig,
      currentSessionId: () => 'ses_1',
      ensureClient: async () => ({ client, cache }),
    })
    const openDialog = vi.mocked(openExecutionDialog)
    openDialog.mockClear()

    await commands.restartLoop()

    const restart = openDialog.mock.calls[0][0].restart
    expect(restart).toBeDefined()
    await restart!.onRestart({
      loopName: 'loop',
      auditorModel: '',
      auditorVariant: '',
      executionModel: '',
      executionVariant: '',
      force: false,
    })

    expect(restartLoop).toHaveBeenCalledWith({
      loopName: 'loop',
      auditorModel: 'b/default',
      auditorVariant: '',
      executionModel: 'b/default',
      executionVariant: '',
      force: false,
    })
  })

  test('restartLoop pre-populates agent selections and post-action agent', async () => {
    const restartLoop = vi.fn(async () => ({ sessionId: 'ses_restart' }))
    const client = {
      loadLoops: async () => ({
        loops: [loop({ executionAgent: 'exec-agent', auditorAgent: 'audit-agent', postActionAgent: 'post-agent' })],
      }),
      restartLoop,
      selectSession: vi.fn(async () => {}),
    } as unknown as ForgeProjectClient
    const cache = {
      snapshot: () => ({ openCodeDefault: 'b/default' }),
    } as unknown as ExecutionContextCache
    const host = {
      toast: () => {},
      prompt: vi.fn(async () => undefined),
      colors: () => ({}),
    } as unknown as ForgeTuiHost
    const commands = createForgePlanCommands({
      host,
      pluginConfig: {} as PluginConfig,
      currentSessionId: () => 'ses_1',
      ensureClient: async () => ({ client, cache }),
    })
    const openDialog = vi.mocked(openExecutionDialog)
    openDialog.mockClear()

    await commands.restartLoop()

    const options = openDialog.mock.calls[0][0]
    expect(options.initial).toMatchObject({
      executionAgent: 'exec-agent',
      auditorAgent: 'audit-agent',
      loopSettings: { postActionAgent: 'post-agent' },
    })

    await options.restart!.onRestart({
      loopName: 'loop',
      auditorModel: '',
      auditorVariant: '',
      executionModel: '',
      executionVariant: '',
      executionAgent: 'exec-agent',
      auditorAgent: 'audit-agent',
      postActionAgent: 'post-agent',
      force: false,
    })

    expect(restartLoop).toHaveBeenCalledWith({
      loopName: 'loop',
      auditorModel: 'b/default',
      auditorVariant: '',
      executionModel: 'b/default',
      executionVariant: '',
      executionAgent: 'exec-agent',
      auditorAgent: 'audit-agent',
      postActionAgent: 'post-agent',
      force: false,
    })
  })

  test('restartLoop leaves agent selections empty and post-action unset when the loop has none', async () => {
    const client = {
      loadLoops: async () => ({ loops: [loop()] }),
      restartLoop: vi.fn(async () => ({ sessionId: 'ses_restart' })),
      selectSession: vi.fn(async () => {}),
    } as unknown as ForgeProjectClient
    const host = {
      toast: () => {},
      prompt: vi.fn(async () => undefined),
      colors: () => ({}),
    } as unknown as ForgeTuiHost
    const commands = createForgePlanCommands({
      host,
      pluginConfig: {} as PluginConfig,
      currentSessionId: () => 'ses_1',
      ensureClient: async () => ({ client, cache: null as unknown as ExecutionContextCache }),
    })
    const openDialog = vi.mocked(openExecutionDialog)
    openDialog.mockClear()

    await commands.restartLoop()

    expect(openDialog.mock.calls[0][0].initial).toMatchObject({
      executionAgent: '',
      auditorAgent: '',
      loopSettings: undefined,
    })
  })
})
