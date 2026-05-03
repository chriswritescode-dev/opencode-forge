import type { ToolContext } from '../tools/types'
import { captureLatestPlanForSession, captureMarkedPlanTextForSession } from '../services/plan-capture'

export function createPlanCaptureEventHook(ctx: ToolContext) {
  const { v2, input: { client }, logger, plansRepo, projectId, directory } = ctx

  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }) => {
    if (eventInput.event?.type === 'message.part.updated') {
      const sessionID = eventInput.event.properties?.sessionID as string | undefined
      const part = eventInput.event.properties?.part as { type?: string; text?: string; messageID?: string } | undefined
      if (!sessionID || part?.type !== 'text' || !part.text) return

      const result = captureMarkedPlanTextForSession(
        { plansRepo, projectId, logger },
        sessionID,
        part.text,
        part.messageID
      )

      if (result.status === 'captured') {
        logger.log(`plan-capture: captured marked plan from message part for session ${sessionID}`)
      }
      return
    }

    if (eventInput.event?.type !== 'session.status') {
      return
    }

    const status = eventInput.event.properties?.status as { type?: string } | undefined
    if (status?.type !== 'idle') {
      return
    }

    const sessionID = eventInput.event.properties?.sessionID as string | undefined
    if (!sessionID) {
      return
    }

    try {
      const result = await captureLatestPlanForSession(
        {
          v2,
          client,
          plansRepo,
          projectId,
          directory,
          logger,
        },
        sessionID
      )

      if (result.status === 'captured') {
        logger.log(`plan-capture: captured marked plan for session ${sessionID}`)
      } else if (result.status === 'already-current') {
        logger.log(`plan-capture: plan unchanged for session ${sessionID}`)
      }
    } catch (error) {
      logger.error(`plan-capture: hook failed for session ${sessionID}`, error as Error)
    }
  }
}
