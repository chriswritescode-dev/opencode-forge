import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { SandboxState as RuntimeSandboxState } from '../../src/sandbox/msb'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'

const noopFn = () => {}

const PROJECT_ID = 'test-project'

vi.mock('../../src/utils/sandbox-ready', () => ({
  waitForSandboxReady: vi.fn(),
}))

vi.mock('../../src/sandbox/msb', () => ({
  createMsbRuntime: vi.fn(),
}))

describe('attachLoopToSession sandbox-not-ready cleanup', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'exec-sandbox-cleanup-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    // attachLoopToSession only runs the sandbox wait when forge.db exists at dataDir.
    writeFileSync(join(tempDir, 'forge.db'), '')
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  function buildDeps() {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )

    const { client } = createFakeForgeClient()

    const deps = {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      dataDir: tempDir,
      client,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loop: {
        service: loopService,
        listActive: (...a: any[]) => loopService.listActive(...a as any),
        generateUniqueLoopName: (...a: any[]) => loopService.generateUniqueLoopName(...a as any),
        findMatchByName: (...a: any[]) => loopService.findMatchByName(...a as any),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(),
        clearLoopTimers: noopFn,
      },
      sandboxManager: {},
      workspaceStatusRegistry: {
        recordEvent: vi.fn(),
        getStatus: vi.fn().mockReturnValue('connected' as const),
        awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
        primeFromSnapshot: vi.fn(),
      },
    }

    return { deps, loopService }
  }

  async function runAttachWithSandboxState(state: RuntimeSandboxState): Promise<{
    removeSandbox: ReturnType<typeof vi.fn>
    getSandboxState: ReturnType<typeof vi.fn>
    result: Awaited<ReturnType<typeof attach>>
  }> {
    const { waitForSandboxReady } = await import('../../src/utils/sandbox-ready')
    const { createMsbRuntime } = await import('../../src/sandbox/msb')
    vi.mocked(waitForSandboxReady).mockResolvedValue({ ready: false, reason: 'timeout' })

    const getSandboxState = vi.fn(async () => state)
    const removeSandbox = vi.fn(async () => {})
    vi.mocked(createMsbRuntime).mockReturnValue({
      sandboxContainerName: (name: string) => `forge-${name}`,
      getSandboxState,
      removeSandbox,
    } as any)

    const { deps } = buildDeps()
    const { attachLoopToSession } = await import('../../src/services/execution')
    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_msb',
        workspaceId: 'ws_msb',
        worktreeDir: '/tmp/wt/msb',
        loopName: 'msb-loop',
        displayName: 'MSB Loop',
        executionName: 'msb-loop',
        maxIterations: 50,
        sandboxEnabled: true,
        planText: 'NEW_PLAN',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )
    return { removeSandbox, getSandboxState, result }
  }

  test('removes the sandbox when its state is confirmed running', async () => {
    const { removeSandbox, getSandboxState, result } = await runAttachWithSandboxState('running')
    expect(getSandboxState).toHaveBeenCalledWith('forge-msb-loop')
    expect(removeSandbox).toHaveBeenCalledWith('forge-msb-loop')
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('removes the sandbox when its state is confirmed stopped', async () => {
    const { removeSandbox, result } = await runAttachWithSandboxState('stopped')
    expect(removeSandbox).toHaveBeenCalledWith('forge-msb-loop')
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('never removes a sandbox whose state query returned unknown', async () => {
    const { removeSandbox, result } = await runAttachWithSandboxState('unknown')
    expect(removeSandbox).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('never removes a sandbox that is already missing', async () => {
    const { removeSandbox, result } = await runAttachWithSandboxState('missing')
    expect(removeSandbox).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('a throwing cleanup does not mask the not-ready failure', async () => {
    const { waitForSandboxReady } = await import('../../src/utils/sandbox-ready')
    const { createMsbRuntime } = await import('../../src/sandbox/msb')
    vi.mocked(waitForSandboxReady).mockResolvedValue({ ready: false, reason: 'timeout' })
    vi.mocked(createMsbRuntime).mockReturnValue({
      sandboxContainerName: (name: string) => `forge-${name}`,
      getSandboxState: async () => 'running' as const,
      removeSandbox: async () => { throw new Error('rm failed') },
    } as any)

    const { deps } = buildDeps()
    const { attachLoopToSession } = await import('../../src/services/execution')
    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_msb',
        workspaceId: 'ws_msb',
        worktreeDir: '/tmp/wt/msb',
        loopName: 'msb-loop',
        displayName: 'MSB Loop',
        executionName: 'msb-loop',
        maxIterations: 50,
        sandboxEnabled: true,
        planText: 'NEW_PLAN',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })
})
