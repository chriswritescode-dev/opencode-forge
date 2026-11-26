import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LoopState } from '../../src/loop/state'
import { __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import type { PluginConfig } from '../../src/types'
import { buildLoopResumePrompt } from '../../src/loop/prompts'
import { createTestDb } from '../helpers/test-db'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { createFakeForgeClient } from '../helpers/fake-client'
import { recordAuditorHandoff, recordCoderHandoff } from '../helpers/loop-handoff'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

describe('loop pause and resume', () => {
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
    if (currentLoop) {
      currentLoop.clearAllRetryTimeouts()
      currentLoop = null
    }
    testDb.cleanup()
    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
    vi.useRealTimers()
  })

  const buildRuntime = (options: Parameters<typeof buildLoopRuntime>[1] = {}) => {
    const runtime = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, ...options })
    currentLoop = runtime.loop
    return runtime
  }

  let loopCounter = 0
  const nextLoopName = (base: string): string => `${base}-${++loopCounter}`

  describe('pause', () => {
    test('pauses a coding loop, aborting the current session and keeping the session, phase and pending handoff', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop, loopService, loopsRepo } = buildRuntime({ client })
      const state = makeLoopState({
        loopName: nextLoopName('pause-coding'),
        phase: 'coding',
        totalSections: 0,
        standbySessionId: 'standby-session-id',
        worktree: false,
      })
      loop.start({ state })
      await recordCoderHandoff(loop, state.sessionId)

      const outcome = await loop.pause(state.loopName)

      expect(outcome).toEqual({ kind: 'paused' })
      const aborts = calls.filter(c => c.method === 'session.abort')
      expect(aborts).toEqual([
        { method: 'session.abort', params: { sessionID: state.sessionId, directory: state.worktreeDir } },
      ])

      const row = loopsRepo.get(PROJECT_ID, state.loopName)!
      expect(row.status).toBe('paused')
      expect(row.currentSessionId).toBe(state.sessionId)
      expect(row.phase).toBe('coding')
      expect(row.iteration).toBe(state.iteration)
      expect(row.currentSectionIndex).toBe(state.currentSectionIndex)
      expect(row.standbySessionId).toBe('standby-session-id')
      expect(loopsRepo.getPendingHandoff(PROJECT_ID, state.loopName)).not.toBeNull()
      expect(loopService.getActiveState(state.loopName)).toBeNull()
    })

    test('returns unchanged for an already paused loop without another abort', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-twice'), worktree: false })
      loop.start({ state })

      await loop.pause(state.loopName)
      const abortCount = calls.filter(c => c.method === 'session.abort').length

      await expect(loop.pause(state.loopName)).resolves.toEqual({ kind: 'unchanged' })
      expect(calls.filter(c => c.method === 'session.abort')).toHaveLength(abortCount)
    })

    test('returns ended for a cancelled loop and for a completed loop', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const cancelled = makeLoopState({ loopName: nextLoopName('pause-cancelled'), worktree: false })
      loop.start({ state: cancelled })
      await loop.terminate(cancelled.loopName, { kind: 'user_aborted' })
      await expect(loop.pause(cancelled.loopName)).resolves.toEqual({ kind: 'ended', status: 'cancelled' })

      const completed = makeLoopState({ loopName: nextLoopName('pause-completed'), worktree: false })
      loop.start({ state: completed })
      await loop.terminate(completed.loopName, { kind: 'completed' })
      await expect(loop.pause(completed.loopName)).resolves.toEqual({ kind: 'ended', status: 'completed' })
    })

    test('returns not_found for an unknown loop name', async () => {
      const { loop } = buildRuntime()
      await expect(loop.pause('no-such-loop')).resolves.toEqual({ kind: 'not_found' })
    })

    test('ignores the abort and idle ticks a pause produces, leaving the loop paused', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-events'), worktree: false })
      loop.start({ state })
      await recordCoderHandoff(loop, state.sessionId)
      await loop.pause(state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const after = loopService.getAnyState(state.loopName)!
      expect(after.status).toBe('paused')
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBeUndefined()
      expect(calls.filter(c => c.method === 'session.promptAsync')).toHaveLength(0)
      expect(calls.filter(c => c.method === 'session.create')).toHaveLength(0)
    })

    test('waits for an in-flight phase transition, then pauses once it is released', async () => {
      const { client } = createFakeForgeClient()
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-hold'), worktree: false })
      loop.start({ state })

      const release = loop.holdUntilFirstPrompt(state)
      const pausePromise = loop.pause(state.loopName)
      await new Promise(resolve => setTimeout(resolve, 400))

      expect(loopService.getAnyState(state.loopName)!.status).toBe('running')

      release()
      await expect(pausePromise).resolves.toEqual({ kind: 'paused' })
      expect(loopService.getAnyState(state.loopName)!.status).toBe('paused')
    })

    test('returns in_transition and leaves the loop running when the transition outlives the wait deadline', async () => {
      vi.useFakeTimers()
      const { client } = createFakeForgeClient()
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-deadline'), worktree: false })
      loop.start({ state })

      const release = loop.holdUntilFirstPrompt(state)
      try {
        const pausePromise = loop.pause(state.loopName)
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(20_000)

        await expect(pausePromise).resolves.toEqual({ kind: 'in_transition' })
        expect(loopService.getAnyState(state.loopName)!.status).toBe('running')
      } finally {
        release()
      }
    })

    test('returns failed and leaves the loop running when the session abort fails', async () => {
      const { client } = createFakeForgeClient({
        session: {
          abort: async () => {
            throw new Error('abort exploded')
          },
        },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-abort-failure'), worktree: false })
      loop.start({ state })

      await expect(loop.pause(state.loopName)).resolves.toEqual({ kind: 'failed', message: 'abort exploded' })
      expect(loopService.getAnyState(state.loopName)!.status).toBe('running')
    })

    test('aborts every remaining busy child session when one child abort fails', async () => {
      const state = makeLoopState({ loopName: nextLoopName('pause-child-abort'), worktree: false })
      const { client, calls } = createFakeForgeClient({
        session: {
          status: async () => ({
            [state.sessionId]: { type: 'busy' },
            'busy-child-one': { type: 'busy' },
            'busy-child-two': { type: 'busy' },
          }) as any,
          abort: async (params: { sessionID: string }) => {
            if (params.sessionID === 'busy-child-one') throw new Error('child abort exploded')
          },
        },
      })
      const { loop, loopService } = buildRuntime({
        client,
        getParentSessionId: async (sessionId) => (
          sessionId === 'busy-child-one' || sessionId === 'busy-child-two' ? state.sessionId : null
        ),
      })
      loop.start({ state })

      await expect(loop.pause(state.loopName)).resolves.toEqual({ kind: 'paused' })

      const aborted = calls
        .filter(c => c.method === 'session.abort')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(aborted).toEqual([state.sessionId, 'busy-child-one', 'busy-child-two'])
      expect(loopService.getAnyState(state.loopName)!.status).toBe('paused')
    })
  })

  describe('resume', () => {
    const pausedAuditState = (loopName: string): LoopState => makeLoopState({
      loopName,
      phase: 'auditing',
      totalSections: 0,
      iteration: 3,
      auditCount: 2,
      worktree: false,
    })

    test('resumes a paused audit in the same session and runs the normal audit path on the next idle', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [] },
          ],
        },
      })
      const { loop, loopService, loopsRepo } = buildRuntime({ client })
      const state = pausedAuditState(nextLoopName('resume-audit'))
      loop.start({ state })
      await loop.pause(state.loopName)

      const outcome = await loop.resume(state.loopName)

      expect(outcome).toEqual({ kind: 'resumed', sessionId: state.sessionId })
      const prompts = calls.filter(c => c.method === 'session.promptAsync')
      expect(prompts).toHaveLength(1)
      const params = prompts[0]!.params as {
        sessionID: string
        agent?: string
        parts: Array<{ text: string }>
      }
      expect(params.sessionID).toBe(state.sessionId)
      expect(params.agent).toBe('auditor-loop')
      expect(params.parts[0]!.text).toBe(buildLoopResumePrompt('auditor'))
      expect(params.parts[0]!.text).toContain('paused and has now resumed')
      expect(params.parts[0]!.text).toContain('`loop-handoff`')
      expect(calls.filter(c => c.method === 'session.create')).toHaveLength(0)

      const row = loopsRepo.get(PROJECT_ID, state.loopName)!
      expect(row.status).toBe('running')
      expect(row.phase).toBe('auditing')
      expect(row.iteration).toBe(3)

      await recordAuditorHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: state.sessionId },
      })
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const after = loopService.getAnyState(state.loopName)!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('completed')
    })

    test('sends the full phase prompt when the session has no messages yet', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [] },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = pausedAuditState(nextLoopName('resume-empty-session'))
      loop.start({ state })
      await loop.pause(state.loopName)

      await loop.resume(state.loopName)

      const prompts = calls.filter(c => c.method === 'session.promptAsync')
      expect(prompts).toHaveLength(1)
      const params = prompts[0]!.params as { parts: Array<{ text: string }> }
      expect(params.parts[0]!.text).toBe(loopService.buildAuditPrompt(state))
    })

    test('returns failed when the resume prompt fails and the loop ends', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [] },
          ],
          promptAsync: async () => {
            throw new Error('prompt failed')
          },
        },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('resume-ends'), phase: 'coding', totalSections: 0, errorCount: 2, worktree: false })
      loop.start({ state })
      await loop.pause(state.loopName)

      const outcome = await loop.resume(state.loopName)

      expect(outcome.kind).toBe('failed')
      expect(loopService.getActiveState(state.loopName)).toBeNull()
    })

    test('returns unchanged for a running loop without sending a prompt', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('resume-running'), worktree: false })
      loop.start({ state })

      await expect(loop.resume(state.loopName)).resolves.toEqual({ kind: 'unchanged', sessionId: state.sessionId })
      expect(calls.filter(c => c.method === 'session.promptAsync')).toHaveLength(0)
    })

    test('ignores the delayed abort of a pause that was resumed before the abort event arrived', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [] },
          ],
        },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('resume-before-abort'), worktree: false })
      loop.start({ state })
      await loop.pause(state.loopName)
      await loop.resume(state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })

      const resumed = loopService.getAnyState(state.loopName)!
      expect(resumed.status).toBe('running')
      expect(resumed.active).toBe(true)
      expect(resumed.terminationReason).toBeUndefined()

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })

      const after = loopService.getAnyState(state.loopName)!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('user_aborted')
    })

    test('does not leak the pause abort marker into a later genuine abort after resume', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [] },
          ],
        },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-abort-marker'), worktree: false })
      loop.start({ state })
      await loop.pause(state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })
      expect(loopService.getAnyState(state.loopName)!.status).toBe('paused')

      await loop.resume(state.loopName)
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })

      const after = loopService.getAnyState(state.loopName)!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('user_aborted')
    })

    test('expires the pause abort marker when no abort event arrives before resume', async () => {
      vi.useFakeTimers()
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [] },
          ],
        },
      })
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('pause-abort-expiry'), worktree: false })
      loop.start({ state })

      await loop.pause(state.loopName)
      await vi.advanceTimersByTimeAsync(15_000)
      await loop.resume(state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'MessageAbortedError' } },
      })

      const after = loopService.getAnyState(state.loopName)!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('user_aborted')
    })

    test('returns not_found for an unknown loop name', async () => {
      const { loop } = buildRuntime()
      await expect(loop.resume('no-such-loop')).resolves.toEqual({ kind: 'not_found' })
    })

    test('returns failed and stays paused when the worktree no longer exists', async () => {
      const { client } = createFakeForgeClient()
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({
        loopName: nextLoopName('resume-missing-worktree'),
        worktree: true,
        worktreeDir: '/tmp/forge-pause-resume-missing-worktree-does-not-exist',
      })
      loop.start({ state })
      await loop.pause(state.loopName)

      const outcome = await loop.resume(state.loopName)

      expect(outcome.kind).toBe('failed')
      expect(outcome.kind === 'failed' ? outcome.message : '').toContain('no longer exists')
      expect(loopService.getAnyState(state.loopName)!.status).toBe('paused')
    })
  })

  describe('cancel', () => {
    test('cancel terminates a paused loop with user_aborted', async () => {
      const { client } = createFakeForgeClient()
      const { loop, loopService } = buildRuntime({ client })
      const state = makeLoopState({ loopName: nextLoopName('cancel-paused'), worktree: false })
      loop.start({ state })
      await loop.pause(state.loopName)

      await loop.cancel(state.loopName)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.active).toBe(false)
      expect(after.terminationReason).toBe('user_aborted')
      expect(after.status).toBe('cancelled')
    })
  })
})
