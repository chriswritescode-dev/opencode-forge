import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import type { PluginConfig } from '../../src/types'
import { createForgeExecutionService, type ForgeExecutionRequestContext } from '../../src/services/execution'
import { createTestDb } from '../helpers/test-db'
import { buildExecutionDeps, buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { createFakeForgeClient } from '../helpers/fake-client'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

const ctx: ForgeExecutionRequestContext = { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' }

describe('loop pause and resume execution commands', () => {
  let testDb: ReturnType<typeof createTestDb>
  let db: ReturnType<typeof createTestDb>['db']
  let currentLoop: Loop | null = null

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
  })

  afterEach(() => {
    currentLoop?.clearAllRetryTimeouts()
    currentLoop = null
    testDb.cleanup()
    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
  })

  function setup() {
    const { client } = createFakeForgeClient()
    const runtime = buildLoopRuntime(db, { projectId: PROJECT_ID, client, config: mockConfig })
    currentLoop = runtime.loop
    const service = createForgeExecutionService(buildExecutionDeps(db, {
      projectId: PROJECT_ID,
      client,
      config: mockConfig,
      loop: runtime.loop,
      loopsRepo: runtime.loopsRepo,
      sectionPlansRepo: runtime.sectionPlansRepo,
      reviewFindingsRepo: runtime.reviewFindingsRepo,
    }).deps)
    return { service, ...runtime }
  }

  test('pauses a running loop and resumes it in the same session', async () => {
    const { service, loop, loopsRepo } = setup()
    const state = makeLoopState({ loopName: 'pause-resume-loop', worktree: false })
    loop.start({ state })

    const paused = await service.dispatch(ctx, { type: 'loop.pause', loopName: state.loopName })
    expect(paused).toEqual({
      ok: true,
      data: { operation: 'loop.pause', loopName: state.loopName, status: 'paused', changed: true },
      warnings: undefined,
    })
    expect(loopsRepo.get(PROJECT_ID, state.loopName)!.status).toBe('paused')

    const pausedAgain = await service.dispatch(ctx, { type: 'loop.pause', loopName: state.loopName })
    expect(pausedAgain.ok && pausedAgain.data.changed).toBe(false)

    const resumed = await service.dispatch(ctx, { type: 'loop.resume', loopName: state.loopName })
    expect(resumed).toEqual({
      ok: true,
      data: {
        operation: 'loop.resume',
        loopName: state.loopName,
        status: 'running',
        sessionId: state.sessionId,
        changed: true,
      },
      warnings: undefined,
    })
    expect(loopsRepo.get(PROJECT_ID, state.loopName)!.status).toBe('running')

    const resumedAgain = await service.dispatch(ctx, { type: 'loop.resume', loopName: state.loopName })
    expect(resumedAgain.ok).toBe(true)
    if (!resumedAgain.ok) return
    expect(resumedAgain.data.changed).toBe(false)
    expect(resumedAgain.data.sessionId).toBe(state.sessionId)
  })

  test('returns not_found for an unknown loop name', async () => {
    const { service } = setup()

    const paused = await service.dispatch(ctx, { type: 'loop.pause', loopName: 'no-such-loop' })
    expect(paused).toEqual({
      ok: false,
      error: { code: 'not_found', status: 404, message: 'No loop named "no-such-loop".', details: undefined, candidates: undefined },
    })

    const resumed = await service.dispatch(ctx, { type: 'loop.resume', loopName: 'no-such-loop' })
    expect(resumed).toEqual({
      ok: false,
      error: { code: 'not_found', status: 404, message: 'No loop named "no-such-loop".', details: undefined, candidates: undefined },
    })
  })

  test('returns conflict with the stated message for terminal loops', async () => {
    const { service, loop } = setup()

    const cancelled = makeLoopState({ loopName: 'pause-cancelled', worktree: false })
    loop.start({ state: cancelled })
    await loop.terminate(cancelled.loopName, { kind: 'user_aborted' })

    const paused = await service.dispatch(ctx, { type: 'loop.pause', loopName: cancelled.loopName })
    expect(paused).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        status: 409,
        message: 'Loop "pause-cancelled" has already ended (cancelled); only a running loop can be paused.',
        details: undefined,
        candidates: undefined,
      },
    })

    const completed = makeLoopState({ loopName: 'resume-completed', worktree: false })
    loop.start({ state: completed })
    await loop.terminate(completed.loopName, { kind: 'completed' })

    const resumed = await service.dispatch(ctx, { type: 'loop.resume', loopName: completed.loopName })
    expect(resumed).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        status: 409,
        message: 'Loop "resume-completed" has already ended (completed); only a paused loop can be resumed.',
        details: undefined,
        candidates: undefined,
      },
    })
  })

  test('maps an in-flight phase transition and a runtime failure', async () => {
    const service = createForgeExecutionService(buildExecutionDeps(db, {
      loop: {
        pause: async () => ({ kind: 'in_transition' }),
        resume: async () => ({ kind: 'failed', message: 'sandbox exploded' }),
      },
    }).deps)

    await expect(service.dispatch(ctx, { type: 'loop.pause', loopName: 'busy-loop' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'conflict',
        status: 409,
        message: 'Loop "busy-loop" is between phases; try pausing again shortly.',
        details: undefined,
        candidates: undefined,
      },
    })

    await expect(service.dispatch(ctx, { type: 'loop.resume', loopName: 'broken-loop' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        status: 500,
        message: 'sandbox exploded',
        details: undefined,
        candidates: undefined,
      },
    })
  })

  test('cancels a paused loop through the exact-name selector', async () => {
    const { service, loop, loopService } = setup()
    const state = makeLoopState({ loopName: 'cancel-paused-loop', worktree: false })
    loop.start({ state })
    await loop.pause(state.loopName)

    const cancelled = await service.dispatch(ctx, {
      type: 'loop.cancel',
      selector: { kind: 'exact', name: state.loopName },
    })

    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(cancelled.data.loopName).toBe(state.loopName)
    expect(cancelled.data.sessionId).toBe(state.sessionId)

    const after = loopService.getAnyState(state.loopName)!
    expect(after.status).toBe('cancelled')
    expect(after.terminationReason).toBe('user_aborted')
    expect(after.active).toBe(false)
  })
})
