import { describe, test, expect, vi } from 'vitest'
import { createGoalPlannerEventHook } from '../../src/hooks/goal-orchestrator'
import type { GoalsRepo } from '../../src/storage/repos/goals-repo'
import type { GoalOrchestrator } from '../../src/services/goal-orchestrator'
import type { Logger } from '../../src/types'

const PROJECT = 'test-project'
const PLANNER_SESSION = 'planner-session-1'

function createHarness() {
  const goalsRepo = {
    getChunkByPlannerSession: vi.fn((_projectId: string, sessionId: string) =>
      sessionId === PLANNER_SESSION ? { plannerSessionId: PLANNER_SESSION } : null,
    ),
  } as unknown as GoalsRepo

  const orchestrator = {
    onPlannerIdle: vi.fn(async (_sessionId: string) => {}),
    onPlannerError: vi.fn(async (_sessionId: string, _message: string) => {}),
  } as unknown as GoalOrchestrator

  const errors: unknown[] = []
  const logger: Logger = {
    log: () => {},
    error: (_message: string, err?: unknown) => {
      errors.push(err)
    },
    debug: () => {},
  }

  const hook = createGoalPlannerEventHook({ orchestrator, goalsRepo, projectId: PROJECT, logger })
  return { hook, orchestrator, goalsRepo, errors }
}

function idleEvent(sessionId: string, interruptReason?: string) {
  return {
    event: {
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type: 'idle' },
        ...(interruptReason === undefined ? {} : { interruptReason }),
      },
    },
  }
}

function errorEvent(sessionId: string, message = 'provider exploded') {
  return {
    event: {
      type: 'session.error',
      properties: { sessionID: sessionId, error: { name: 'ProviderError', data: { message } } },
    },
  }
}

describe('createGoalPlannerEventHook', () => {
  test('routes a planner session idle to onPlannerIdle', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(idleEvent(PLANNER_SESSION))

    expect(orchestrator.onPlannerIdle).toHaveBeenCalledWith(PLANNER_SESSION)
  })

  test('routes an inactivity-interrupted idle to onPlannerError', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(idleEvent(PLANNER_SESSION, 'inactivity'))

    expect(orchestrator.onPlannerError).toHaveBeenCalledWith(
      PLANNER_SESSION,
      'Planner session was interrupted by OpenCode after 60 minutes without activity',
    )
    expect(orchestrator.onPlannerIdle).not.toHaveBeenCalled()
  })

  test('ignores a superseded idle because a new execution of the session follows', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(idleEvent(PLANNER_SESSION, 'superseded'))

    expect(orchestrator.onPlannerIdle).not.toHaveBeenCalled()
    expect(orchestrator.onPlannerError).not.toHaveBeenCalled()
  })

  test('ignores an idle for a session that is not a planner session', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(idleEvent('some-other-session'))

    expect(orchestrator.onPlannerIdle).not.toHaveBeenCalled()
  })

  test('ignores non-idle statuses and non-status events', async () => {
    const { hook, orchestrator } = createHarness()

    await hook({ event: { type: 'session.status', properties: { sessionID: PLANNER_SESSION, status: { type: 'busy' } } } })
    await hook({ event: { type: 'session.idle', properties: { sessionID: PLANNER_SESSION } } })
    await hook({ event: { type: 'session.status', properties: {} } })

    expect(orchestrator.onPlannerIdle).not.toHaveBeenCalled()
  })

  test('catches and logs an orchestrator failure', async () => {
    const { hook, orchestrator, errors } = createHarness()
    vi.mocked(orchestrator.onPlannerIdle).mockRejectedValue(new Error('boom'))

    await expect(hook(idleEvent(PLANNER_SESSION))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  test('routes a planner session error to onPlannerError with the failure message', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(errorEvent(PLANNER_SESSION, 'provider exploded'))

    expect(orchestrator.onPlannerError).toHaveBeenCalledWith(PLANNER_SESSION, 'provider exploded')
    expect(orchestrator.onPlannerIdle).not.toHaveBeenCalled()
  })

  test('falls back to a default message when the error carries none', async () => {
    const { hook, orchestrator } = createHarness()

    await hook({ event: { type: 'session.error', properties: { sessionID: PLANNER_SESSION, error: { name: 'ProviderError' } } } })

    expect(orchestrator.onPlannerError).toHaveBeenCalledWith(PLANNER_SESSION, 'unknown error')
  })

  test('ignores a session error for a session that is not a planner session', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(errorEvent('some-other-session'))

    expect(orchestrator.onPlannerError).not.toHaveBeenCalled()
  })

  test('ignores a session error with no session id', async () => {
    const { hook, orchestrator } = createHarness()

    await hook({ event: { type: 'session.error', properties: { error: { data: { message: 'boom' } } } } })

    expect(orchestrator.onPlannerError).not.toHaveBeenCalled()
  })

  test('catches and logs an onPlannerError failure', async () => {
    const { hook, orchestrator, errors } = createHarness()
    vi.mocked(orchestrator.onPlannerError).mockRejectedValue(new Error('boom'))

    await expect(hook(errorEvent(PLANNER_SESSION))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
