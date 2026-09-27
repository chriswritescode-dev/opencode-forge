import { describe, expect, test, vi } from 'vitest'
import { createForgePlanCommands } from '../../src/tui/plan-commands'
import type { ForgeProjectClient } from '../../src/tui/project-client'
import type { ForgeTuiHost } from '../../src/tui/host'
import type { PluginConfig } from '../../src/types'
import type { LoopInfo } from '../../src/utils/tui-models'

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
  function setup(loadLoops: ForgeProjectClient['loadLoops']) {
    const toasts: Array<{ message: string; variant?: string }> = []
    const host = {
      toast: (input: { message: string; variant?: string }) => toasts.push(input),
      prompt: vi.fn(async () => undefined),
      defaultModel: () => 'a/default',
      colors: () => ({}),
    } as unknown as ForgeTuiHost
    const client = { loadLoops } as unknown as ForgeProjectClient
    const commands = createForgePlanCommands({
      host,
      pluginConfig: {} as PluginConfig,
      currentSessionId: () => 'ses_1',
      ensureClient: async () => client,
      cache: () => null,
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
})
