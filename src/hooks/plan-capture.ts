import type { ToolContext } from '../tools/types'
import { captureLatestPlanForSession, captureMarkedPlanTextForSession, capturePastedPlanForSession } from '../services/plan-capture'
import { PLAN_END_MARKER, PLAN_START_MARKER } from '../utils/marked-plan-parser'
import { PLAN_EXECUTION_LABELS } from '../utils/plan-execution'

const MESSAGE_PART_UPDATED_EVENT = 'message.part.updated'
const MESSAGE_UPDATED_EVENT = 'message.updated'

interface MessagePartUpdatedEvent {
  type: typeof MESSAGE_PART_UPDATED_EVENT
  properties?: { sessionID?: string; part?: { type?: string; text?: string; messageID?: string; id?: string } }
}

interface MessageUpdatedEvent {
  type: typeof MESSAGE_UPDATED_EVENT
  properties?: { sessionID?: string; info?: { id?: string; role?: string; agent?: string; time?: { created?: number; completed?: number } } }
}

type PlanCaptureEvent = MessagePartUpdatedEvent | MessageUpdatedEvent | { type: string; properties?: Record<string, unknown> }

function isMessagePartUpdatedEvent(event: PlanCaptureEvent): event is MessagePartUpdatedEvent {
  return event.type === MESSAGE_PART_UPDATED_EVENT
}

function isMessageUpdatedEvent(event: PlanCaptureEvent): event is MessageUpdatedEvent {
  return event.type === MESSAGE_UPDATED_EVENT
}

function hashPlanText(planText: string): string {
  let hash = 5381
  for (let i = 0; i < planText.length; i += 1) {
    hash = ((hash << 5) + hash) ^ planText.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

const promptedPlanKeys = new Set<string>()
// Tracks plans pre-captured by the streaming branch so the completion handler
// can distinguish "already current because streaming just wrote it" from
// "already current from prior storage" and prompt accordingly.
const streamingCapturedPlanKeys = new Set<string>()

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
    // from being captured during loops and avoids bypassing the loop guard
    // in handleUserMessageCompleted)
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

      if (result.status === 'captured') {
        logger.log(`plan-capture: captured marked plan from message part for session ${sessionID}`)
        const planKey = `${sessionID}:${hashPlanText(result.planText)}`
        streamingCapturedPlanKeys.add(planKey)
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

    if (!sessionID || info?.role !== 'user' || typeof info?.time?.completed !== 'number') return

    // Skip if session has an active loop
    const loop = ctx.loop
    if (loop) {
      const loopName = loop.resolveLoopName(sessionID)
      const state = loopName ? loop.getActiveState(loopName) : null
      if (state?.active) {
        logger.log(`plan-capture: session ${sessionID} has active loop, skipping user paste capture`)
        return
      }
    }

    try {
      const result = await capturePastedPlanForSession(
        { v2, client, plansRepo, projectId, directory, logger },
        sessionID
      )

      if (result.status === 'captured') {
        logger.log(`plan-capture: captured pasted plan from user message for session ${sessionID}`)
        await triggerPasteApprovalQuestion(sessionID, result.planText)
      } else if (result.status === 'already-current') {
        const planKey = `${sessionID}:${hashPlanText(result.planText)}`
        if (streamingCapturedPlanKeys.has(planKey)) {
          // Streaming branch pre-captured this plan but did not prompt;
          // treat as freshly captured and prompt now.
          streamingCapturedPlanKeys.delete(planKey)
          logger.log(`plan-capture: streaming pre-captured plan for session ${sessionID}, prompting now`)
          await triggerPasteApprovalQuestion(sessionID, result.planText)
        } else {
          // Plan was already stored prior to this event flow — skip prompt
          // to avoid re-prompting the same plan on every user message.
          logger.log(`plan-capture: plan already stored for session ${sessionID}, skipping prompt`)
        }
      } else if (result.status === 'invalid') {
        logger.log(`plan-capture: invalid pasted plan in session ${sessionID}: ${result.reason}`)
        ctx.v2.tui?.publish({
          directory: ctx.directory,
          body: {
            type: 'tui.toast.show',
            properties: {
              title: 'Forge plan execution',
              message: `Invalid pasted plan markers: ${result.reason}`,
              variant: 'error',
              duration: 5000,
            },
          },
        }).catch((err: unknown) => {
          logger.error('plan-capture: failed to publish error toast', err as Error)
        })
      }
      // already-current, not-found, read-failed: return without prompting
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
    promptedPlanKeys.add(planKey)

    const optionsList = PLAN_EXECUTION_LABELS.join(', ')
    const prompt = `A user pasted an implementation plan into this session. The plan has already been captured. Do NOT re-plan or modify it. Immediately call the \`question\` tool exactly once to ask how to execute it, with these three options as labels: ${optionsList}. Ask only this question and take no other action.`

    const legacyClient = ctx.input?.client
    if (legacyClient) {
      try {
        logger.log(`plan-capture: prompting architect via legacy client for ${sessionID}`)
        const legacyResult = await legacyClient.session.promptAsync({
          path: { id: sessionID },
          query: { directory: ctx.directory },
          body: {
            agent: 'architect',
            parts: [{ type: 'text' as const, text: prompt }],
          },
        } as Parameters<typeof legacyClient.session.promptAsync>[0]) as unknown as Promise<{ data?: unknown; error?: unknown }>
        if (!(legacyResult as { error?: unknown })?.error) {
          logger.log(`plan-capture: architect prompted via legacy client for ${sessionID}`)
          return
        }
        logger.error('plan-capture: legacy promptAsync returned error', (legacyResult as { error?: unknown }).error)
      } catch (err) {
        logger.error('plan-capture: legacy promptAsync threw', err)
      }
    }

    // Fallback to v2
    try {
      logger.log(`plan-capture: falling back to v2 promptAsync for ${sessionID}`)
      const v2Result = await v2.session.promptAsync({
        sessionID,
        directory: ctx.directory,
        agent: 'architect',
        parts: [{ type: 'text' as const, text: prompt }],
      })
      if ((v2Result as { error?: unknown })?.error) {
        logger.error('plan-capture: v2 promptAsync returned error', (v2Result as { error?: unknown }).error)
        return
      }
      logger.log(`plan-capture: architect prompted via v2 for ${sessionID}`)
    } catch (err) {
      logger.error('plan-capture: v2 promptAsync threw', err)
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
      await handleUserMessageCompleted(event)
      return
    }
  }
}
