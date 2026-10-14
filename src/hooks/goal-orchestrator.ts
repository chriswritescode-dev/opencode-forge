import type { GoalsRepo } from '../storage/repos/goals-repo'
import type { GoalOrchestrator } from '../services/goal-orchestrator'
import type { Logger } from '../types'

export interface GoalPlannerEventHookDeps {
  orchestrator: GoalOrchestrator
  goalsRepo: GoalsRepo
  projectId: string
  logger: Logger
}

function readSessionErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: unknown }).data
    if (typeof data === 'object' && data !== null) {
      const message = (data as { message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) return message
    }
  }
  return 'unknown error'
}

/**
 * Event hook that routes a chunk planner session's idle event to the goal
 * orchestrator. Ownership is proven by the persisted planner-session row, so an
 * unrelated session's idle is ignored. A premature idle needs no guard here:
 * `onPlannerIdle` itself stays in planning when there is neither assistant text
 * nor a stored plan yet. A normalized `session.error` for the same session (a
 * provider failure, or an interrupted/aborted execution) pauses the goal through
 * `onPlannerError`; the later idle that follows it finds no planning chunk and is
 * a no-op.
 */
export function createGoalPlannerEventHook(deps: GoalPlannerEventHookDeps) {
  const { orchestrator, goalsRepo, projectId, logger } = deps

  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    const event = eventInput.event
    if (!event) return

    if (event.type === 'session.error') {
      const sessionId = event.properties?.sessionID as string | undefined
      if (!sessionId) return
      if (!goalsRepo.getChunkByPlannerSession(projectId, sessionId)) return

      try {
        await orchestrator.onPlannerError(sessionId, readSessionErrorMessage(event.properties?.error))
      } catch (err) {
        logger.error(`goal-orchestrator-hook: error handling planner session error for ${sessionId}:`, err as Error)
      }
      return
    }

    if (event.type !== 'session.status') return

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
