import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'

const noopFn = () => {}

const PROJECT_ID = 'test-project'

vi.mock('../../src/utils/sandbox-ready', () => ({
  waitForSandboxReady: vi.fn(),
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
    try {
      rmSync(tempDir, { recursive: true, force: true })
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

    const stop = vi.fn(async () => {})
    const sandboxManager = { stop }
    const unregisterSessionReverseIndex = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

    const deps = {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger,
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
        unregisterSessionReverseIndex,
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(),
        clearLoopTimers: noopFn,
      },
      sandboxManager,
      workspaceStatusRegistry: {
        recordEvent: vi.fn(),
        getStatus: vi.fn().mockReturnValue('connected' as const),
        awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
        primeFromSnapshot: vi.fn(),
      },
    }

    return { deps, loopService, sandboxManager, unregisterSessionReverseIndex, logger }
  }

  async function attach(deps: ReturnType<typeof buildDeps>['deps'], sendInitialPrompt = true) {
    const { attachLoopToSession } = await import('../../src/services/execution')
    return attachLoopToSession(
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
        sendInitialPrompt,
      },
    )
  }

  test('rollback calls sandboxManager.stop with the loop name and still unregisters state', async () => {
    const { waitForSandboxReady } = await import('../../src/utils/sandbox-ready')
    vi.mocked(waitForSandboxReady).mockResolvedValue({ ready: false, reason: 'timeout' })

    const { deps, loopService, sandboxManager, unregisterSessionReverseIndex } = buildDeps()
    const deleteState = vi.spyOn(loopService, 'deleteState')

    const result = await attach(deps)

    expect(sandboxManager.stop).toHaveBeenCalledWith('msb-loop')
    expect(unregisterSessionReverseIndex).toHaveBeenCalledWith('sess_msb')
    expect(deleteState).toHaveBeenCalledWith('msb-loop')
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('a rejected stop (unknown-state throw) is logged and does not mask the not-ready failure', async () => {
    const { waitForSandboxReady } = await import('../../src/utils/sandbox-ready')
    vi.mocked(waitForSandboxReady).mockResolvedValue({ ready: false, reason: 'timeout' })

    const { deps, loopService, sandboxManager, unregisterSessionReverseIndex, logger } = buildDeps()
    const deleteState = vi.spyOn(loopService, 'deleteState')

    const stopError = new Error('Could not determine whether sandbox forge-msb-loop exists (state query failed); refusing to remove')
    vi.mocked(sandboxManager.stop).mockRejectedValue(stopError)

    const result = await attach(deps)

    expect(sandboxManager.stop).toHaveBeenCalledWith('msb-loop')
    expect(logger.error).toHaveBeenCalledWith('attachLoopToSession: failed to remove sandbox container after timeout', stopError)
    expect(unregisterSessionReverseIndex).toHaveBeenCalledWith('sess_msb')
    expect(deleteState).toHaveBeenCalledWith('msb-loop')
    expect(result).toEqual({ ok: false, code: 'internal_error', message: 'Sandbox not ready: timeout' })
  })

  test('does not stop the sandbox when it is ready', async () => {
    const { waitForSandboxReady } = await import('../../src/utils/sandbox-ready')
    vi.mocked(waitForSandboxReady).mockResolvedValue({ ready: true, containerName: 'forge-msb-loop' })

    const { deps, sandboxManager } = buildDeps()

    const result = await attach(deps, false)

    expect(sandboxManager.stop).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, loopName: 'msb-loop' })
  })
})
