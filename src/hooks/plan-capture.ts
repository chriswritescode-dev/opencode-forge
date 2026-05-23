import type { ToolContext } from '../tools/types'
import { captureLatestPlanForSession, captureMarkedPlanTextForSession } from '../services/plan-capture'
import { PLAN_END_MARKER, PLAN_START_MARKER } from '../utils/marked-plan-parser'

const MESSAGE_PART_UPDATED_EVENT = 'message.part.updated'
const MESSAGE_UPDATED_EVENT = 'message.updated'

interface MessagePartUpdatedEvent {
  type: typeof MESSAGE_PART_UPDATED_EVENT
  properties?: { sessionID?: string; part?: { type?: string; text?: string; messageID?: string; id?: string } }
}

interface MessageUpdatedEvent {
  type: typeof MESSAGE_UPDATED_EVENT
  properties?: { sessionID?: string; info?: { id?: string; role?: string; time?: { created?: number; completed?: number } } }
}

type PlanCaptureEvent = MessagePartUpdatedEvent | MessageUpdatedEvent | { type: string; properties?: Record<string, unknown> }

function isMessagePartUpdatedEvent(event: PlanCaptureEvent): event is MessagePartUpdatedEvent {
  return event.type === MESSAGE_PART_UPDATED_EVENT
}

function isMessageUpdatedEvent(event: PlanCaptureEvent): event is MessageUpdatedEvent {
  return event.type === MESSAGE_UPDATED_EVENT
}

export function createPlanCaptureEventHook(ctx: ToolContext) {
  const { v2, input: { client }, logger, plansRepo, projectId, directory } = ctx

  function logCaptureError(sessionID: string, error: unknown) {
    logger.error(`plan-capture: hook failed for session ${sessionID}`, error as Error)
  }

  async function handleStreamingPart(event: MessagePartUpdatedEvent) {
    const sessionID = event.properties?.sessionID
    const part = event.properties?.part
    if (!sessionID || part?.type !== 'text' || !part.text) return
    if (!part.text.includes(PLAN_START_MARKER)) return
    if (!part.text.includes(PLAN_END_MARKER)) return

    try {
      const result = captureMarkedPlanTextForSession(
        { plansRepo, projectId, directory, logger },
        sessionID,
        part.text,
        part.messageID
      )

      if (result.status === 'captured') {
        logger.log(`plan-capture: captured marked plan from message part for session ${sessionID}`)
      } else if (result.status === 'invalid') {
        logger.log(`plan-capture: streaming branch saw invalid plan for session ${sessionID}: ${result.reason}`)
      }
    } catch (error) {
      logCaptureError(sessionID, error)
    }
  }

  async function handleAssistantMessageCompleted(event: MessageUpdatedEvent) {
    const sessionID = event.properties?.sessionID
    const info = event.properties?.info

    if (!sessionID || info?.role !== 'assistant' || typeof info?.time?.completed !== 'number') return

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
      logCaptureError(sessionID, error)
    }
  }

  return async (eventInput: { event: PlanCaptureEvent }) => {
    const event = eventInput.event
    if (!event) return

    if (isMessagePartUpdatedEvent(event)) {
      await handleStreamingPart(event)
      return
    }

    if (isMessageUpdatedEvent(event)) {
      await handleAssistantMessageCompleted(event)
      return
    }
  }
}
