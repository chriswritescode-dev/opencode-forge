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
} from '../../src/services/execution-bridge'
import { createLogger } from '../../src/utils/logger'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createPendingTeardownRegistry } from '../../src/workspace/pending-teardown'
import { createNoWaitWorkspaceStatusRegistry } from '../helpers/workspace-status-registry'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

import { connectForgeProject } from '../../src/utils/tui-client'
import { runPlanLaunch, resolveApiExecutionMode } from '../../src/tui/execute-plan-launch'
import { __setCrossProcessNewSessionResolver, type CrossProcessNewSessionResolver } from '../../src/utils/tui-client'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

const PROJECT_ID = 'proj_panel_new_session'
const DIRECTORY = '/tmp/forge-panel-new-session-' + Date.now()

/**
 * Exercises ExecutePlanPanel's launch path (the extracted `runPlanLaunch`)
 * by selecting "New session" and proving it routes through the audited
 * bridge instead of duplicating goal-loop logic on the TUI side.
 */
describe('ExecutePlanPanel: New session routes through the audited bridge', () => {
  let db: Database
  let dbPath: string

  beforeEach(() => {
    mkdirSync(DIRECTORY, { recursive: true })
    dbPath = join(tmpdir(), `forge-panel-${randomUUID()}.db`)
    db = new Database(dbPath)
    setupLoopsTestDb(db as unknown as Parameters<typeof setupLoopsTestDb>[0])
    vi.resetModules()
  })

  afterEach(() => {
    db.close()
    clearForgeExecutionBridges()
    __setCrossProcessNewSessionResolver(null)
  })

  /** The cross-process dispatch gate refuses without an explicit Forge dataDir
   *  (its absence means the default Forge DB may not be shared between the
   *  TUI's separate runtime and the server's). Provide a reachable synthetic
   *  dataDir so dispatch can proceed; the resolver stub bypasses real DB
   *  reads of this file. Returned so each test can clean it up. */
  function makeReachableDataDir(): string {
    const dir = join(tmpdir(), `forge-panel-datadir-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'forge.db'), '')
    return dir
  }

  test('selecting "New session" dispatches plan.execute.newSession via the bridge with no workspace provisioning', async () => {
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

    const dispatchSpy = vi.fn(
      (ctx: unknown, command: unknown) => service.dispatch(ctx as never, command as never),
    )
    const bridge = forgeBridgeFromDispatch(
      (input) => ({
        surface: 'tui' as const,
        projectId: PROJECT_ID,
        directory: DIRECTORY,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      }),
      dispatchSpy,
    )
    registerForgeExecutionBridge(DIRECTORY, bridge)

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn(),
        },
      },
      route: { navigate: vi.fn() },
      ui: {
        dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() },
        toast: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(projectClient).not.toBeNull()

    expect(resolveApiExecutionMode('New session')).toBe('new-session')

    await runPlanLaunch(
      {
        api: mockApi as never,
        client: projectClient!,
        cache: null,
        pluginConfig: { loop: { enabled: true } } as never,
        logger,
        sessionId: 'sess-host',
        projectDirectory: DIRECTORY,
        planContent: '# Plan\nDo the thing via the panel',
        loopName: 'panel-new-session',
      },
      {
        mode: 'New session',
        target: 'local',
        execModel: 'test/exec',
        auditModel: 'test/auditor',
        execVariant: 'panel-exec-variant',
        auditVariant: 'panel-audit-variant',
      },
    )

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const dispatchedCommand = dispatchSpy.mock.calls[0][1] as { type: string }
    expect(dispatchedCommand.type).toBe('plan.execute.newSession')

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
    expect(promptArgs.variant).toBe('panel-exec-variant')
    const promptText = promptArgs.parts?.[0]?.text ?? ''
    expect(promptText).toContain('## Goal')
    expect(promptText).toContain('# Plan\nDo the thing via the panel')
    expect(promptText).not.toBe('# Plan\nDo the thing via the panel')

    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()

    const sessionNavigations = mockApi.route.navigate.mock.calls.filter((c: unknown[]) => c[0] === 'session')
    expect(sessionNavigations.length).toBe(1)
    expect(sessionNavigations[0][1]).toEqual({ sessionID: 'ses_fake_1' })
    const serverSelectCalls = forgeCalls.filter((c) => c.method === 'tui.selectSession')
    expect(serverSelectCalls.length).toBe(0)

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    const state = active[0]
    expect(state.kind).toBe('goal')
    expect(state.worktree).toBe(false)
    expect(state.sandbox).toBe(false)
    expect(state.workspaceId).toBeUndefined()
    expect(state.worktreeDir).toBe(DIRECTORY)
    expect(state.maxIterations).toBe(7)
    expect(state.hostSessionId).toBe('sess-host')
    expect(state.executionModel).toBe('test/exec')
    expect(state.auditorModel).toBe('test/auditor')
    expect(state.executionVariant).toBe('panel-exec-variant')
    expect(state.auditorVariant).toBe('panel-audit-variant')

    expect(unregisterForgeExecutionBridge(DIRECTORY, () => Promise.resolve({ ok: false, errorCode: 'x', message: '' }))).toBe(false)
    expect(unregisterForgeExecutionBridge(DIRECTORY, bridge)).toBe(true)
    expect(unregisterForgeExecutionBridge(DIRECTORY)).toBe(false)
  })

  test('with no bridge registered (separate TUI/server runtimes), the panel awaits authoritative confirmation before reporting success', async () => {
    /**
     * Models a TUI process with no in-process bridge (separate opencode serve
     * process). The panel must still reach `plan.execute.newSession`, so it
     * prompts the host session's code agent to invoke the `execute-plan` tool.
     * The cross-process resolver is stubbed (via `__setCrossProcessNewSessionResolver`)
     * to simulate the server-side handler completing authoritatively: it
     * returns the loop's executor session id + loop name, and the panel reports
     * success / navigates to that session — never relying on the queued
     * `promptAsync` alone.
     */
    const authoritativeLoopName = 'panel-cross-process-loop'
    const authoritativeSessionId = 'panel-cross-session'
    __setCrossProcessNewSessionResolver(
      (async () => ({ loopName: authoritativeLoopName, sessionId: authoritativeSessionId })) as CrossProcessNewSessionResolver,
    )

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
      ui: {
        dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() },
        toast: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const reachableDataDir = makeReachableDataDir()
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
    try {
      expect(projectClient).not.toBeNull()

      await runPlanLaunch(
        {
          api: mockApi as never,
          client: projectClient!,
          cache: null,
          pluginConfig: { loop: { enabled: true } } as never,
          logger: createLogger({ enabled: false, file: '' }),
          sessionId: 'sess-host',
          projectDirectory: DIRECTORY,
          planContent: '# Plan\nDo the thing cross-process via the panel',
          loopName: 'panel-cross-process',
        },
        {
          mode: 'New session',
          target: 'local',
          execModel: 'test/exec',
          auditModel: 'test/auditor',
          execVariant: 'panel-exec-variant',
          auditVariant: 'panel-audit-variant',
        },
      )

      // No standalone session created; no workspace operations.
      expect(mockApi.client.session.create).not.toHaveBeenCalled()
      expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()

      // Host session was called (no bridge) to dispatch execute-plan.
      expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
      const promptArgs = mockApi.client.session.promptAsync.mock.calls[0][0] as any
      expect(promptArgs.sessionID).toBe('sess-host')
      expect(promptArgs.agent).toBe('code')
      expect(promptArgs.variant).toBe('panel-exec-variant')
      const promptText = promptArgs.parts?.[0]?.text ?? ''
      expect(promptText).toContain('execute-plan')
      expect(promptText).toContain('new-session')

      // Authoritative success toast fires (not the failure toast), and the
      // panel navigates to the loop session the resolver reported — neither the
      // host session nor a speculative id.
      const successToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'success')
      expect(successToasts.length).toBe(1)
      expect(successToasts[0][0]?.message).toBe(`Loop started: ${authoritativeLoopName}`)
      const errorToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'error')
      expect(errorToasts.length).toBe(0)
      const sessionNavigations = mockApi.route.navigate.mock.calls.filter((c: any[]) => c[0] === 'session')
      expect(sessionNavigations.length).toBe(1)
      expect(sessionNavigations[0][1]).toEqual({ sessionID: authoritativeSessionId })
    } finally {
      rmSync(reachableDataDir, { recursive: true, force: true })
    }
  })

  test('with no bridge registered, handler failure surfaces an error toast (no speculative success)', async () => {
    __setCrossProcessNewSessionResolver((async () => null) as CrossProcessNewSessionResolver)

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
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
      ui: {
        dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() },
        toast: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const reachableDataDir = makeReachableDataDir()
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
    try {
      expect(projectClient).not.toBeNull()

      await runPlanLaunch(
        {
          api: mockApi as never,
          client: projectClient!,
          cache: null,
          pluginConfig: { loop: { enabled: true } } as never,
          logger: createLogger({ enabled: false, file: '' }),
          sessionId: 'sess-host',
          projectDirectory: DIRECTORY,
          planContent: '# Plan\nDo the thing cross-process failure path',
          loopName: 'panel-cross-failure',
        },
        {
          mode: 'New session',
          target: 'local',
          execModel: 'test/exec',
          auditModel: 'test/auditor',
          execVariant: 'panel-exec-variant',
          auditVariant: 'panel-audit-variant',
        },
      )

      // promptAsync still queued; panel surfaces authoritative failure.
      expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
      const errorToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'error')
      expect(errorToasts.length).toBe(1)
      expect(errorToasts[0][0]?.message).toContain('Failed')
      const successToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'success')
      expect(successToasts.length).toBe(0)
      const sessionNavigations = mockApi.route.navigate.mock.calls.filter((c: any[]) => c[0] === 'session')
      expect(sessionNavigations.length).toBe(0)
    } finally {
      rmSync(reachableDataDir, { recursive: true, force: true })
    }
  })

  test('with no bridge registered and loops unavailable, the panel resolves the one-shot fallback by per-launch nonce and navigates', async () => {
    /**
     * Cross-process one-shot fallback. The TUI panel ALWAYS supplies a loop
     * name, but when loops are disabled or the project has no commit the
     * server-side `handlePlanNewSession` falls back to a plain one-shot
     * session in the project directory. The panel mints a per-launch
     * `requestNonce`, threads it through the `execute-plan` tool invocation,
     * and the server handler records an authoritative
     * `loop_new_session_outcomes` row (kind='one-shot') keyed by that nonce.
     * The cross-process resolver correlates by nonce + host session (NOT by
     * the predicted session title), so an unrelated concurrent same-title
     * session can never be misattributed to this launch. Here the resolver is
     * stubbed to model the handler having written that one-shot outcome: it
     * returns the new session id with NO loop name, and the panel reports the
     * one-shot fallback toast + navigates — never a timeout.
     *
     * Resolver-level nonce/host correlation (including the same-title fence)
     * is covered by tui-client-cross-process-resolver.test.ts; this test
     * exercises the panel's end-to-end handling of a one-shot fallback result.
     */
    clearForgeExecutionBridges()
    __setCrossProcessNewSessionResolver(
      (async () => ({ sessionId: 'fallback-session' })) as CrossProcessNewSessionResolver,
    )

    const predictedTitle = 'Refactor API'

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
      ui: {
        dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() },
        toast: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const reachableDataDir = makeReachableDataDir()
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
    try {
      expect(projectClient).not.toBeNull()

      await runPlanLaunch(
        {
          api: mockApi as never,
          client: projectClient!,
          cache: null,
          pluginConfig: { loop: { enabled: false } } as never,
          logger: createLogger({ enabled: false, file: '' }),
          sessionId: 'sess-host',
          projectDirectory: DIRECTORY,
          planContent: `Loop Name: ${predictedTitle}\n\n# Plan\nDo the refactoring.`,
          loopName: 'panel-fallback-loop',
        },
        {
          mode: 'New session',
          target: 'local',
          execModel: 'test/exec',
          auditModel: 'test/auditor',
          execVariant: 'panel-exec-variant',
          auditVariant: 'panel-auditor-variant',
        },
      )

      // The panel prompted the host session's code agent to invoke execute-plan,
      // forwarding a per-launch requestNonce for nonce-correlated confirmation.
      expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(1)
      const promptArgs = mockApi.client.session.promptAsync.mock.calls[0][0] as any
      expect(promptArgs.sessionID).toBe('sess-host')
      expect(promptArgs.agent).toBe('code')
      const promptText = promptArgs.parts?.[0]?.text ?? ''
      expect(promptText).toContain('execute-plan')
      expect(promptText).toContain('new-session')
      expect(promptText).toContain('requestNonce')
      expect(promptText).toMatch(/crossProcess:\s*true/)

      // No audited goal loop / workspace in this fallback scenario.
      expect(mockApi.client.session.create).not.toHaveBeenCalled()
      expect(mockApi.client.experimental.workspace.create).not.toHaveBeenCalled()

      // Authoritative success toast (one-shot fallback has no loop name) and
      // navigation to the fallback session — not a timeout error.
      const successToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'success')
      expect(successToasts.length).toBe(1)
      expect(successToasts[0][0]?.message).toBe('Plan execution started (one-shot fallback: no tracked goal loop)')
      const errorToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'error')
      expect(errorToasts.length).toBe(0)
      const sessionNavigations = mockApi.route.navigate.mock.calls.filter((c: any[]) => c[0] === 'session')
      expect(sessionNavigations.length).toBe(1)
      expect(sessionNavigations[0][1]).toEqual({ sessionID: 'fallback-session' })
    } finally {
      rmSync(reachableDataDir, { recursive: true, force: true })
    }
  })

  test('with no bridge registered, the cross-process instruction forwards a per-launch requestNonce for nonce-correlated confirmation', async () => {
    /**
     * Guards the requestNonce plumbing the auditor's bug-3 fix relies on: the
     * panel mints a fresh nonce per launch and forwards it as the
     * `requestNonce` argument of the `execute-plan` tool invocation so the
     * server-side handler can record the authoritative outcome row keyed by
     * it. Each launch must mint a DISTINCT nonce (never reuse across launches).
     */
    clearForgeExecutionBridges()
    __setCrossProcessNewSessionResolver(
      (async () => ({ loopName: 'nonce-loop', sessionId: 'nonce-session' })) as CrossProcessNewSessionResolver,
    )

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
      ui: { dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() }, toast: vi.fn() },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const reachableDataDir = makeReachableDataDir()
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: reachableDataDir })
    try {
      expect(projectClient).not.toBeNull()

      await runPlanLaunch(
        {
          api: mockApi as never,
          client: projectClient!,
          cache: null,
          pluginConfig: { loop: { enabled: true } } as never,
          logger: createLogger({ enabled: false, file: '' }),
          sessionId: 'sess-host',
          projectDirectory: DIRECTORY,
          planContent: '# Plan\nNonce plumbing',
          loopName: 'panel-nonce',
        },
        { mode: 'New session', target: 'local', execModel: 'test/exec', auditModel: 'test/auditor' },
      )
      await runPlanLaunch(
        {
          api: mockApi as never,
          client: projectClient!,
          cache: null,
          pluginConfig: { loop: { enabled: true } } as never,
          logger: createLogger({ enabled: false, file: '' }),
          sessionId: 'sess-host-2',
          projectDirectory: DIRECTORY,
          planContent: '# Plan\nNonce plumbing second',
          loopName: 'panel-nonce-2',
        },
        { mode: 'New session', target: 'local', execModel: 'test/exec', auditModel: 'test/auditor' },
      )

      expect(mockApi.client.session.promptAsync).toHaveBeenCalledTimes(2)
      const text1 = (mockApi.client.session.promptAsync.mock.calls[0][0] as any).parts?.[0]?.text ?? ''
      const text2 = (mockApi.client.session.promptAsync.mock.calls[1][0] as any).parts?.[0]?.text ?? ''
      const extractNonce = (t: string): string | null => {
        const m = t.match(/requestNonce:\s*"([^"]+)"/)
        return m ? m[1] : null
      }
      const nonce1 = extractNonce(text1)
      const nonce2 = extractNonce(text2)
      expect(nonce1).not.toBeNull()
      expect(nonce2).not.toBeNull()
      expect(nonce1).not.toBe(nonce2)

      // Each cross-process instruction marks itself `crossProcess: true` so
      // the server-side tool can reject a malformed launch whose nonce was
      // dropped while still admitting nonce-free direct `/execute-plan` calls.
      expect(text1).toMatch(/crossProcess:\s*true/)
      expect(text2).toMatch(/crossProcess:\s*true/)
    } finally {
      rmSync(reachableDataDir, { recursive: true, force: true })
    }
  })

  test('plan.execute rejection surfaces an error toast after the dialog has been cleared', async () => {
    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: {
          workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
        },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
      ui: {
        dialog: { clear: vi.fn(), setSize: vi.fn(), replace: vi.fn() },
        toast: vi.fn(),
      },
    }

    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    const projectClient = await connectForgeProject(mockApi, DIRECTORY, [])
    expect(projectClient).not.toBeNull()

    // Bridge is registered but throws when invoked (simulates an unexpected
    // server-side / in-process error after dialog.clear()).
    const bridgeThrow = () => { throw new Error('bridge blew up') }
    projectClient!.plan.execute = bridgeThrow as never

    await runPlanLaunch(
      {
        api: mockApi as never,
        client: projectClient!,
        cache: null,
        pluginConfig: { loop: { enabled: true } } as never,
        logger: createLogger({ enabled: false, file: '' }),
        sessionId: 'sess-host',
        projectDirectory: DIRECTORY,
        planContent: '# Plan\nDo the thing',
        loopName: 'panel-throws',
      },
      {
        mode: 'New session',
        target: 'local',
        execModel: 'test/exec',
        auditModel: 'test/auditor',
      },
    )

    // Dialog was cleared and the info toast was shown before the rejection.
    expect(mockApi.ui.dialog.clear).toHaveBeenCalledTimes(1)
    const infoToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'info')
    expect(infoToasts.length).toBeGreaterThan(0)
    // Rejection surfaces a deterministic error toast mentioning the cause.
    const errorToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'error')
    expect(errorToasts.length).toBe(1)
    expect(errorToasts[0][0]?.message).toContain('bridge blew up')
    const successToasts = mockApi.ui.toast.mock.calls.filter((c: any[]) => c[0]?.variant === 'success')
    expect(successToasts.length).toBe(0)
    const sessionNavigations = mockApi.route.navigate.mock.calls.filter((c: any[]) => c[0] === 'session')
    expect(sessionNavigations.length).toBe(0)
  })
})
