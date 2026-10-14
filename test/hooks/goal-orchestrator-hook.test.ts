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

function idleEvent(sessionId: string) {
  return { event: { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } } }
}

describe('createGoalPlannerEventHook', () => {
  test('routes a planner session idle to onPlannerIdle', async () => {
    const { hook, orchestrator } = createHarness()

    await hook(idleEvent(PLANNER_SESSION))

    expect(orchestrator.onPlannerIdle).toHaveBeenCalledWith(PLANNER_SESSION)
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
})
