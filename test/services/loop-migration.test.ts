import { describe, test, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createFeatureGroupsRepo, type FeatureGroupsRepo } from '../../src/storage/repos/feature-groups-repo'
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
vi.mock('../../src/loop/resume-snapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/loop/resume-snapshot')>()
  return { ...original, captureLoopResumeSnapshot: vi.fn(original.captureLoopResumeSnapshot) }
})
vi.mock('../../src/loop/resume-prompt', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/loop/resume-prompt')>()
  return { ...original, buildResumePromptPlan: vi.fn(original.buildResumePromptPlan) }
})

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
  let featureGroupsRepo: FeatureGroupsRepo
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
    featureGroupsRepo = createFeatureGroupsRepo(db)
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
    worktreeDir?: string
    worktree?: boolean
    workspaceId?: string
  }

  function seedLoop(opts: SeedOpts = {}): LoopState {
    const loopName = opts.loopName ?? 'my-loop'
    const active = opts.active ?? true
    const state: LoopState = {
      active,
      sessionId: 'sess_local',
      loopName,
      worktreeDir: opts.worktreeDir ?? '/local/wt',
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
      worktree: opts.worktree ?? true,
      sandbox: false,
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
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
    terminateLoopByNameReturnsFalse?: boolean
    featureGroupsRepo?: FeatureGroupsRepo
    localWorkspaceList?: () => Promise<Array<Record<string, unknown>>>
  } = {}) {
    const terminateCalls: Array<{ name: string; reason: string }> = []

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
      terminateLoopByName: async (name: string, reason: { kind: string; message?: string }) => {
        opts.onTerminateLoopByName?.(name, reason)
        if (opts.terminateLoopByNameReturnsFalse) return false
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

    const localClient = createFakeForgeClient(
      opts.localWorkspaceList ? { workspace: { list: opts.localWorkspaceList } } : undefined,
    ).client
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
        listLoopNames: (...args: unknown[]) => (loopService.listLoopNames as (...a: unknown[]) => string[])(...args),
        findMatchByName: (...args: unknown[]) => (loopService.findMatchByName as (...a: unknown[]) => { match: LoopState | null; candidates: LoopState[] })(...args),
        setPhase: (...args: unknown[]) => (loopService.setPhase as (...a: unknown[]) => void)(...args),
        generateUniqueLoopName: (...args: unknown[]) => (loopService.generateUniqueLoopName as (...a: unknown[]) => string)(...args),
        runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        registerSessionReverseIndex: noopFn,
        unregisterSessionReverseIndex: noopFn,
      } as unknown as Parameters<typeof createForgeExecutionService>[0]['loop'],
      loopHandler: mockLoopHandler as never,
      sectionPlansRepo,
      reviewFindingsRepo,
      featureGroupsRepo: opts.featureGroupsRepo,
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

  test('a worktree:false loop is refused before any remote call', async () => {
    seedLoop({ worktree: false })
    const git = happyGit()
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('conflict')
    expect(result.error.message).toContain('worktree: false')
    expect(createClient).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  test('a feature-group loop is refused', async () => {
    seedLoop()
    featureGroupsRepo.createGroup({ projectId: PROJECT_ID, groupId: 'g1', title: 'Group', status: 'running' })
    featureGroupsRepo.insertFeatures(PROJECT_ID, 'g1', [{ title: 'Feature', description: 'Do it' }])
    featureGroupsRepo.setFeatureLoopName(PROJECT_ID, 'g1', 0, 'my-loop')
    const git = happyGit()
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never, featureGroupsRepo })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('conflict')
    expect(result.error.message).toContain('feature group')
    expect(createClient).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  test('terminateLoopByName returning false fails conflict with no push', async () => {
    seedLoop()
    const git = happyGit()
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({
      git,
      createRemoteClient: createClient as never,
      terminateLoopByNameReturnsFalse: true,
    })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('conflict')
    expect(result.error.message).toContain('changed state during migration')
    expect(git.push).not.toHaveBeenCalled()
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('running')
  })

  test('dirty worktree after freeze rolls back to cancelled and never pushes', async () => {
    const worktreeDir = join(tempDir, 'wt')
    mkdirSync(worktreeDir, { recursive: true })
    seedLoop({ worktreeDir })
    const git = happyGit()
    const statusPorcelain = vi.fn(() => ({ ok: true, status: 0, stdout: ' M a.ts\n', stderr: '' }))
    git.statusPorcelain = statusPorcelain as never
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('internal_error')
    expect(result.error.message).toContain('uncommitted changes')
    expect(statusPorcelain).toHaveBeenCalledWith(worktreeDir)
    expect(git.push).not.toHaveBeenCalled()
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('cancelled')
    expect(row?.terminationReason).toBe('cancelled')
  })

  test('a throw from captureLoopResumeSnapshot after freeze rolls back without pushing', async () => {
    seedLoop()
    const git = happyGit()
    const { captureLoopResumeSnapshot } = await import('../../src/loop/resume-snapshot')
    ;(captureLoopResumeSnapshot as Mock).mockImplementationOnce(() => { throw new Error('snapshot boom') })
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({ git, createRemoteClient: createClient as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.code).toBe('internal_error')
    expect(result.error.message).toContain('snapshot boom')
    expect(result.error.message).toContain('restartable')
    expect(git.push).not.toHaveBeenCalled()
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('cancelled')
    expect(row?.terminationReason).toBe('cancelled')
  })

  test('a throw from buildResumePromptPlan rolls back without pushing', async () => {
    seedLoop()
    const git = happyGit()
    const { buildResumePromptPlan } = await import('../../src/loop/resume-prompt')
    ;(buildResumePromptPlan as Mock).mockImplementationOnce(() => { throw new Error('prompt boom') })
    const { service, remoteSpy } = await buildDeps({ git, createRemoteClient: createClientSpy().spy as never })

    const result = await service.dispatch(ctx, migrateCommand)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error.message).toContain('prompt boom')
    expect(git.push).not.toHaveBeenCalled()
    expect(remoteSpy).toHaveBeenCalledTimes(2)
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('cancelled')
  })

  test('an inactive errored loop restored to errored with its original reason on post-freeze failure', async () => {
    seedLoop({ active: false, status: 'errored', terminationReason: 'error_max_retries: too many' })
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
    const row = loopsRepo.get(PROJECT_ID, 'my-loop')
    expect(row?.status).toBe('errored')
    expect(row?.terminationReason).toBe('error_max_retries: too many')
    expect(clients[1].session.create).not.toHaveBeenCalled()
  })

  test('portable permission rules merge the workspace extras with the config rules', async () => {
    seedLoop({ workspaceId: 'ws_local' })
    const git = happyGit()
    const config = happyConfig()
    config.loop = { permissions: { deny: [{ permission: 'bash', pattern: 'git push *' }] } }
    const { spy: createClient, clients } = createClientSpy()
    const { service } = await buildDeps({
      config,
      git,
      createRemoteClient: createClient as never,
      localWorkspaceList: async () => [
        {
          id: 'ws_local',
          type: 'forge',
          extra: {
            permissionRules: [{ permission: 'webfetch', pattern: 'example.com/*', action: 'deny' }],
          },
        },
      ],
    })

    const result = await service.dispatch(ctx, migrateCommand)
    expect(result.ok).toBe(true)

    const remoteClient = clients[1]
    const createParams = (remoteClient.workspace.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createParams.extra.permissionRules).toEqual([
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'webfetch', pattern: 'example.com/*', action: 'deny' },
    ])
  })

  test('successful migration deletes the loop own previous sync pin', async () => {
    seedLoop({
      workspaceId: 'ws_local',
    })
    const git = happyGit()
    const { spy: createClient } = createClientSpy()
    const { service } = await buildDeps({
      git,
      createRemoteClient: createClient as never,
      localWorkspaceList: async () => [
        {
          id: 'ws_local',
          type: 'forge',
          extra: { syncRef: 'refs/forge/old-pin', gitRemote: 'upstream' },
        },
      ],
    })

    const result = await service.dispatch(ctx, migrateCommand)
    expect(result.ok).toBe(true)

    expect(git.push).toHaveBeenCalledTimes(2)
    expect(git.push).toHaveBeenCalledWith('/local/proj', 'origin', 'refs/heads/forge/my-loop:refs/forge/my-loop', true)
    expect(git.push).toHaveBeenCalledWith('/local/proj', 'upstream', ':refs/forge/old-pin', false)
  })
})
