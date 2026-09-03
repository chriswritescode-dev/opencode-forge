import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createFeatureGroupsRepo } from '../../src/storage/repos/feature-groups-repo'
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
import { createLoopTools } from '../../src/tools/loop'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeGitService } from '../helpers/fake-git'
import { createClientSpy, REMOTE_URL, LOCAL_PROJECT_ID, REMOTE_SESSION_ID } from '../helpers/fake-remote-client'
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

// The tool's makeService leaves `git` at its default, so the default git
// service itself must be faked for the migration path to succeed in tests.
vi.mock('../../src/utils/git-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/git-service')>()
  const { createFakeGitService } = await import('../helpers/fake-git')
  const { vi: viFromMock } = await import('vitest')
  const fake = createFakeGitService({
    branchExists: viFromMock.fn(() => true),
    revParseRef: viFromMock.fn(() => ({ ok: true, status: 0, stdout: `${DEADBEEF}\n`, stderr: '' })),
  })
  return { ...original, defaultGitService: fake }
})

// Same for remote discovery: the default client factory must resolve to the
// shared fake remote client so no network access happens.
vi.mock('../../src/client/sdk-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/client/sdk-adapter')>()
  const { makeFakeRemoteClient } = await import('../helpers/fake-remote-client')
  return { ...original, createRemoteForgeClient: () => makeFakeRemoteClient() }
})

const mockLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }
const noopFn = () => {}
const PROJECT_ID = LOCAL_PROJECT_ID
const SYNC_REF = 'refs/forge/my-loop'
const DEADBEEF = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('loop-migrate tool', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopTransitionsRepo: LoopTransitionsRepo
  let featureGroupsRepo: ReturnType<typeof createFeatureGroupsRepo>
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
    tempDir = mkdtempSync(join(tmpdir(), 'loop-migrate-tool-test-'))
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

  function seedLoop(): LoopState {
    const state: LoopState = {
      active: true,
      sessionId: 'sess_local',
      loopName: 'my-loop',
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
      status: 'running',
      worktree: true,
      sandbox: false,
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
    }
    loopService.setState('my-loop', state)

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'my-loop',
      sections: [
        { index: 0, title: 'Setup', content: 'Do setup' },
        { index: 1, title: 'Build', content: 'Do build' },
        { index: 2, title: 'Ship', content: 'Do ship' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, 'my-loop', 0, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, 'my-loop', 1, 'in_progress')

    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'my-loop',
      file: 'a.ts',
      line: 10,
      severity: 'bug',
      description: 'section finding',
      sectionIndex: 1,
    })

    plansRepo.writeForLoop(PROJECT_ID, 'my-loop', '# My Plan\n\nStep one.')
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

  async function buildTools(opts: {
    config?: PluginConfig
    git?: GitService
    createRemoteClient?: (o: unknown) => ForgeClient
  } = {}) {
    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
      terminateLoopByName: async (name: string, reason: { kind: string; message?: string }) => {
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
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as never,
      client: localClient,
      pendingTeardowns: mockPendingTeardowns as never,
      git: opts.git,
      createRemoteClient: remoteSpy as unknown as (o: unknown) => ForgeClient,
    })

    const tools = createLoopTools({
      client: localClient,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as never,
      pendingTeardowns: mockPendingTeardowns as never,
      directory: '/local/proj',
      config: opts.config ?? happyConfig(),
      loopService,
      loopHandler: mockLoopHandler as never,
      logger: mockLogger,
      plansRepo,
      loopsRepo,
      projectId: PROJECT_ID,
      dataDir: '/tmp',
      loop: {
        service: loopService,
        inspect: (name: string) => loopService.getAnyState(name),
        listActive: () => loopService.listActive(),
        listRecent: () => loopService.listRecent(),
        findMatchByName: (name: string) => loopService.findMatchByName(name),
        runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        resolveLoopName: () => null,
      } as never,
      sectionPlansRepo,
      reviewFindingsRepo,
      featureGroupsRepo,
    } as never)

    return tools
  }

  test('dispatches loop.migrate with a partial selector and renders the success text', async () => {
    seedLoop()
    const tools = await buildTools({ git: happyGit(), createRemoteClient: createClientSpy().spy as never })

    const result = await tools['loop-migrate'].execute(
      { name: 'my-loop', remote: 'server1' },
      { sessionID: 'host-session' } as never,
    )

    expect(result).toContain('Migrated loop "my-loop" to server1')
    expect(result).toContain(`Remote loop: my-loop`)
    expect(result).toContain(`Remote session: ${REMOTE_SESSION_ID}`)
    expect(result).toContain('Resumed at: phase coding, section 2/3')
    expect(result).toContain('Pinned commit: deadbee (refs/forge/my-loop)')
    expect(result).toContain('Restart it locally only with loop-status restart=true force=true')
  })

  test('renders candidate loops when the name is ambiguous', async () => {
    const seeded = seedLoop()
    const other: LoopState = {
      ...seeded,
      loopName: 'my-loop-2',
      worktreeBranch: 'forge/my-loop-2',
      sessionId: 'sess_local_2',
    }
    loopService.setState('my-loop-2', other)

    const tools = await buildTools({ git: happyGit(), createRemoteClient: createClientSpy().spy as never })

    const result = await tools['loop-migrate'].execute(
      { name: 'my-loo', remote: 'server1' },
      { sessionID: 'host-session' } as never,
    )

    expect(result).toContain('Multiple loops match')
    expect(result).toContain('my-loop')
    expect(result).toContain('my-loop-2')
  })
})
