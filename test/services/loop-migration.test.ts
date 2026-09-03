import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import type { LoopState } from '../../src/loop/state'
import type { GitService } from '../../src/utils/git-service'
import type { ForgeClient } from '../../src/client/port'
import type { PluginConfig } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeGitService } from '../helpers/fake-git'
import { createClientSpy, REMOTE_URL, LOCAL_PROJECT_ID } from '../helpers/fake-remote-client'

// launchTuiLoop's transitive TUI/storage imports must not touch real state;
// the repos below use the bun:sqlite vitest shim directly, so the storage
// module that launchTuiLoop pulls in is mocked by name instead.
vi.mock('../../src/utils/tui-execution-preferences', () => ({
  deriveExecutionPreferencesFromWorkspaces: vi.fn().mockReturnValue(null),
}))
vi.mock('../../src/utils/tui-models', () => ({
  fetchAvailableModels: vi.fn().mockResolvedValue({ providers: [] }),
  readOpenCodeFavoriteModels: vi.fn().mockReturnValue([]),
}))
vi.mock('../../src/utils/workspace-listing', () => ({
  listConnectedWorkspaces: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/utils/tui-loop-store', () => ({
  fetchLoopsList: vi.fn().mockReturnValue([]),
}))
vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
  resolveDataDir: vi.fn().mockReturnValue('/tmp/forge-test-data'),
}))

const mockLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }
const noopFn = () => {}
// The local OpenCode project id must match the remote fake's project id so
// discovery finds it (migration matches by identity, not path).
const PROJECT_ID = LOCAL_PROJECT_ID
const SYNC_REF = 'refs/forge/my-loop'
const DEADBEEF = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('migrateLoopToRemote', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopTransitionsRepo: LoopTransitionsRepo
  let loopService: LoopService

  const mockWorkspaceStatusRegistry = {
    awaitConnected: async () => ({ connected: true }),
  }

  const mockPendingTeardowns = {
    register: () => {},
    unregister: () => {},
    get: () => undefined,
  }

  beforeEach(() => {
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    tempDir = mkdtempSync(join(tmpdir(), 'loop-migration-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
      loopTransitionsRepo,
    )
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  interface SeedOpts {
    loopName?: string
    active?: boolean
    status?: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
    terminationReason?: string
  }

  function seedLoop(opts: SeedOpts = {}): LoopState {
    const loopName = opts.loopName ?? 'my-loop'
    const active = opts.active ?? true
    const state: LoopState = {
      active,
      sessionId: 'sess_local',
      loopName,
      worktreeDir: '/local/wt',
      projectDir: '/local/proj',
      worktreeBranch: 'forge/my-loop',
      iteration: 3,
      maxIterations: 40,
      startedAt: new Date().toISOString(),
      prompt: '# My Plan\n\nStep one.',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      status: opts.status ?? (active ? 'running' : 'cancelled'),
      worktree: true,
      sandbox: false,
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
      ...(opts.terminationReason ? { terminationReason: opts.terminationReason } : {}),
    }
    loopService.setState(loopName, state)

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName,
      sections: [
        { index: 0, title: 'Setup', content: 'Do setup' },
        { index: 1, title: 'Build', content: 'Do build' },
        { index: 2, title: 'Ship', content: 'Do ship' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, loopName, 0, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, loopName, 1, 'in_progress')

    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName,
      file: 'a.ts',
      line: 10,
      severity: 'bug',
      description: 'section finding',
      sectionIndex: 1,
    })

    plansRepo.writeForLoop(PROJECT_ID, loopName, '# My Plan\n\nStep one.')
    return state
  }

  function happyConfig(): PluginConfig {
    return {
      remotes: [{ name: 'server1', url: REMOTE_URL, password: 'sekret' }],
    }
  }

  function happyGit(): GitService {
    return createFakeGitService({
      branchExists: vi.fn(() => true),
      revParseRef: vi.fn(() => ({ ok: true, status: 0, stdout: `${DEADBEEF}\n`, stderr: '' })),
    })
  }

  async function buildDeps(opts: {
    config?: PluginConfig
    git?: GitService
    createRemoteClient?: (o: unknown) => ForgeClient
    onTerminateLoopByName?: (name: string, reason: unknown) => void
  } = {}) {
    const terminateCalls: Array<{ name: string; reason: string }> = []

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
      terminateLoopByName: async (name: string, reason: { kind: string; message?: string }) => {
        opts.onTerminateLoopByName?.(name, reason)
        terminateCalls.push({ name, reason: `${reason.kind}${reason.message ? `: ${reason.message}` : ''}` })
        const state = loopService.getActiveState(name)
        if (!state?.active) return false
        loopService.terminate(name, {
          status: 'cancelled',
          reason: `${reason.kind}${reason.message ? `: ${reason.message}` : ''}`,
          completedAt: Date.now(),
        })
        return true
      },
    }

    const localClient = createFakeForgeClient().client
    const remoteSpy = opts.createRemoteClient ?? createClientSpy().spy

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/local/proj',
      config: opts.config ?? happyConfig(),
      logger: mockLogger,
      dataDir: '/tmp',
      plansRepo,
      loopsRepo,
      loop: {
        service: loopService,
        inspect: (name: string) => loopService.getAnyState(name),
        listActive: (...args: unknown[]) => (loopService.listActive as (...a: unknown[]) => LoopState[])(...args),
        listRecent: (...args: unknown[]) => (loopService.listRecent as (...a: unknown[]) => LoopState[])(...args),
        setPhase: (...args: unknown[]) => (loopService.setPhase as (...a: unknown[]) => void)(...args),
        generateUniqueLoopName: (...args: unknown[]) => (loopService.generateUniqueLoopName as (...a: unknown[]) => string)(...args),
        registerSessionReverseIndex: noopFn,
        unregisterSessionReverseIndex: noopFn,
      } as unknown as Parameters<typeof createForgeExecutionService>[0]['loop'],
      loopHandler: mockLoopHandler as never,
      sectionPlansRepo,
      reviewFindingsRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as never,
      client: localClient,
      pendingTeardowns: mockPendingTeardowns as never,
      git: opts.git,
      createRemoteClient: remoteSpy as unknown as (o: unknown) => ForgeClient,
    })

    return { service, terminateCalls, remoteSpy: remoteSpy as unknown as ReturnType<typeof vi.fn> }
  }

  const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/local/proj' }
  const migrateCommand = { type: 'loop.migrate' as const, selector: { kind: 'exact' as const, name: 'my-loop' }, remoteName: 'server1' }

  test('happy path: freezes the loop as migrated, pushes sync ref, launches remote loop with snapshot', async () => {
    seedLoop()
    const git = happyGit()
    const { spy: createClient, clients } = createClientSpy()
    const terminateReasons: Array<{ name: string; reason: unknown }> = []
    const { service } = await buildDeps({
      git,
      createRemoteClient: createClient as never,
      onTerminateLoopByName: (name, reason) => terminateReasons.push({ name, reason }),
    })

    const result = await service.dispatch(ctx, migrateCommand)
    if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.error)}`)

    expect(result.data).toEqual({
      operation: 'loop.migrate',
      loopName: 'my-loop',
      remoteName: 'server1',
      remoteLoopName: 'my-loop',
      remoteSessionId: 'sess_remote',
      startRef: DEADBEEF,
      syncRef: SYNC_REF,
      phase: 'coding',
      currentSectionIndex: 1,
      totalSections: 3,
    })

    // Loop handler received the migrated reason; local row is cancelled/migrated.
    expect(terminateReasons).toEqual([{ name: 'my-loop', reason: { kind: 'migrated', message: 'server1' } }])
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('cancelled')
    expect(row?.terminationReason).toBe('migrated: server1')

    // git.push: exactly one forced push of the loop branch tip to the sync ref.
    expect(git.push).toHaveBeenCalledTimes(1)
    expect(git.push).toHaveBeenCalledWith('/local/proj', 'origin', 'refs/heads/forge/my-loop:refs/forge/my-loop', true)

    // The scoped remote client created the workspace with the migration extras.
    const remoteClient = clients[1]
    expect(remoteClient.workspace.create).toHaveBeenCalledTimes(1)
    const createParams = (remoteClient.workspace.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createParams.extra.startRef).toBe(DEADBEEF)
    expect(createParams.extra.syncRef).toBe(SYNC_REF)
    expect(createParams.extra.gitRemote).toBe('origin')
    expect(createParams.extra.forgeLoop.maxIterations).toBe(40)
    expect(createParams.extra.forgeLoop.resume).toBeDefined()
    expect(createParams.extra.forgeLoop.resume.totalSections).toBe(3)
    expect(createParams.extra.forgeLoop.resume.currentSectionIndex).toBe(1)
    expect(createParams.extra.forgeLoop.resume.findings).toHaveLength(1)
    expect(createParams.extra.forgeLoop.planText).toBe('# My Plan\n\nStep one.')

    // Phase-appropriate first prompt on the remote session.
    expect(remoteClient.session.promptAsync).toHaveBeenCalledTimes(1)
    const promptInput = (remoteClient.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(promptInput.agent).toBe('code')
  })

  test('first remote prompt equals buildSectionInitialPrompt of the frozen state', async () => {
    seedLoop()
    const git = happyGit()
    const { spy: createClient, clients } = createClientSpy()
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never })

    const result = await service.dispatch(ctx, migrateCommand)
    expect(result.ok).toBe(true)

    const frozen = loopService.getAnyState('my-loop')!
    const expectedPrompt = loopService.buildSectionInitialPrompt(frozen)
    expect(expectedPrompt.length).toBeGreaterThan(0)
    const promptInput = (clients[1].session.promptAsync as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(promptInput.parts[0].text).toBe(expectedPrompt)
    expect(promptInput.agent).toBe('code')
  })

  test('unknown remote fails bad_request without touching the loop', async () => {
    seedLoop()
    const git = happyGit()
    const { service, terminateCalls } = await buildDeps({ git, createRemoteClient: createClientSpy().spy as never })

    const result = await service.dispatch(ctx, { ...migrateCommand, remoteName: 'nope' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('bad_request')
    expect(terminateCalls).toHaveLength(0)
    expect(git.push).not.toHaveBeenCalled()
  })

  test('remote workspace.create failure rolls back: cleanup push, loop cancelled and restartable', async () => {
    seedLoop()
    const git = happyGit()
    const { spy: createClient, clients } = createClientSpy({
      workspace: {
        create: async () => { throw new Error('remote exploded') },
      },
    })
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('internal_error')
    expect(result.error.message).toContain('restartable')

    // Best-effort sync-ref cleanup push happened (delete: ':refs/forge/my-loop').
    expect(git.push).toHaveBeenCalledWith('/local/proj', 'origin', ':refs/forge/my-loop', false)

    // The local loop is cancelled (not migrated) and restartable again.
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('cancelled')
    expect(row?.terminationReason).toBe('cancelled')
    const state = loopService.getAnyState('my-loop')!
    const { getRestartability } = await import('../../src/loop/restartability')
    expect(getRestartability(state, { worktreeExists: () => true, branchExists: () => true }).restartable).toBe(true)
    expect(clients[1].session.create).not.toHaveBeenCalled()
  })

  test('a loop already migrated elsewhere fails conflict naming the previous remote', async () => {
    seedLoop({ active: false, terminationReason: 'migrated: elsewhere' })
    const git = happyGit()
    const { service, terminateCalls } = await buildDeps({ git, createRemoteClient: createClientSpy().spy as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('conflict')
    expect(result.error.message).toContain('elsewhere')
    expect(terminateCalls).toHaveLength(0)
    expect(git.push).not.toHaveBeenCalled()
  })

  test('a completed loop fails conflict', async () => {
    seedLoop({ active: false, status: 'completed', terminationReason: 'completed' })
    const git = happyGit()
    const { service, terminateCalls } = await buildDeps({ git, createRemoteClient: createClientSpy().spy as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('conflict')
    expect(terminateCalls).toHaveLength(0)
    expect(git.push).not.toHaveBeenCalled()
  })
})
