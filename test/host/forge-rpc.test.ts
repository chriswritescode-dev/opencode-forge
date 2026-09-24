import { describe, test, expect } from 'vitest'
import { FORGE_EXECUTION_MODES, FORGE_RPC, readForgeExecutePlanOutput } from '../../src/host/forge-rpc'
import { FORGE_PLUGIN_ID } from '../../src/constants/plugin'

describe('FORGE_RPC', () => {
  test('uses the plugin id and exposes only executePlan', () => {
    expect(FORGE_RPC.id).toBe(FORGE_PLUGIN_ID)
    expect(Object.keys(FORGE_RPC.methods)).toEqual(['executePlan'])
  })

  test('executePlan requires a session, mode, title, and plan, and accepts every execution mode', () => {
    const input = FORGE_RPC.methods.executePlan.input
    expect(input.required).toEqual(['sessionId', 'mode', 'title', 'plan'])
    expect(input.properties.mode.enum).toEqual(FORGE_EXECUTION_MODES)
    expect(input.additionalProperties).toBe(false)
  })

  test('readForgeExecutePlanOutput keeps a launch result and surfaces errors', () => {
    expect(readForgeExecutePlanOutput({ sessionId: 'ses_1', loopName: 'loop-a', worktreeDir: '/wt' }))
      .toEqual({ sessionId: 'ses_1', loopName: 'loop-a', worktreeDir: '/wt' })
    expect(readForgeExecutePlanOutput({ error: 'Loops are disabled' })).toEqual({ error: 'Loops are disabled' })
    expect(readForgeExecutePlanOutput({})).toEqual({ error: 'Forge returned no session for the plan execution' })
    expect(readForgeExecutePlanOutput(null)).toEqual({ error: 'Forge returned an invalid plan execution result' })
  })

  test('declares a toast event schema keyed by projectId and message', () => {
    expect(FORGE_RPC.events.toast.schema).toEqual({
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
        variant: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        duration: { type: 'number' },
      },
      required: ['projectId', 'message'],
      additionalProperties: false,
    })
  })
})
