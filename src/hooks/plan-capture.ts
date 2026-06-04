import type { ToolContext } from '../tools/types'
import { captureLatestPlanForSession, captureMarkedPlanTextForSession } from '../services/plan-capture'
import { PLAN_END_MARKER, PLAN_START_MARKER } from '../utils/marked-plan-parser'
import { PLAN_EXECUTION_LABELS } from '../utils/plan-execution'
import { hashPlanText } from '../utils/plan-hash'
import { promptAgentViaClientThenV2 } from '../utils/prompt-agent'

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

const PLAN_KEY_CAP = 1000

// Caps an in-memory map so a long-lived process cannot grow it without bound;
// clearing on overflow only risks an occasional duplicate prompt.
function trackEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size > PLAN_KEY_CAP) map.clear()
  map.set(key, value)
}

// Dedupes architect prompts by `${sessionID}:${planHash}`.
const promptedPlanKeys = new Set<string>()
// Plans captured by the streaming branch, keyed by `${sessionID}:${messageID}`,
// awaiting the message's completion so the (role-aware) completion handler can
// prompt the architect without re-reading the conversation.
const pendingUserPastePlans = new Map<string, string>()

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

    // Skip capture if session has an active loop (prevents user-pasted plans
    // from being captured during loops).
    const loop = ctx.loop
    if (loop) {
      const loopName = loop.resolveLoopName(sessionID)
      const state = loopName ? loop.getActiveState(loopName) : null
      if (state?.active) return
    }

    try {
      const result = captureMarkedPlanTextForSession(
        { plansRepo, projectId, directory, logger },
        sessionID,
        part.text,
        part.messageID
      )

      // Stash freshly captured plans so the completion handler can prompt the
      // architect once it knows the message role (this event carries no role).
      if (result.status === 'captured') {
        logger.log(`plan-capture: captured marked plan from message part for session ${sessionID}`)
        if (part.messageID) {
          trackEntry(pendingUserPastePlans, `${sessionID}:${part.messageID}`, result.planText)
        }
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

  async function handleUserMessageCompleted(event: MessageUpdatedEvent) {
    const sessionID = event.properties?.sessionID
    const info = event.properties?.info

    if (!sessionID || info?.role !== 'user' || typeof info?.time?.completed !== 'number' || !info.id) return

    // The streaming branch already captured any pasted plan and stashed it under
    // this message id. Now that we know the role is `user`, prompt the architect.
    const stashKey = `${sessionID}:${info.id}`
    const planText = pendingUserPastePlans.get(stashKey)
    if (!planText) return
    pendingUserPastePlans.delete(stashKey)

    try {
      logger.log(`plan-capture: user-pasted plan completed for session ${sessionID}, prompting architect`)
      await triggerPasteApprovalQuestion(sessionID, planText)
    } catch (error) {
      logCaptureError(sessionID, error)
    }
  }

  async function triggerPasteApprovalQuestion(sessionID: string, planText: string) {
    const planKey = `${sessionID}:${hashPlanText(planText)}`
    if (promptedPlanKeys.has(planKey)) {
      logger.log(`plan-capture: already prompted for plan ${planKey}, skipping`)
      return
    }
    if (promptedPlanKeys.size > PLAN_KEY_CAP) promptedPlanKeys.clear()
    promptedPlanKeys.add(planKey)

    const optionsList = PLAN_EXECUTION_LABELS.join(', ')
    const prompt = `A user pasted an implementation plan into this session. The plan has already been captured. Do NOT re-plan or modify it. Immediately call the \`question\` tool exactly once to ask how to execute it, with these three options as labels: ${optionsList}. Ask only this question and take no other action.`

    await promptAgentViaClientThenV2(
      { legacyClient: ctx.input?.client, v2, logger, directory: ctx.directory },
      { sessionID, agent: 'architect', prompt }
    )
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
      await handleUserMessageCompleted(event)
      return
    }
  }
}
