import type { GoalsRepo } from '../storage/repos/goals-repo'
import type { GoalOrchestrator } from '../services/goal-orchestrator'
import type { Logger } from '../types'

export interface GoalPlannerEventHookDeps {
  orchestrator: GoalOrchestrator
  goalsRepo: GoalsRepo
  projectId: string
  logger: Logger
}

/**
 * Event hook that routes a chunk planner session's idle event to the goal
 * orchestrator. Ownership is proven by the persisted planner-session row, so an
 * unrelated session's idle is ignored. A premature idle needs no guard here:
 * `onPlannerIdle` itself stays in planning when there is neither assistant text
 * nor a stored plan yet.
 */
export function createGoalPlannerEventHook(deps: GoalPlannerEventHookDeps) {
  const { orchestrator, goalsRepo, projectId, logger } = deps

  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    const event = eventInput.event
    if (!event || event.type !== 'session.status') return

    const status = event.properties?.status as { type?: string } | undefined
    const sessionId = event.properties?.sessionID as string | undefined
    if (!sessionId || status?.type !== 'idle') return

    if (!goalsRepo.getChunkByPlannerSession(projectId, sessionId)) return

    try {
      await orchestrator.onPlannerIdle(sessionId)
    } catch (err) {
      logger.error(`goal-orchestrator-hook: error handling idle for planner session ${sessionId}:`, err as Error)
    }
  }
}
