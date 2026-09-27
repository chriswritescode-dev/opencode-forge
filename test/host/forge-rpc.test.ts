import { describe, test, expect } from 'vitest'
import {
  FORGE_EXECUTION_MODES,
  FORGE_RPC,
  readForgeAutoApproveState,
  readForgeExecutePlanOutput,
  readForgeHostSandboxSetOutput,
  readForgeHostSandboxState,
  readForgeLoopRestartOutput,
  readForgeLoopSidebar,
  readForgeLoops,
  readForgeSessionPlan,
  writeForgeHostSandboxState,
  writeForgeSessionPlan,
} from '../../src/host/forge-rpc'
import { FORGE_PLUGIN_ID } from '../../src/constants/plugin'

describe('FORGE_RPC', () => {
  test('uses the plugin id and exposes every method in contract order', () => {
    expect(FORGE_RPC.id).toBe(FORGE_PLUGIN_ID)
    expect(Object.keys(FORGE_RPC.methods)).toEqual([
      'executePlan',
      'autoApproveState',
      'autoApproveSet',
      'loops',
      'loopSidebar',
      'sessionPlan',
      'loopRestart',
      'hostSandboxState',
      'hostSandboxSet',
    ])
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

  test('autoApproveState requires a session and autoApproveSet requires a session and enabled', () => {
    const stateInput = FORGE_RPC.methods.autoApproveState.input
    expect(stateInput.required).toEqual(['sessionId'])
    expect(stateInput.additionalProperties).toBe(false)

    const setInput = FORGE_RPC.methods.autoApproveSet.input
    expect(setInput.required).toEqual(['sessionId', 'enabled'])
    expect(setInput.additionalProperties).toBe(false)
    expect(setInput.properties.enabled).toEqual({ type: 'boolean' })
  })

  test('readForgeAutoApproveState keeps a state and surfaces errors', () => {
    expect(readForgeAutoApproveState({ enabled: true, ownerSessionId: 'ses_1', inherited: true }))
      .toEqual({ enabled: true, ownerSessionId: 'ses_1', inherited: true })
    expect(readForgeAutoApproveState({ enabled: false })).toEqual({ enabled: false, inherited: false })
    expect(readForgeAutoApproveState({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeAutoApproveState({ enabled: 'yes' }))
      .toEqual({ error: 'Forge returned an invalid auto-approve state' })
    expect(readForgeAutoApproveState(null)).toEqual({ error: 'Forge returned an invalid auto-approve state' })
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

  test('readForgeLoops keeps loop rows and surfaces errors', () => {
    const loops = [{ name: 'loop-a', status: 'running', restartable: true }]
    expect(readForgeLoops({ loops })).toEqual({ loops })
    expect(readForgeLoops({ loops: [{ name: 'loop-a' }] })).toEqual({ error: 'Forge returned an invalid loop list' })
    expect(readForgeLoops({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeLoops(null)).toEqual({ error: 'Forge returned an invalid loop list' })
  })

  test('readForgeLoopSidebar keeps sidebar rows and surfaces errors', () => {
    const loops = [{ loopName: 'loop-a', status: 'running', iteration: 1, maxIterations: 5 }]
    expect(readForgeLoopSidebar({ loops })).toEqual({ loops })
    expect(readForgeLoopSidebar({ loops: [{ loopName: 'loop-a' }] }))
      .toEqual({ error: 'Forge returned an invalid loop sidebar' })
    expect(readForgeLoopSidebar({ error: 'no db' })).toEqual({ error: 'no db' })
  })

  test('writeForgeSessionPlan omits a null plan and readForgeSessionPlan restores it', () => {
    expect(writeForgeSessionPlan(null)).toEqual({})
    expect(writeForgeSessionPlan('# Plan')).toEqual({ plan: '# Plan' })

    expect(readForgeSessionPlan({ plan: '# Plan' })).toEqual({ plan: '# Plan' })
    expect(readForgeSessionPlan({})).toEqual({ plan: null })
    expect(readForgeSessionPlan({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeSessionPlan(null)).toEqual({ error: 'Forge returned an invalid session plan' })
  })

  test('readForgeLoopRestartOutput keeps a session and surfaces errors', () => {
    expect(readForgeLoopRestartOutput({ sessionId: 'ses_1' })).toEqual({ sessionId: 'ses_1' })
    expect(readForgeLoopRestartOutput({ error: 'in progress' })).toEqual({ error: 'in progress' })
    expect(readForgeLoopRestartOutput({})).toEqual({ error: 'Loop restart completed without a session' })
    expect(readForgeLoopRestartOutput(null)).toEqual({ error: 'Forge returned an invalid loop restart result' })
  })

  test('writeForgeHostSandboxState omits null rows and readForgeHostSandboxState restores them', () => {
    expect(writeForgeHostSandboxState({ configEnabled: true, desired: null, applied: null, controller: null }))
      .toEqual({ configEnabled: true })
    expect(writeForgeHostSandboxState({
      configEnabled: true,
      desired: { version: 1, revision: 'rev-1', enabled: true, sessionId: 'ses_1', requestedAt: 1 },
      applied: null,
      controller: null,
      activeLoopSandboxes: { ses_loop: true },
    })).toEqual({
      configEnabled: true,
      desired: { version: 1, revision: 'rev-1', enabled: true, sessionId: 'ses_1', requestedAt: 1 },
      activeLoopSandboxes: { ses_loop: true },
    })

    expect(readForgeHostSandboxState({
      configEnabled: true,
      desired: { version: 1, revision: 'rev-1' },
      activeLoopSandboxes: { ses_loop: true },
    })).toEqual({
      configEnabled: true,
      desired: { version: 1, revision: 'rev-1' },
      applied: null,
      controller: null,
      activeLoopSandboxes: { ses_loop: true },
    })
    expect(readForgeHostSandboxState({ configEnabled: 'yes' }))
      .toEqual({ error: 'Forge returned an invalid host sandbox state' })
    expect(readForgeHostSandboxState({ error: 'no db' })).toEqual({ error: 'no db' })
  })

  test('readForgeHostSandboxSetOutput keeps a revision and surfaces errors', () => {
    expect(readForgeHostSandboxSetOutput({ revision: 'rev-1' })).toEqual({ revision: 'rev-1' })
    expect(readForgeHostSandboxSetOutput({ error: 'disabled' })).toEqual({ error: 'disabled' })
    expect(readForgeHostSandboxSetOutput({})).toEqual({ error: 'Forge returned an invalid host sandbox result' })
  })
})
