import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTuiLoopRestartRepo } from '../../src/storage'
import type { TuiLoopRestartDesiredState } from '../../src/storage'
import { createTuiLoopRestartController } from '../../src/services/tui-loop-restart-controller'
import type { TuiLoopRestartRequest, TuiLoopRestartResult } from '../../src/services/tui-loop-restart-controller'
import type { Logger } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { requestTuiLoopRestart } from '../../src/utils/tui-loop-store'

const PROJECT = 'project-a'

const STALE_ERROR = 'restart request expired before it could be applied'

function makeDesired(overrides: Partial<TuiLoopRestartDesiredState> = {}): TuiLoopRestartDesiredState {
  return {
    version: 1,
    revision: 'rev-1',
    loopName: 'loop-1',
    auditorModel: 'model-x',
    auditorVariant: 'variant-y',
    requestedAt: Date.now(),
    ...overrides,
  }
}

async function flushMicrotasks(hops = 12): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve()
}

describe('TuiLoopRestartController', () => {
  let db: Database
  let repo: ReturnType<typeof createTuiLoopRestartRepo>
  let tempDir: string
  let logger: Logger
  let pendingResolvers: Array<(result: TuiLoopRestartResult) => void>
  let restartCalls: TuiLoopRestartRequest[]
  let nextResult: TuiLoopRestartResult | null

  const restart = vi.fn((request: TuiLoopRestartRequest): Promise<TuiLoopRestartResult> => {
    restartCalls.push(request)
    if (nextResult) return Promise.resolve(nextResult)
    let resolve!: (result: TuiLoopRestartResult) => void
    const promise = new Promise<TuiLoopRestartResult>((res) => { resolve = res })
    pendingResolvers.push(resolve)
    return promise
  })

  beforeEach(() => {
    vi.useFakeTimers()
    tempDir = mkdtempSync(join(tmpdir(), 'tui-loop-restart-controller-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    repo = createTuiLoopRestartRepo(db)
    logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
    pendingResolvers = []
    restartCalls = []
    nextResult = null
    restart.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createController(overrides: Partial<{ pollIntervalMs: number; maxRequestAgeMs: number; processingLeaseMs: number; processingHeartbeatMs: number }> = {}) {
    return createTuiLoopRestartController({
      projectId: PROJECT,
      repo,
      restart,
      logger,
      ...overrides,
    })
  }

  function resolvePending(result: TuiLoopRestartResult): void {
    const resolve = pendingResolvers[pendingResolvers.length - 1]
    expect(resolve).toBeDefined()
    resolve(result)
  }

  test('persists a matching applied success for a fresh desired request', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const started = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await started

    expect(restart).toHaveBeenCalledTimes(1)
    expect(restartCalls[0]).toEqual({ loopName: 'loop-1', auditorModel: 'model-x', auditorVariant: 'variant-y' })
    expect(repo.getApplied(PROJECT)).toEqual({
      version: 1,
      revision: 'rev-1',
      status: 'completed',
      ownerId: null,
      sessionId: 'sess-1',
      error: null,
      appliedAt: Date.now(),
    })
  })

  test('persists a matching applied error when restart reports an error', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const started = controller.start()
    resolvePending({ error: 'boom' })
    await started

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toEqual({
      version: 1,
      revision: 'rev-1',
      status: 'completed',
      ownerId: null,
      sessionId: null,
      error: 'boom',
      appliedAt: Date.now(),
    })
  })

  test('retries acknowledgement without repeating a completed restart', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const compareAndSetApplied = vi.spyOn(repo, 'compareAndSetApplied')
    compareAndSetApplied.mockImplementationOnce(() => { throw new Error('write failed') })
    const controller = createController()

    const started = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await started

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'processing' })

    await vi.advanceTimersByTimeAsync(250)

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'completed', sessionId: 'sess-1' })
  })

  test('suppresses duplicate restarts when applied already matches desired', async () => {
    repo.setDesired(PROJECT, makeDesired())
    repo.setApplied(PROJECT, { version: 1, revision: 'rev-1', status: 'completed', ownerId: null, sessionId: 'sess-1', error: null, appliedAt: Date.now() })
    const controller = createController()

    await controller.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(restart).not.toHaveBeenCalled()
    expect(repo.getApplied(PROJECT)?.revision).toBe('rev-1')
  })

  test('expires an abandoned processing claim without repeating the restart', async () => {
    repo.setDesired(PROJECT, makeDesired())
    repo.setApplied(PROJECT, {
      version: 1,
      revision: 'rev-1',
      status: 'processing',
      ownerId: 'dead-owner',
      sessionId: null,
      error: null,
      appliedAt: Date.now() - 1001,
    })
    const controller = createController({ processingLeaseMs: 1000 })

    await controller.start()

    expect(restart).not.toHaveBeenCalled()
    expect(repo.getApplied(PROJECT)).toMatchObject({
      revision: 'rev-1',
      status: 'completed',
      ownerId: null,
      error: 'restart outcome is unknown because its controller stopped before acknowledging completion',
    })
    expect(repo.trySetDesired(PROJECT, makeDesired({ revision: 'rev-2' }))).toBe(true)
  })

  test('heartbeats an active processing claim so another controller cannot expire it', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const activeController = createController({ processingLeaseMs: 50, processingHeartbeatMs: 10 })
    const started = activeController.start()

    await vi.advanceTimersByTimeAsync(100)
    const competingController = createController({ processingLeaseMs: 50, processingHeartbeatMs: 10 })
    await competingController.start()

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'processing', error: null })

    resolvePending({ sessionId: 'sess-1' })
    await started
    await Promise.all([activeController.dispose(), competingController.dispose()])
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'completed', sessionId: 'sess-1' })
  })

  test('rejects stale requests with an applied error without calling restart', async () => {
    repo.setDesired(PROJECT, makeDesired({ requestedAt: Date.now() - 30_001 }))
    const controller = createController()

    await controller.start()
    const appliedAt = Date.now()
    await vi.advanceTimersByTimeAsync(1000)

    expect(restart).not.toHaveBeenCalled()
    expect(repo.getApplied(PROJECT)).toEqual({
      version: 1,
      revision: 'rev-1',
      status: 'completed',
      ownerId: null,
      sessionId: null,
      error: STALE_ERROR,
      appliedAt,
    })
  })

  test('treats a request at exactly the max age as fresh', async () => {
    repo.setDesired(PROJECT, makeDesired({ requestedAt: Date.now() - 30_000 }))
    const controller = createController()

    const started = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await started

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)?.sessionId).toBe('sess-1')
  })

  test('processes a newer desired revision that supersedes an in-flight restart on a subsequent reconciliation', async () => {
    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-1' }))
    const controller = createController()

    const started = controller.start()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restartCalls[0]).toEqual({ loopName: 'loop-1', auditorModel: 'model-x', auditorVariant: 'variant-y' })

    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-2', loopName: 'loop-2' }))

    resolvePending({ sessionId: 'sess-1' })
    await started

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', status: 'processing' })

    await vi.advanceTimersByTimeAsync(250)
    expect(restart).toHaveBeenCalledTimes(2)
    expect(restartCalls[1]).toEqual({ loopName: 'loop-2', auditorModel: 'model-x', auditorVariant: 'variant-y' })

    resolvePending({ sessionId: 'sess-2' })
    await flushMicrotasks()

    expect(repo.getApplied(PROJECT)).toEqual({
      version: 1,
      revision: 'rev-2',
      status: 'completed',
      ownerId: null,
      sessionId: 'sess-2',
      error: null,
      appliedAt: Date.now(),
    })
  })

  test('keeps repeated start single-flight so concurrent starts trigger one restart', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const first = controller.start()
    const second = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await Promise.all([first, second])
    await vi.advanceTimersByTimeAsync(1000)

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)?.sessionId).toBe('sess-1')
  })

  test('atomically claims a request across multiple controllers', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const firstController = createController()
    const secondController = createController()

    const first = firstController.start()
    const second = secondController.start()
    resolvePending({ sessionId: 'sess-1' })
    await Promise.all([first, second])

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'completed', sessionId: 'sess-1' })
    await Promise.all([firstController.dispose(), secondController.dispose()])
  })

  test('start after a completed start does not re-restart a settled revision', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const first = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await first
    await controller.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(restart).toHaveBeenCalledTimes(1)
  })

  test('dispose waits for an in-flight result and prevents later requests', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const started = controller.start()
    const disposing = controller.dispose()
    resolvePending({ sessionId: 'sess-1' })
    await Promise.all([started, disposing])

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', status: 'completed', sessionId: 'sess-1' })

    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-2' }))
    await vi.advanceTimersByTimeAsync(5000)

    expect(restart).toHaveBeenCalledTimes(1)
    expect(repo.getApplied(PROJECT)).toMatchObject({ revision: 'rev-1', status: 'completed' })

    await expect(controller.dispose()).resolves.toBeUndefined()
  })

  test('start after dispose is a no-op', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    await controller.dispose()
    await controller.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(restart).not.toHaveBeenCalled()
    expect(repo.getApplied(PROJECT)).toBeNull()
  })

  test('uses the default 250ms poll interval', async () => {
    repo.setDesired(PROJECT, makeDesired())
    const controller = createController()

    const started = controller.start()
    resolvePending({ sessionId: 'sess-1' })
    await started
    expect(restart).toHaveBeenCalledTimes(1)

    repo.setDesired(PROJECT, makeDesired({ revision: 'rev-2' }))

    await vi.advanceTimersByTimeAsync(249)
    expect(restart).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(restart).toHaveBeenCalledTimes(2)
    resolvePending({ sessionId: 'sess-2' })
    await flushMicrotasks()

    expect(repo.getApplied(PROJECT)?.revision).toBe('rev-2')
  })

  test('uses the default 30s max request age', async () => {
    repo.setDesired(PROJECT, makeDesired({ requestedAt: Date.now() - 30_001 }))
    const controller = createController()

    await controller.start()

    expect(restart).not.toHaveBeenCalled()
    expect(repo.getApplied(PROJECT)?.error).toBe(STALE_ERROR)
  })

  test('acknowledges a TUI request through the shared database', async () => {
    const controller = createController()
    await controller.start()

    const requested = requestTuiLoopRestart(PROJECT, {
      loopName: 'loop-1',
      auditorModel: 'provider/auditor',
      auditorVariant: '',
    }, {
      dbPath: join(tempDir, 'test.db'),
      timeoutMs: 1000,
      pollMs: 10,
    })
    await vi.advanceTimersByTimeAsync(250)
    resolvePending({ sessionId: 'sess-restarted' })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(10)

    await expect(requested).resolves.toMatchObject({ sessionId: 'sess-restarted', error: null })
    expect(restartCalls).toEqual([{
      loopName: 'loop-1',
      auditorModel: 'provider/auditor',
      auditorVariant: '',
    }])
  })

  test('an explicit requester timeout still applies while restart is processing', async () => {
    const controller = createController({ pollIntervalMs: 10 })
    await controller.start()
    const requested = requestTuiLoopRestart(PROJECT, {
      loopName: 'loop-1',
      auditorModel: 'provider/auditor',
      auditorVariant: '',
    }, {
      dbPath: join(tempDir, 'test.db'),
      timeoutMs: 30,
      pollMs: 10,
    })
    const requestedResult = requested.catch(err => err)

    await vi.advanceTimersByTimeAsync(10)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'processing' })
    await vi.advanceTimersByTimeAsync(20)
    await expect(requestedResult).resolves.toMatchObject({ message: expect.stringContaining('restart request may still complete') })

    resolvePending({ sessionId: 'sess-late' })
    await flushMicrotasks()
    await controller.dispose()
  })

  test('a TUI shutdown stops waiting after the restart request is accepted', async () => {
    const abort = new AbortController()
    const controller = createController({ pollIntervalMs: 10 })
    await controller.start()
    const requested = requestTuiLoopRestart(PROJECT, {
      loopName: 'loop-1',
      auditorModel: 'provider/auditor',
      auditorVariant: '',
    }, {
      dbPath: join(tempDir, 'test.db'),
      signal: abort.signal,
    })
    const requestedResult = requested.catch(err => err)

    await vi.advanceTimersByTimeAsync(10)
    expect(repo.getApplied(PROJECT)).toMatchObject({ status: 'processing' })
    abort.abort()
    await expect(requestedResult).resolves.toMatchObject({ message: 'Loop restart request was accepted and may still complete' })

    resolvePending({ sessionId: 'sess-late' })
    await flushMicrotasks()
    await controller.dispose()
  })
})
