import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import Database from 'better-sqlite3'

import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { createForgeExecutionService } from '../../src/services/execution'
import {
  forgeBridgeFromDispatch,
  registerForgeExecutionBridge,
  unregisterForgeExecutionBridge,
  clearForgeExecutionBridges,
  getForgeExecutionBridge,
} from '../../src/services/execution-bridge'
import { createLogger } from '../../src/utils/logger'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createPendingTeardownRegistry } from '../../src/workspace/pending-teardown'
import { createNoWaitWorkspaceStatusRegistry } from '../helpers/workspace-status-registry'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

import { connectForgeProject, __setCrossProcessNewSessionResolver, type CrossProcessNewSessionResolver } from '../../src/utils/tui-client'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

const PROJECT_ID = 'proj_tui_bridge'
const DIRECTORY = '/tmp/forge-tui-bridge-test-' + Date.now()

describe('TUI plan.execute(mode=new-session) routes through the audited bridge', () => {
  let db: Database
  let dbPath: string

  beforeEach(() => {
    mkdirSync(DIRECTORY, { recursive: true })
    dbPath = join(tmpdir(), `forge-bridge-${randomUUID()}.db`)
    db = new Database(dbPath)
    setupLoopsTestDb(db as unknown as Parameters<typeof setupLoopsTestDb>[0])
    vi.resetModules()
  })

  afterEach(() => {
    db.close()
    clearForgeExecutionBridges()
    __setCrossProcessNewSessionResolver(null)
  })

  test('New session creates one session, no workspace, goal continuation prompt, tracked worktree:false goal loop', async () => {
    const { client: forgeClient, calls: forgeCalls } = createFakeForgeClient()
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, logger, undefined, undefined, sectionPlansRepo)

    const loopHandler = createLoopEventHandler(
      loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, () => ({}), undefined, dbPath, undefined, sectionPlansRepo,
    )

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: DIRECTORY,
      config: { loop: { enabled: true, defaultMaxIterations: 7 } },
      logger,
      dataDir: dbPath,
      client: forgeClient,
      plansRepo,
      loopsRepo,
      loopHandler,
      loop: loopHandler.loop,
      sandboxManager: undefined,
      sectionPlansRepo,
      reviewFindingsRepo,
      workspaceStatusRegistry: createNoWaitWorkspaceStatusRegistry(),
      pendingTeardowns: createPendingTeardownRegistry(),
    })

    const bridge = forgeBridgeFromDispatch(
      (input) => ({
        surface: 'tui' as const,
        projectId: PROJECT_ID,
        directory: DIRECTORY,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      }),
      (ctx, command) => service.dispatch(ctx, command),
    )
    registerForgeExecutionBridge(DIRECTORY, bridge)

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({
            data: { id: PROJECT_ID, worktree: DIRECTORY },
          }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: {
            list: vi.fn().mockResolvedValue({ data: [] }),
            create: vi.fn(),
          },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn(),
        },
      },
      route: {
        navigate: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const client = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe(PROJECT_ID)

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Bridge the new-session launch to audited handler',
      plan: '# Plan\nDo the thing via the bridge',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
      executionVariant: 'bridge-exec-variant',
      auditorVariant: 'bridge-audit-variant',
    })

    expect(result).not.toBeNull()
    expect('error' in result!).toBe(false)
    const ok = result as { sessionId: string; loopName?: string }
    expect(ok.sessionId).toBe('ses_fake_1')
    expect(ok.loopName).toBeTruthy()

    const sessionCreates = forgeCalls.filter((c) => c.method === 'session.create')
    expect(sessionCreates.length).toBe(1)
    const workspaceCreates = forgeCalls.filter((c) => c.method === 'workspace.create')
    const workspaceWarps = forgeCalls.filter((c) => c.method === 'workspace.warp')
    expect(workspaceCreates.length).toBe(0)
    expect(workspaceWarps.length).toBe(0)

    const promptCalls = forgeCalls.filter((c) => c.method === 'session.promptAsync')
    expect(promptCalls.length).toBe(1)
    const promptArgs = promptCalls[0].params as any
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.workspace).toBeUndefined()
    expect(promptArgs.variant).toBe('bridge-exec-variant')
    const promptText = promptArgs.parts?.[0]?.text ?? ''
    expect(promptText).toContain('## Goal')
    expect(promptText).toContain('# Plan\nDo the thing via the bridge')
    expect(promptText).not.toBe('# Plan\nDo the thing via the bridge')

    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    const state = active[0]
    expect(state.kind).toBe('goal')
    expect(state.worktree).toBe(false)
    expect(state.sandbox).toBe(false)
    expect(state.sessionId).toBe('ses_fake_1')
    expect(state.executorSessionId).toBe('ses_fake_1')
    expect(state.workspaceId).toBeUndefined()
    expect(state.worktreeDir).toBe(DIRECTORY)
    expect(state.goal).toContain('# Plan')
    expect(state.phase).toBe('coding')
    expect(state.totalSections).toBe(0)
    expect(state.maxIterations).toBe(7)
    expect(state.hostSessionId).toBe('sess-host')
    expect(state.executionModel).toBe('test/exec')
    expect(state.auditorModel).toBe('test/auditor')
    expect(state.executionVariant).toBe('bridge-exec-variant')
    expect(state.auditorVariant).toBe('bridge-audit-variant')

    const serverSelectCalls = forgeCalls.filter((c) => c.method === 'tui.selectSession')
    expect(serverSelectCalls.length).toBe(0)

    const stored = createLoopsRepo(db).getLarge(PROJECT_ID, state.loopName)
    expect(stored?.goal).toContain('# Plan')

    expect(unregisterForgeExecutionBridge(DIRECTORY)).toBe(true)
  })

  test('a failed bridge launch deletes the orphan session created during attach (no CreatedSession leak)', async () => {
    /**
     * Auditor issue #4: when session creation succeeds but the initial
     * prompt fails inside handlePlanNewSession / attachLoopToSession, the
     * bridge call passes the same `deleteSessionOnPromptFailure` lifecycle
     * the execute-plan tool uses, so the handler deletes the orphan session
     * it created. Without that lifecycle the bridge would return a failure
     * while leaving the dangling session paired with no loop tracking it.
     */
    const { client: forgeClient, calls: forgeCalls } = createFakeForgeClient({
      session: {
        promptAsync: async () => { throw new Error('initial prompt failed') },
      },
    })
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, logger, undefined, undefined, sectionPlansRepo)

    const loopHandler = createLoopEventHandler(
      loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, () => ({}), undefined, dbPath, undefined, sectionPlansRepo,
    )

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: DIRECTORY,
      config: { loop: { enabled: true, defaultMaxIterations: 7 } },
      logger,
      dataDir: dbPath,
      client: forgeClient,
      plansRepo,
      loopsRepo,
      loopHandler,
      loop: loopHandler.loop,
      sandboxManager: undefined,
      sectionPlansRepo,
      reviewFindingsRepo,
      workspaceStatusRegistry: createNoWaitWorkspaceStatusRegistry(),
      pendingTeardowns: createPendingTeardownRegistry(),
    })

    const bridge = forgeBridgeFromDispatch(
      (input) => ({
        surface: 'tui' as const,
        projectId: PROJECT_ID,
        directory: DIRECTORY,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      }),
      (ctx, command) => service.dispatch(ctx, command),
    )
    registerForgeExecutionBridge(DIRECTORY, bridge)

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: { workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() } },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn(),
        },
      },
      route: { navigate: vi.fn() },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const client = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(client).not.toBeNull()

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Bridge prompt-failure cleanup',
      plan: '# Plan\nDo the thing via the bridge',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
    })

    expect(result).not.toBeNull()
    expect('error' in result!).toBe(true)

    // The session that attachLoopToSession created was deleted because the
    // bridge forwards `deleteSessionOnPromptFailure: true`.
    const sessionCreates = forgeCalls.filter((c) => c.method === 'session.create')
    expect(sessionCreates.length).toBe(1)
    const sessionDeletes = forgeCalls.filter((c) => c.method === 'session.delete')
    expect(sessionDeletes.length).toBe(1)
    expect((sessionDeletes[0].params as any).sessionID).toBe('ses_fake_1')

    // No active loop paired with the failed launch.
    expect(loopService.listActive().length).toBe(0)
  })

  /**
   * Cross-process fixtures: a TUI process with NO in-process bridge (the server
   * plugin lives in a separate `opencode serve` process). The panel still has
   * to reach `plan.execute.newSession`, so it queues a `promptAsync` on the
   * host session's code agent asking it to invoke the `execute-plan` tool with
   * `mode='new-session'`, then awaits the cross-process resolver before
   * reporting success. The resolver is the seam (`__setCrossProcessNewSessionResolver`)
   * so each scenario below asserts authoritative handling without driving a
   * real server plugin in flight:
   *
   *   1. handler success (audited loop created) → returns the loop's executor
   *      session id + loop name
   *   2. handler failure (server-side dispatch errored) → returns null so the
   *      panel surfaces an explicit failure (never reports success off the
   *      queued prompt alone)
   *   3. ignored tool invocation (host agent never called `execute-plan`) →
   *      resolver times out → null
   *   4. one-shot fallback (server fell back because loops were disabled / no
   *      commit) → resolver observes the new session and returns just the
   *      session id (no loop name)
   */
  function buildCrossProcessMockApi(opts?: { serverBaseUrl?: string }): any {
    const api: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: { workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() } },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
    }
    // The cross-process gate inspects the TUI's legacy hey-api client for a
    // loopback `baseUrl` to decide whether the default Forge database is
    // shared between TUI and server. Inject the seam (the same private
    // `_client.getConfig()` accessor the SDK adapter relies on) so the gate
    // resolves locality explicitly per-test instead of guessing from a missing
    // entry. Omitting `serverBaseUrl` leaves the seam absent → the gate treats
    // the server as remote/non-shared (the conservative default).
    if (opts?.serverBaseUrl !== undefined) {
      api.client._client = { getConfig: () => ({ baseUrl: opts.serverBaseUrl }) }
    }
    return api
  }

  function makeReachableDataDir(): string {
    const dir = join(tmpdir(), `forge-tui-bridge-datadir-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    // The cross-process dispatch gate only checks `existsSync(<dataDir>/forge.db)`,
    // not schema viability — the resolver is stubbed per-test so it never opens
    // this file. Touch it so the gate passes.
    writeFileSync(join(dir, 'forge.db'), '')
    return dir
  }

  async function exerciseCrossProcess(resolver: CrossProcessNewSessionResolver) {
    __setCrossProcessNewSessionResolver(resolver)
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const mockApi = buildCrossProcessMockApi()
    // The cross-process dispatch gate refuses without an explicit Forge
    // dataDir (the default Forge DB cannot be guaranteed shared between a
    // separate TUI/server runtime). Provide a reachable synthetic dataDir
    // whose forge.db exists so dispatch can proceed; the resolver stub
    // bypasses real DB reads of this file.
    const reachableDataDir = makeReachableDataDir()
    const client = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe(PROJECT_ID)
    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Cross-process new session launch',
      plan: '# Plan\nDo the thing cross-process',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
      executionVariant: 'cross-exec-variant',
      auditorVariant: 'cross-audit-variant',
    })
    rmSync(reachableDataDir, { recursive: true, force: true })
    return { result, mockApi }
  }

  test('cross-process: handler success returns the actual loop session id + name (not the host session)', async () => {
    const { result } = await exerciseCrossProcess(async () => ({ sessionId: 'loop-executor-session', loopName: 'cross-loop' }))
    expect('error' in result!).toBe(false)
    const ok = result as { sessionId: string; loopName?: string }
    expect(ok.sessionId).toBe('loop-executor-session')
    expect(ok.loopName).toBe('cross-loop')
  })

  test('cross-process: handler failure surfaces an explicit failure (no speculative success)', async () => {
    const { result, mockApi } = await exerciseCrossProcess(async () => null)
    expect(result).toBeNull()
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()
    // The host session was still prompted to drive the execute-plan tool — the
    // failure is authoritative absence of confirmation, not a queued-prompt
    // success.
    expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
    const promptArgs = mockApi.client.session.promptAsync.mock.calls[0][0] as any
    expect(promptArgs.sessionID).toBe('sess-host')
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.variant).toBe('cross-exec-variant')
    const promptText = promptArgs.parts?.[0]?.text ?? ''
    expect(promptText).toContain('execute-plan')
    expect(promptText).toContain('new-session')
    expect(promptText).toContain('"test/exec"')
    expect(promptText).toContain('"test/auditor"')
    expect(promptText).toContain('"cross-exec-variant"')
    expect(promptText).toContain('"cross-audit-variant"')
  })

  test('cross-process: ignored tool invocation surfaces a failure (resolver observes no loop row)', async () => {
    const { result, mockApi } = await exerciseCrossProcess(async () => null)
    expect(result).toBeNull()
    expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
  })

  test('cross-process: one-shot fallback returns the new session id with no loop name', async () => {
    const { result } = await exerciseCrossProcess(async () => ({ sessionId: 'one-shot-session' }))
    expect(result).not.toBeNull()
    expect('error' in result!).toBe(false)
    const ok = result as { sessionId: string; loopName?: string }
    expect(ok.sessionId).toBe('one-shot-session')
    expect(ok.loopName).toBeUndefined()
  })

  test('cross-process host instruction relays the actual tool result without pre-classifying audited vs one-shot', async () => {
    /**
     * Auditor issue #5: the cross-process instruction used to tell the host
     * to "confirm to the user that the audited session has been launched"
     * even when execution took the intentional one-shot fallback (loops
     * disabled or global project). The host must instead relay the actual
     * tool output verbatim — the execute-plan tool output itself
     * distinguishes "Goal loop activated!" (audited) from "New session
     * started (one-shot fallback)" — so the user is never told an audited
     * loop exists when only a fallback session was created.
     */
    __setCrossProcessNewSessionResolver((async () => ({
      sessionId: 'either-path-session',
      loopName: undefined,
    })) as CrossProcessNewSessionResolver)
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const mockApi = buildCrossProcessMockApi()
    const reachableDataDir = makeReachableDataDir()
    try {
      const client = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
      expect(client).not.toBeNull()
      await client!.plan.execute('sess-host', {
        mode: 'new-session',
        title: 'Cross-process wording',
        plan: '# Plan\nDo the thing cross-process',
        executionModel: 'test/exec',
        auditorModel: 'test/auditor',
        executionVariant: 'cross-exec-variant',
        auditorVariant: 'cross-audit-variant',
      })

      expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
      const promptText = (mockApi.client.session.promptAsync.mock.calls[0][0] as any).parts?.[0]?.text ?? ''

      // Drives the server-side tool, not a self-description of audited/loop.
      expect(promptText).toContain('execute-plan')
      expect(promptText).toContain('new-session')

      // The instruction NEVER pre-classifies the launch as audited.
      expect(promptText).not.toContain('audited session has been launched')
      expect(promptText).not.toContain('audited "New session"')

      // The host relays the actual tool output verbatim and is told not to
      // describe the result itself.
      expect(promptText).toMatch(/report its output.*verbatim/i)
      expect(promptText).toMatch(/do not pre-classify/i)
    } finally {
      rmSync(reachableDataDir, { recursive: true, force: true })
    }
  })

  test('cross-process: unresolved Forge project scope refuses to dispatch a host instruction (no speculative success)', async () => {
    /**
     * Auditor bug 3: when project discovery fails (no `projectId`), the
     * cross-process resolver cannot look up the outcome row keyed by
     * (project_id, request_nonce). The prior implementation still queued a
     * `promptAsync` host instruction, then reported an uncertain failure
     * after the resolver timed out — a success on the server would be reported
     * as a failure and could not be fenced against a retry. The cross-process
     * branch now refuses to dispatch anything before queuing a host
     * instruction; the panel surfaces a deterministic error instead.
     */
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: undefined }),
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
        experimental: { workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() } },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
    }
    const client = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe('')

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Unresolved project scope',
      plan: '# Plan\nProject discovery failed',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
    })

    // Deterministic error — never null/timeout, never success.
    expect(result).not.toBeNull()
    if (result && 'error' in result) {
      expect(result.error.length).toBeGreaterThan(0)
    }

    // ZERO dispatches: router-category promptAsync (the host instruction), the
    // downstream session.create, and the workspace.create are all untouched.
    expect(mockApi.client.session.promptAsync).not.toHaveBeenCalled()
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()
  })

  test('cross-process: configured dataDir whose forge.db is unreachable refuses to dispatch (non-shared-storage deployment)', async () => {
    /**
     * Auditor bug 4: the documented cross-process path opened the TUI's local
     * SQLite database. When the server runs on a separate machine/container
     * without a shared filesystem, the configured `dataDir` does not point at a
     * `forge.db` the TUI can read — so the resolver would never observe the
     * server's committed outcome for a successful launch and the panel would
     * eventually report phantom failure. Without a server-accessible
     * confirmation transport, the only safe behavior is to reject the
     * unsupported non-shared-storage deployment BEFORE dispatch.
     */
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const mockApi = buildCrossProcessMockApi()
    const unreachableDataDir = '/nonexistent-forge-data-' + randomUUID().replace(/-/g, '')

    // connectForgeProject's project discovery resolves projectId fine — bypass
    // bug 3 so we can isolate bug 4 (configured database not locally reachable).
    const client = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: unreachableDataDir })
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe(PROJECT_ID)

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Non-shared storage',
      plan: '# Plan\nRemote TUI without shared filesystem',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
    })

    expect(result).not.toBeNull()
    expect(result).toHaveProperty('error')
    if (result && 'error' in result) {
      expect(result.error).toContain('not reachable')
      expect(result.error).toContain(unreachableDataDir)
    }

    // ZERO dispatches: the host instruction, the downstream session.create, and
    // workspace.create were never queued — the panel rejected before dispatch.
    expect(mockApi.client.session.promptAsync).not.toHaveBeenCalled()
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()
  })

  test('cross-process: default dataDir on a known remote (non-loopback) server refuses to dispatch (non-shared-storage deployment)', async () => {
    /**
     * Auditor bug 4 (default-dataDir variant): the prior cross-process gate
     * only rejected when an explicit `dataDir` was configured AND
     * `<dataDir>/forge.db` could not be reached locally. With NO explicit
     * `dataDir` configured, the panel assumed the default Forge database is
     * shared between TUI and server. A runtime where the server lives on a
     * separate machine/container (no in-process bridge) cannot satisfy that
     * assumption — the TUI's own local default `forge.db` always exists, so an
     * `existsSync` check cannot distinguish "co-located shared" from "remote
     * separate". The cross-process path now refuses the unsupported no-bridge,
     * no-dataDir, non-loopback deployment BEFORE dispatch and surfaces a
     * deterministic error demanding an explicit shared `dataDir` or a bridge
     * deployment. Locality is read from the connected opencode server's base
     * URL: a non-loopback host is treated as remote/non-shared.
     */
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    // Non-loopback server base URL → the gate treats the default Forge
    // database as NOT shared with this TUI process and refuses dispatch.
    const mockApi = buildCrossProcessMockApi({ serverBaseUrl: 'http://10.20.30.40:1357' })
    // No `dataDir` pluginConfig → the cross-process resolver falls back to the
    // default Forge data directory, which cannot be guaranteed shared.
    const client = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe(PROJECT_ID)

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Default dataDir, remote server runtime',
      plan: '# Plan\nRemote TUI without explicit shared storage',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
    })

    expect(result).not.toBeNull()
    expect(result).toHaveProperty('error')
    if (result && 'error' in result) {
      expect(result.error).toContain('no Forge dataDir is configured')
      expect(result.error).toContain('in-process bridge deployment')
    }

    // ZERO dispatches: the host instruction, the downstream session.create, and
    // workspace.create were never queued — the panel rejected before dispatch.
    expect(mockApi.client.session.promptAsync).not.toHaveBeenCalled()
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()
  })

  test('cross-process: default dataDir on a loopback (local split-process) server dispatches and resolves without an explicit dataDir', async () => {
    /**
     * Auditor bug 4 follow-up: the cross-process gate rejected ALL no-bridge,
     * no-explicit-dataDir launches — including the standard local split
     * process (`opencode serve` + TUI on the same machine). When the connected
     * opencode server's base URL is loopback, the TUI and server share the
     * same machine and therefore the same default Forge data directory; the
     * `loop_new_session_outcomes` row the handler writes is directly readable
     * by the panel. The gate now permits dispatch on a loopback server WITHOUT
     * an explicit `dataDir`, falling back to the default Forge database.
     */
    __setCrossProcessNewSessionResolver((async () => ({
      sessionId: 'local-split-session',
      loopName: 'local-split-loop',
    })) as CrossProcessNewSessionResolver)
    expect(getForgeExecutionBridge(DIRECTORY)).toBeUndefined()
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    // Loopback server base URL → the gate permits the default Forge database
    // as the shared store. No explicit `dataDir` pluginConfig is supplied.
    const mockApi = buildCrossProcessMockApi({ serverBaseUrl: 'http://localhost:4040' })
    const client = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(client).not.toBeNull()
    expect(client!.projectId).toBe(PROJECT_ID)

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Default dataDir, local split-process server',
      plan: '# Plan\nLocal TUI + opencode serve on the same machine',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
      executionVariant: 'local-exec-variant',
      auditorVariant: 'local-audit-variant',
    })

    expect(result).not.toBeNull()
    expect('error' in result!).toBe(false)
    const ok = result as { sessionId: string; loopName?: string }
    expect(ok.sessionId).toBe('local-split-session')
    expect(ok.loopName).toBe('local-split-loop')

    // Dispatched exactly one host instruction driving the server-side tool.
    expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
    const promptArgs = mockApi.client.session.promptAsync.mock.calls[0][0] as any
    expect(promptArgs.sessionID).toBe('sess-host')
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.variant).toBe('local-exec-variant')
  })
})