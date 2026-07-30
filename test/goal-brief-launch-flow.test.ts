import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { Database as Sqlite } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createGoalAuthoringTools } from '../src/tools/goal-authoring'
import type { ToolContext } from '../src/tools/types'
import { createGoalBriefsRepo } from '../src/storage/repos/goal-briefs-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import { createLoopService } from '../src/loop/service'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLogger } from '../src/utils/logger'
import { connectForgeProject } from '../src/utils/tui-client'
import { fetchStoredSessionLaunchSpec } from '../src/utils/tui-loop-store'
import { createForgeSessionAttachHook } from '../src/hooks/forge-session-attach'
import type { ForgeLoopExtra } from '../src/services/execution'
import { createFakeForgeClient } from './helpers/fake-client'
import { setupLoopsTestDb } from './helpers/loops-test-db'
import { createPendingTeardownRegistry } from '../src/workspace/pending-teardown'
import { createNoWaitWorkspaceStatusRegistry } from './helpers/workspace-status-registry'

const PROJECT_ID = 'goal-brief-launch-project'
const HOST_SESSION_ID = 'host-source-session'
const TEST_DIR = '/tmp/opencode-goal-brief-launch-test-' + Date.now()
const WS_ID = 'ws_loop'
const SESS_ID = 'sess_new'
const WT_DIR = '/tmp/wt/loop'

const ACCEPTANCE_LINE = '- uploader retries three times before failing'

function describeBrief() {
  return `## Goal
Ship the upload retry feature end to end.

## Context
Uploads fail silently today and users want a clear failure signal.

## Constraints
No new dependencies.

## Acceptance Criteria
${ACCEPTANCE_LINE}
- a single retry-exhausted event is logged
`
}

function describeBriefWithPlanStructure() {
  return `${describeBrief()}\n## Phase 1: Setup\n- scaffold the retry module\n`
}

describe('end-to-end goal-brief launch flow', () => {
  let db: Database
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'goal-brief-launch-test-'))
    dbPath = join(tempDir, 'forge.db')
    db = new Sqlite(dbPath)
    setupLoopsTestDb(db)
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
  })

  afterEach(() => {
    try { db.close() } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
    delete process.env.FORGE_TUI_WORKSPACE_SETTLE_MS
  })

  function buildRepos() {
    return {
      loopsRepo: createLoopsRepo(db),
      plansRepo: createPlansRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      goalBriefsRepo: createGoalBriefsRepo(db),
      sectionPlansRepo: createSectionPlansRepo(db),
    }
  }

  function buildGoalWriteTools(repos: ReturnType<typeof buildRepos>) {
    const loopService = createLoopService(
      repos.loopsRepo,
      repos.plansRepo,
      repos.reviewFindingsRepo,
      PROJECT_ID,
      createLogger({ enabled: false, file: '' }),
    )
    const ctx = {
      goalBriefsRepo: repos.goalBriefsRepo,
      plansRepo: repos.plansRepo,
      loopsRepo: repos.loopsRepo,
      reviewFindingsRepo: repos.reviewFindingsRepo,
      projectId: PROJECT_ID,
      logger: createLogger({ enabled: false, file: '' }),
      loop: { service: loopService },
      directory: TEST_DIR,
    } as unknown as ToolContext
    return createGoalAuthoringTools(ctx)
  }

  function buildMockApi(createdWorkspaces: Array<Record<string, unknown>>) {
    return {
      client: {
        project: {
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: TEST_DIR }] }),
        },
        experimental: {
          workspace: {
            list: vi.fn().mockResolvedValue({ data: createdWorkspaces }),
            remove: vi.fn().mockResolvedValue({ data: {} }),
            create: vi.fn().mockImplementation(async (args: any) => {
              createdWorkspaces.push({
                id: WS_ID,
                type: 'forge',
                directory: WT_DIR,
                extra: args.extra,
              })
              return { data: { id: WS_ID, directory: WT_DIR, branch: null } }
            }),
            syncList: vi.fn().mockResolvedValue(undefined),
            status: vi.fn().mockResolvedValue({ data: [{ workspaceID: WS_ID, status: 'connected' }] }),
          },
        },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: SESS_ID } }),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
        tui: {
          selectSession: vi.fn().mockResolvedValue(undefined),
        },
      },
      route: {
        navigate: vi.fn(),
      },
    }
  }

  test('brief written by goal-write resolves, launches, attaches, and surfaces in the audit prompt', async () => {
    const repos = buildRepos()
    const tools = buildGoalWriteTools(repos)

    const writeResult = await tools['goal-write'].execute(
      { content: describeBrief() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    expect(writeResult).toMatch(/^Goal brief stored:/)

    const spec = fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)
    expect(spec).not.toBeNull()
    expect(spec!.kind).toBe('goal')
    expect(spec!.text).toContain(ACCEPTANCE_LINE)

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)

    const project = await connectForgeProject(mockApi as any, TEST_DIR, [], dbPath)
    expect(project).not.toBeNull()

    const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
      mode: 'loop',
      title: 'Ship the upload retry feature',
      loopName: 'upload-retry-loop',
      spec: spec!,
      executionModel: 'anthropic/model-a',
      auditorModel: 'anthropic/model-b',
      executionVariant: 'thinking-max',
      auditorVariant: 'thinking-min',
    })
    if (launchResult === null || 'error' in launchResult) {
      throw new Error(`plan.execute failed: ${launchResult === null ? 'null' : launchResult.error}`)
    }

    expect(launchResult.sessionId).toBe(SESS_ID)
    expect(launchResult.workspaceId).toBe(WS_ID)
    expect(launchResult.loopName).toBe('upload-retry-loop')

    const createArgs = (mockApi.client.experimental.workspace.create as any).mock.calls[0][0]
    const forgeLoop = createArgs.extra.forgeLoop as ForgeLoopExtra
    expect(forgeLoop.kind).toBe('goal')
    expect(forgeLoop.goal).toContain(ACCEPTANCE_LINE)
    expect(forgeLoop.executionModel).toBe('anthropic/model-a')
    expect(forgeLoop.auditorModel).toBe('anthropic/model-b')
    expect(forgeLoop.initialPromptOwner).toBe('server')
    expect(forgeLoop.planSource).toBeUndefined()
    expect(forgeLoop.planText).toBeUndefined()
    // No plugin config passed → policy resolves maxIterations to 0 (unbounded).
    expect(forgeLoop.maxIterations).toBe(0)

    expect((mockApi.client.session.promptAsync as any).mock.calls.length).toBe(0)

    const logger = createLogger({ enabled: false, file: '' })
    const loopService = createLoopService(
      repos.loopsRepo,
      repos.plansRepo,
      repos.reviewFindingsRepo,
      PROJECT_ID,
      logger,
    )
    const loopHandler = createLoopEventHandler(
      repos.loopsRepo,
      repos.plansRepo,
      repos.reviewFindingsRepo,
      PROJECT_ID,
      createFakeForgeClient().client,
      logger,
      () => ({}),
      undefined,
      dbPath,
    )

    const { client: hookClient, calls: hookCalls } = createFakeForgeClient({
      workspace: {
        list: async () => createdWorkspaces as any,
      },
    } as any)

    const hook = createForgeSessionAttachHook({
      client: hookClient,
      execDeps: {
        projectId: PROJECT_ID,
        directory: TEST_DIR,
        config: {},
        logger,
        dataDir: dbPath,
        client: hookClient,
        plansRepo: repos.plansRepo,
        loopsRepo: repos.loopsRepo,
        loopHandler,
        loop: loopHandler.loop,
        sandboxManager: undefined,
        sectionPlansRepo: repos.sectionPlansRepo,
        reviewFindingsRepo: repos.reviewFindingsRepo,
        workspaceStatusRegistry: createNoWaitWorkspaceStatusRegistry(),
        pendingTeardowns: createPendingTeardownRegistry(),
      } as any,
      projectId: PROJECT_ID,
      directory: TEST_DIR,
      logger,
    })

    await hook({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: launchResult.sessionId,
            workspaceID: launchResult.workspaceId,
            directory: WT_DIR,
            projectID: PROJECT_ID,
          },
        },
      },
    })

    const state = loopService.getActiveState(launchResult.loopName)
    expect(state).not.toBeNull()
    expect(state!.kind).toBe('goal')
    expect(state!.goal).toContain(ACCEPTANCE_LINE)
    expect(state!.totalSections).toBe(0)
    expect(state!.executorSessionId).toBe(launchResult.sessionId)
    expect(state!.sessionId).toBe(launchResult.sessionId)
    expect(repos.plansRepo.getForLoop(PROJECT_ID, launchResult.loopName)).toBeNull()

    const promptCalls = hookCalls.filter((c) => c.method === 'session.promptAsync')
    expect(promptCalls.length).toBe(1)
    expect(promptCalls[0].params).toMatchObject({
      sessionID: launchResult.sessionId,
      model: { providerID: 'anthropic', modelID: 'model-a' },
      variant: 'thinking-max',
    })

    const auditPrompt = loopService.buildAuditPrompt(state!)
    expect(auditPrompt).toContain(ACCEPTANCE_LINE)
  })

  test('a brief carrying a Phase heading is rejected by goal-write, yields no launch spec, and cannot reach the loop launcher', async () => {
    const repos = buildRepos()
    const tools = buildGoalWriteTools(repos)

    const writeResult = await tools['goal-write'].execute(
      { content: describeBriefWithPlanStructure() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    expect(writeResult).toMatch(/^goal-write failed:/)
    expect(repos.goalBriefsRepo.getForSession(PROJECT_ID, HOST_SESSION_ID)).toBeNull()

    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)).toBeNull()

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)
    const project = await connectForgeProject(mockApi as any, TEST_DIR, [], dbPath)
    expect(project).not.toBeNull()

    const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
      mode: 'loop',
      title: 'Rejected brief',
      loopName: 'rejected-brief-loop',
      spec: null as unknown as { kind: 'plan'; text: string; updatedAt: number },
    })
    expect(launchResult).toEqual({ error: 'No plan or goal spec was provided for execution.' })
    expect((mockApi.client.experimental.workspace.create as any).mock.calls.length).toBe(0)
    expect((mockApi.client.session.create as any).mock.calls.length).toBe(0)
  })

  test('loop.enabled === false rejects the launch before provisioning any workspace', async () => {
    const repos = buildRepos()
    const tools = buildGoalWriteTools(repos)
    await tools['goal-write'].execute(
      { content: describeBrief() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    const spec = fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)
    expect(spec!.kind).toBe('goal')

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)

    const project = await connectForgeProject(
      mockApi as any,
      TEST_DIR,
      [],
      dbPath,
      { loop: { enabled: false } } as any,
      false,
    )
    expect(project).not.toBeNull()

    const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
      mode: 'loop',
      title: 'Disabled goal',
      loopName: 'disabled-goal-loop',
      spec: spec!,
    })
    expect(launchResult).toEqual({ error: 'Loops are disabled in plugin config' })
    expect((mockApi.client.experimental.workspace.create as any).mock.calls.length).toBe(0)
    expect((mockApi.client.session.create as any).mock.calls.length).toBe(0)
  })

  test('pluginConfig.loop.defaultMaxIterations is stamped onto the forgeLoop envelope', async () => {
    const repos = buildRepos()
    const tools = buildGoalWriteTools(repos)
    await tools['goal-write'].execute(
      { content: describeBrief() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    const spec = fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)

    const project = await connectForgeProject(
      mockApi as any,
      TEST_DIR,
      [],
      dbPath,
      { loop: { defaultMaxIterations: 7 } } as any,
      false,
    )
    expect(project).not.toBeNull()

    const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
      mode: 'loop',
      title: 'Capped goal',
      loopName: 'capped-goal-loop',
      spec: spec!,
    })
    if (launchResult === null || 'error' in launchResult) {
      throw new Error(`plan.execute failed: ${launchResult === null ? 'null' : launchResult.error}`)
    }

    const createArgs = (mockApi.client.experimental.workspace.create as any).mock.calls[0][0]
    const forgeLoop = createArgs.extra.forgeLoop as ForgeLoopExtra
    expect(forgeLoop.maxIterations).toBe(7)
  })

  test('awaitAttachAck times out when the attach hook never writes a loop row', async () => {
    const tools = buildGoalWriteTools(buildRepos())
    await tools['goal-write'].execute(
      { content: describeBrief() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    const spec = fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)

    const project = await connectForgeProject(
      mockApi as any,
      TEST_DIR,
      [],
      dbPath,
      undefined,
      true,
    )
    expect(project).not.toBeNull()

    process.env.FORGE_TUI_ATTACH_ACK_TIMEOUT_MS = '200'
    process.env.FORGE_TUI_ATTACH_ACK_POLL_MS = '50'
    try {
      const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
        mode: 'loop',
        title: 'Unacked goal',
        loopName: 'unacked-goal-loop',
        spec: spec!,
      })
      expect(launchResult).not.toBeNull()
      expect('error' in launchResult && launchResult.error).toMatch(/loop row not observed within 200ms/)
    } finally {
      delete process.env.FORGE_TUI_ATTACH_ACK_TIMEOUT_MS
      delete process.env.FORGE_TUI_ATTACH_ACK_POLL_MS
    }
  })

  test('awaitAttachAck succeeds when the attach path writes a running loop row mid-wait', async () => {
    const repos = buildRepos()
    const tools = buildGoalWriteTools(repos)
    await tools['goal-write'].execute(
      { content: describeBrief() },
      { sessionID: HOST_SESSION_ID } as any,
    )
    const spec = fetchStoredSessionLaunchSpec(PROJECT_ID, HOST_SESSION_ID, dbPath)

    const createdWorkspaces: Array<Record<string, unknown>> = []
    const mockApi = buildMockApi(createdWorkspaces)

    const project = await connectForgeProject(
      mockApi as any,
      TEST_DIR,
      [],
      dbPath,
      undefined,
      true,
    )
    expect(project).not.toBeNull()

    process.env.FORGE_TUI_ATTACH_ACK_TIMEOUT_MS = '5000'
    process.env.FORGE_TUI_ATTACH_ACK_POLL_MS = '20'
    try {
      // Simulate the server attach hook writing the loop row shortly after
      // the workspace/session are provisioned. The poll resolves ok once the
      // running row is visible in the shared forge database.
      const insert = () => repos.loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'acked-goal-loop',
        status: 'running',
        currentSessionId: SESS_ID,
        worktree: false,
        worktreeDir: WT_DIR,
        worktreeBranch: null,
        projectDir: TEST_DIR,
        maxIterations: 0,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: WS_ID,
        hostSessionId: HOST_SESSION_ID,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
        kind: 'goal',
        executionVariant: null,
        auditorVariant: null,
      }, { lastAuditResult: null, goal: spec!.text })
      setTimeout(insert, 30)

      const launchResult = await project!.plan.execute(HOST_SESSION_ID, {
        mode: 'loop',
        title: 'Acked goal',
        loopName: 'acked-goal-loop',
        spec: spec!,
      })
      if (launchResult === null || 'error' in launchResult) {
        throw new Error(`plan.execute failed: ${launchResult === null ? 'null' : launchResult.error}`)
      }
      expect(launchResult.loopName).toBe('acked-goal-loop')
    } finally {
      delete process.env.FORGE_TUI_ATTACH_ACK_TIMEOUT_MS
      delete process.env.FORGE_TUI_ATTACH_ACK_POLL_MS
    }
  })
})
