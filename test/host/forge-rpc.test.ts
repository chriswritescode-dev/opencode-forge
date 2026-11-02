import { describe, test, expect } from 'vitest'
import {
  FORGE_EXECUTION_MODES,
  FORGE_RPC,
  readForgeAutoApproveChangedEvent,
  readForgeAutoApproveState,
  readForgeExecutePlanOutput,
  readForgeHostSandboxSetOutput,
  readForgeHostSandboxState,
  readForgeLoopDefaults,
  readForgeLoopRestartOutput,
  readForgeLoopSidebar,
  readForgeLoopDetail,
  readForgeLoops,
  readForgeProjectFindings,
  readForgeAmendmentDiff,
  readForgePlanDeleteOutput,
  readForgeProjectChangedEvent,
  readForgeSessionPlan,
  readForgeDashboardSummary,
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
      'dashboardSummary',
      'loopDetail',
      'projectFindings',
      'amendmentDiff',
      'planDelete',
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
    expect(readForgeExecutePlanOutput({ sessionId: 'ses_1', loopName: 'loop-b', workspaceId: 'ws-1' }))
      .toEqual({ sessionId: 'ses_1', loopName: 'loop-b', workspaceId: 'ws-1' })
    expect(readForgeExecutePlanOutput({ sessionId: 'ses_1', loopName: 'loop-a', branch: 'pm-61-export' }))
      .toEqual({ sessionId: 'ses_1', loopName: 'loop-a', branch: 'pm-61-export' })
    expect(readForgeExecutePlanOutput({ error: 'Loops are disabled' })).toEqual({ error: 'Loops are disabled' })
    expect(readForgeExecutePlanOutput({})).toEqual({ error: 'Forge returned no session for the plan execution' })
    expect(readForgeExecutePlanOutput(null)).toEqual({ error: 'Forge returned an invalid plan execution result' })
  })

  test('executePlan accepts an explicit branch and baseRef', () => {
    const method = FORGE_RPC.methods.executePlan
    expect(method.input.properties.branch).toEqual({ type: 'string', minLength: 1 })
    expect(method.input.properties.baseRef).toEqual({ type: 'string', minLength: 1 })
    expect(method.output.properties.branch).toEqual({ type: 'string' })
    expect(FORGE_RPC.methods.loops.output.properties.loops.items.properties.branch).toEqual({ type: 'string' })
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
        allowLan: { type: 'boolean' },
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
        allowLan: { type: 'boolean' },
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
        allowLan: true,
      },
    }
    expect(readForgeLoopDefaults(defaults)).toEqual(defaults)
    const { allowLan: _allowLan, ...olderServerSandbox } = defaults.sandbox
    expect(readForgeLoopDefaults({ ...defaults, sandbox: olderServerSandbox }))
      .toEqual({ ...defaults, sandbox: { ...olderServerSandbox, allowLan: false } })
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

  test('declares the dashboardSummary method with an empty input and a summary output', () => {
    const method = FORGE_RPC.methods.dashboardSummary
    expect(method.input).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(method.output.properties.generatedAt).toEqual({ type: 'number' })
    expect(method.output.properties.projects.type).toBe('array')
    expect(method.output.properties.error).toEqual({ type: 'string' })
    expect(method.output.additionalProperties).toBe(false)
  })

  test('readForgeDashboardSummary keeps a valid summary and surfaces errors', () => {
    const summary = {
      generatedAt: 1,
      projects: [{
        projectId: 'p1',
        loopCount: 0,
        unexecutedPlanCount: 0,
        bugCount: 0,
        loops: [],
        unexecutedPlans: [],
      }],
    }
    expect(readForgeDashboardSummary(summary)).toEqual(summary)
    expect(readForgeDashboardSummary({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeDashboardSummary({ generatedAt: 1, projects: [{ projectId: 'p1' }] }))
      .toEqual({ error: 'Forge returned an invalid dashboard summary' })
    expect(readForgeDashboardSummary({ generatedAt: 'now', projects: [] }))
      .toEqual({ error: 'Forge returned an invalid dashboard summary' })
    expect(readForgeDashboardSummary(null))
      .toEqual({ error: 'Forge returned an invalid dashboard summary' })
  })

  test('declares loopDetail, projectFindings and amendmentDiff inputs', () => {
    expect(FORGE_RPC.methods.loopDetail.input).toEqual({
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        loopName: { type: 'string', minLength: 1 },
      },
      required: ['projectId', 'loopName'],
      additionalProperties: false,
    })
    expect(FORGE_RPC.methods.projectFindings.input).toEqual({
      type: 'object',
      properties: { projectId: { type: 'string', minLength: 1 } },
      required: ['projectId'],
      additionalProperties: false,
    })
    expect(FORGE_RPC.methods.amendmentDiff.input).toEqual({
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        loopName: { type: 'string', minLength: 1 },
        id: { type: 'integer', minimum: 1 },
      },
      required: ['projectId', 'loopName', 'id'],
      additionalProperties: false,
    })
    for (const method of [FORGE_RPC.methods.loopDetail, FORGE_RPC.methods.projectFindings, FORGE_RPC.methods.amendmentDiff]) {
      expect(method.output.properties.error).toEqual({ type: 'string' })
      expect(method.output.additionalProperties).toBe(false)
    }
  })

  test('declares planDelete over project and session and reads its envelope', () => {
    expect(FORGE_RPC.methods.planDelete.input).toEqual({
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', minLength: 1 },
      },
      required: ['projectId', 'sessionId'],
      additionalProperties: false,
    })
    expect(FORGE_RPC.methods.planDelete.output).toEqual({
      type: 'object',
      properties: {
        deleted: { type: 'boolean' },
        error: { type: 'string' },
      },
      additionalProperties: false,
    })
    expect(readForgePlanDeleteOutput({ deleted: true })).toEqual({ deleted: true })
    expect(readForgePlanDeleteOutput({ error: 'Plan not found' })).toEqual({ error: 'Plan not found' })
    expect(readForgePlanDeleteOutput({ deleted: false }))
      .toEqual({ error: 'Forge returned an invalid plan delete result' })
    expect(readForgePlanDeleteOutput(null)).toEqual({ error: 'Forge returned an invalid plan delete result' })
  })

  test('sessionPlan accepts an optional projectId', () => {
    expect(FORGE_RPC.methods.sessionPlan.input.properties.projectId).toEqual({ type: 'string', minLength: 1 })
    expect(FORGE_RPC.methods.sessionPlan.input.required).toEqual(['sessionId'])
    expect(FORGE_RPC.methods.sessionPlan.input.additionalProperties).toBe(false)
  })

  test('readForgeLoopDetail keeps a valid detail and surfaces errors', () => {
    const loop = {
      projectId: 'p1',
      loopName: 'loop-a',
      status: 'running',
      currentSessionId: 'ses_1',
      worktree: false,
      worktreeDir: '/wt',
      projectDir: '/project',
      maxIterations: 5,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      auditorFallbackIndex: 0,
      modelFailed: false,
      sandbox: false,
      startedAt: 100,
      currentSectionIndex: 0,
      totalSections: 1,
    }
    const detail = { loop, sections: [], findings: [], transitions: [], transitionsCapped: false, amendments: [] }
    expect(readForgeLoopDetail(detail)).toEqual(detail)
    expect(readForgeLoopDetail({ ...detail, durationText: '1s', plan: '# Plan' }))
      .toEqual({ ...detail, durationText: '1s', plan: '# Plan' })
    expect(readForgeLoopDetail({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeLoopDetail({ ...detail, transitionsCapped: 'yes' }))
      .toEqual({ error: 'Forge returned an invalid loop detail' })
    expect(readForgeLoopDetail({ ...detail, loop: { ...loop, projectId: 1 } }))
      .toEqual({ error: 'Forge returned an invalid loop detail' })
    expect(readForgeLoopDetail({ ...detail, sections: [{ title: 'no index' }] }))
      .toEqual({ error: 'Forge returned an invalid loop detail' })
    expect(readForgeLoopDetail(null)).toEqual({ error: 'Forge returned an invalid loop detail' })
  })

  test('readForgeProjectFindings keeps grouped findings and surfaces errors', () => {
    const findings = [{
      projectId: 'p1', file: 'src/main.ts', line: 10, severity: 'bug', description: 'broken', createdAt: 1,
    }]
    const result = { loops: [{ loopName: 'loop-a', findings }] }
    expect(readForgeProjectFindings(result)).toEqual(result)
    expect(readForgeProjectFindings({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeProjectFindings({ loops: [{ findings: [] }] }))
      .toEqual({ error: 'Forge returned an invalid project findings' })
    expect(readForgeProjectFindings({ loops: 'none' }))
      .toEqual({ error: 'Forge returned an invalid project findings' })
    expect(readForgeProjectFindings(null)).toEqual({ error: 'Forge returned an invalid project findings' })
  })

  test('readForgeAmendmentDiff keeps a valid diff and surfaces errors', () => {
    const diff = {
      sections: [{
        index: 4,
        change: 'modified',
        title: 'New Section',
        previousTitle: 'Old Section',
        lines: [{ kind: 'add', text: 'new' }, { kind: 'remove', text: 'old' }],
      }],
      summary: { added: 0, removed: 0, modified: 1 },
    }
    expect(readForgeAmendmentDiff(diff)).toEqual(diff)
    expect(readForgeAmendmentDiff({ ...diff, sections: [] }))
      .toEqual({ sections: [], summary: diff.summary })
    expect(readForgeAmendmentDiff({ error: 'no db' })).toEqual({ error: 'no db' })
    expect(readForgeAmendmentDiff({ sections: [], summary: { added: 0 } }))
      .toEqual({ error: 'Forge returned an invalid amendment diff' })
    expect(readForgeAmendmentDiff({ sections: [{ index: 1 }], summary: diff.summary }))
      .toEqual({ error: 'Forge returned an invalid amendment diff' })
    expect(readForgeAmendmentDiff(null)).toEqual({ error: 'Forge returned an invalid amendment diff' })
  })

  test('declares the project-scoped TUI push event schemas keyed by projectId', () => {
    const projectEventSchema = {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    }
    expect(FORGE_RPC.events.loopsChanged.schema).toEqual(projectEventSchema)
    expect(FORGE_RPC.events.plansChanged.schema).toEqual(projectEventSchema)
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

  test('readForgeProjectChangedEvent keeps a projectId and rejects a malformed payload', () => {
    expect(readForgeProjectChangedEvent({ projectId: 'proj_1' })).toEqual({ projectId: 'proj_1' })
    expect(readForgeProjectChangedEvent({})).toBeNull()
    expect(readForgeProjectChangedEvent({ projectId: 1 })).toBeNull()
  })

  test('readForgeAutoApproveChangedEvent keeps a projectId and sessionId, and rejects a partial payload', () => {
    expect(readForgeAutoApproveChangedEvent({ projectId: 'proj_1', sessionId: 'ses_1' }))
      .toEqual({ projectId: 'proj_1', sessionId: 'ses_1' })
    expect(readForgeAutoApproveChangedEvent({ projectId: 'proj_1' })).toBeNull()
    expect(readForgeAutoApproveChangedEvent({ sessionId: 'ses_1' })).toBeNull()
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
    const loopWithBranch = { ...loops[0], branch: 'pm-61-export' }
    expect(readForgeLoops({ loops: [loopWithBranch] })).toEqual({ loops: [loopWithBranch] })
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
