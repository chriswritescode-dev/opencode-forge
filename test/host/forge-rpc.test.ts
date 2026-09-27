import { describe, test, expect } from 'vitest'
import {
  FORGE_EXECUTION_MODES,
  FORGE_RPC,
  readForgeAutoApproveChangedEvent,
  readForgeAutoApproveState,
  readForgeExecutePlanOutput,
  readForgeHostSandboxChangedEvent,
  readForgeHostSandboxSetOutput,
  readForgeHostSandboxState,
  readForgeLoopDefaults,
  readForgeLoopRestartOutput,
  readForgeLoopSidebar,
  readForgeLoops,
  readForgeLoopsChangedEvent,
  readForgeSessionPlan,
  readForgeVersion,
  readForgeWorktrees,
  toForgeRpcJson,
} from '../../src/host/forge-rpc'
import { FORGE_PLUGIN_ID } from '../../src/constants/plugin'

describe('FORGE_RPC', () => {
  test('uses the plugin id and exposes every method in contract order', () => {
    expect(FORGE_RPC.id).toBe(FORGE_PLUGIN_ID)
    expect(Object.keys(FORGE_RPC.methods)).toEqual([
      'executePlan',
      'loopDefaults',
      'autoApproveState',
      'autoApproveSet',
      'loops',
      'loopSidebar',
      'sessionPlan',
      'loopRestart',
      'hostSandboxState',
      'hostSandboxSet',
      'worktrees',
      'version',
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

  test('executePlan accepts loop settings and loopDefaults declares an empty input', () => {
    const input = FORGE_RPC.methods.executePlan.input
    expect(input.properties.maxIterations).toEqual({ type: 'integer', minimum: 0 })
    expect(input.properties.sandbox).toEqual({
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        resources: {
          type: 'object',
          properties: {
            memory: { type: 'string' },
            cpus: { type: 'string' },
            dockerDisk: { type: 'string' },
            cacheDisk: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    })

    const method = FORGE_RPC.methods.loopDefaults
    expect(method.input).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(method.output.properties.maxIterations).toEqual({ type: 'integer' })
    expect(method.output.properties.sandbox).toEqual({
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        resources: {
          type: 'object',
          properties: {
            memory: { type: 'string' },
            cpus: { type: 'string' },
            dockerDisk: { type: 'string' },
            cacheDisk: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    })
    expect(method.output.additionalProperties).toBe(false)
  })

  test('readForgeLoopDefaults keeps defaults and rejects invalid payloads', () => {
    const defaults = {
      maxIterations: 10,
      sandbox: {
        available: true,
        resources: { memory: '8g', cpus: '4', dockerDisk: '16g', cacheDisk: '16g' },
      },
    }
    expect(readForgeLoopDefaults(defaults)).toEqual(defaults)
    expect(readForgeLoopDefaults({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeLoopDefaults(null)).toEqual({ error: 'Forge returned an invalid loop defaults' })
    expect(readForgeLoopDefaults({ maxIterations: 10 }))
      .toEqual({ error: 'Forge returned an invalid loop defaults' })
    expect(readForgeLoopDefaults({ maxIterations: 10, sandbox: { available: true } }))
      .toEqual({ error: 'Forge returned an invalid loop defaults' })
    expect(readForgeLoopDefaults({
      maxIterations: 10,
      sandbox: { available: true, resources: { memory: '8g', cpus: '4', dockerDisk: '16g' } },
    })).toEqual({ error: 'Forge returned an invalid loop defaults' })
    expect(readForgeLoopDefaults({ maxIterations: 1.5, sandbox: defaults.sandbox }))
      .toEqual({ error: 'Forge returned an invalid loop defaults' })
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

  test('declares the version method with an empty input and a version output', () => {
    const method = FORGE_RPC.methods.version
    expect(method.input).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(method.output.properties.version).toEqual({ type: 'string' })
    expect(method.output.additionalProperties).toBe(false)
  })

  test('readForgeVersion keeps a version and surfaces errors', () => {
    expect(readForgeVersion({ version: '1.1.1' })).toEqual({ version: '1.1.1' })
    expect(readForgeVersion({ error: 'no server' })).toEqual({ error: 'no server' })
    expect(readForgeVersion({})).toEqual({ error: 'Forge returned an invalid version' })
    expect(readForgeVersion(null)).toEqual({ error: 'Forge returned an invalid version' })
  })

  test('declares the three TUI push event schemas keyed by projectId', () => {
    expect(FORGE_RPC.events.loopsChanged.schema).toEqual({
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    })
    expect(FORGE_RPC.events.autoApproveChanged.schema).toEqual({
      type: 'object',
      properties: { projectId: { type: 'string' }, sessionId: { type: 'string' } },
      required: ['projectId', 'sessionId'],
      additionalProperties: false,
    })
    expect(FORGE_RPC.events.hostSandboxChanged.schema).toEqual({
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    })
  })

  test('readForgeLoopsChangedEvent keeps a projectId and rejects a malformed payload', () => {
    expect(readForgeLoopsChangedEvent({ projectId: 'proj_1' })).toEqual({ projectId: 'proj_1' })
    expect(readForgeLoopsChangedEvent({})).toBeNull()
    expect(readForgeLoopsChangedEvent({ projectId: 1 })).toBeNull()
  })

  test('readForgeAutoApproveChangedEvent keeps a projectId and sessionId, and rejects a partial payload', () => {
    expect(readForgeAutoApproveChangedEvent({ projectId: 'proj_1', sessionId: 'ses_1' }))
      .toEqual({ projectId: 'proj_1', sessionId: 'ses_1' })
    expect(readForgeAutoApproveChangedEvent({ projectId: 'proj_1' })).toBeNull()
    expect(readForgeAutoApproveChangedEvent({ sessionId: 'ses_1' })).toBeNull()
  })

  test('readForgeHostSandboxChangedEvent keeps a projectId and rejects a malformed payload', () => {
    expect(readForgeHostSandboxChangedEvent({ projectId: 'proj_1' })).toEqual({ projectId: 'proj_1' })
    expect(readForgeHostSandboxChangedEvent({})).toBeNull()
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

  test('readForgeLoops keeps trimmed loop rows and surfaces errors', () => {
    const loops = [{
      name: 'loop-a',
      status: 'running',
      phase: 'coding',
      iteration: 2,
      maxIterations: 5,
      sessionId: 'ses_1',
      restartable: true,
      restartRequiresForce: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    }]
    expect(readForgeLoops({ loops })).toEqual({ loops })
    expect(readForgeLoops({ loops: [{ name: 'loop-a', status: 'running', restartable: true }] }))
      .toEqual({ error: 'Forge returned an invalid loop list' })
    expect(readForgeLoops({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeLoops(null)).toEqual({ error: 'Forge returned an invalid loop list' })
  })

  test('readForgeLoopSidebar keeps sidebar rows and surfaces errors', () => {
    const loops = [{
      loopName: 'loop-a', status: 'running', iteration: 1, maxIterations: 5,
      startedAt: 100, phase: 'auditing', phaseStartedAt: 150, currentSectionIndex: 1, totalSections: 3,
    }]
    expect(readForgeLoopSidebar({ loops })).toEqual({ loops })
    expect(readForgeLoopSidebar({ loops: [{ loopName: 'loop-a', status: 'running', iteration: 1, maxIterations: 5, startedAt: 100 }] }))
      .toEqual({ error: 'Forge returned an invalid loop sidebar' })
    expect(readForgeLoopSidebar({ error: 'no db' })).toEqual({ error: 'no db' })
  })

  test('toForgeRpcJson omits a top-level null plan and readForgeSessionPlan restores it', () => {
    expect(toForgeRpcJson({ plan: null })).toEqual({})
    expect(toForgeRpcJson({ plan: '# Plan' })).toEqual({ plan: '# Plan' })

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

  test('toForgeRpcJson omits top-level null rows and readForgeHostSandboxState restores them', () => {
    expect(toForgeRpcJson({ configEnabled: true, desired: null, applied: null, controller: null }))
      .toEqual({ configEnabled: true })
    expect(toForgeRpcJson({
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

  test('readForgeWorktrees keeps a root and dir list and surfaces errors', () => {
    expect(readForgeWorktrees({ root: '/server/worktrees', dirs: ['/server/worktrees/loop-a'] }))
      .toEqual({ root: '/server/worktrees', dirs: ['/server/worktrees/loop-a'] })
    expect(readForgeWorktrees({ root: '/server/worktrees', dirs: [] }))
      .toEqual({ root: '/server/worktrees', dirs: [] })
    expect(readForgeWorktrees({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeWorktrees({ dirs: [] })).toEqual({ error: 'Forge returned an invalid worktree list' })
    expect(readForgeWorktrees({ root: '/server/worktrees', dirs: [1] }))
      .toEqual({ error: 'Forge returned an invalid worktree list' })
    expect(readForgeWorktrees(null)).toEqual({ error: 'Forge returned an invalid worktree list' })
  })
})
