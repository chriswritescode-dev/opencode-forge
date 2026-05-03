import type { ToolContext } from '../tools/types'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { Logger } from '../types'
import type { PlanCaptureMessage } from '../utils/plan-capture'
import type { PluginInput } from '@opencode-ai/plugin'
import { extractLatestMarkedPlan, extractMarkedPlan } from '../utils/plan-capture'

export interface CaptureLatestPlanDeps {
  v2: ToolContext['v2']
  client: PluginInput['client']
  plansRepo: PlansRepo
  projectId: string
  directory: string
  logger: Logger
}

export type CaptureLatestPlanResult =
  | { status: 'captured'; planText: string; messageId?: string }
  | { status: 'already-current'; planText: string; messageId?: string }
  | { status: 'not-found' }
  | { status: 'invalid'; reason: string }
  | { status: 'read-failed'; error: unknown }

export interface CaptureMarkedPlanTextDeps {
  plansRepo: PlansRepo
  projectId: string
  logger: Logger
}

function writeCapturedPlanForSession(
  deps: CaptureMarkedPlanTextDeps,
  sessionID: string,
  planText: string,
  messageId?: string
): CaptureLatestPlanResult {
  const existing = deps.plansRepo.getForSession(deps.projectId, sessionID)
  if (existing && existing.content === planText) {
    deps.logger.log(`plan-capture: plan already current for session ${sessionID}`)
    return { status: 'already-current', planText, messageId }
  }

  deps.plansRepo.writeForSession(deps.projectId, sessionID, planText)
  deps.logger.log(`plan-capture: captured plan for session ${sessionID} (${messageId ?? 'unknown message'})`)
  return { status: 'captured', planText, messageId }
}

export function captureMarkedPlanTextForSession(
  deps: CaptureMarkedPlanTextDeps,
  sessionID: string,
  text: string,
  messageId?: string
): CaptureLatestPlanResult {
  const extraction = extractMarkedPlan(text)

  if (!extraction.ok) {
    if (extraction.reason === 'missing' || extraction.reason === 'unterminated') {
      return { status: 'not-found' }
    }
    deps.logger.log(`plan-capture: invalid marked plan in session ${sessionID}: ${extraction.reason}`)
    return { status: 'invalid', reason: extraction.reason }
  }

  return writeCapturedPlanForSession(deps, sessionID, extraction.planText, messageId)
}

export async function captureLatestPlanForSession(
  deps: CaptureLatestPlanDeps,
  sessionID: string
): Promise<CaptureLatestPlanResult> {
  try {
    let messagesResult = await deps.v2.session.messages({
      sessionID,
      directory: deps.directory,
      limit: 20,
    })

    if (messagesResult.error || !messagesResult.data || messagesResult.data.length === 0) {
      try {
        deps.logger.log(`plan-capture: v2 messages empty/error, falling back to legacy client for ${sessionID}`)
        const legacyResult = await deps.client.session.messages({
          path: { id: sessionID },
          query: { directory: deps.directory, limit: 20 },
        })
        if (!legacyResult.error && legacyResult.data) {
          messagesResult = legacyResult as typeof messagesResult
        }
      } catch (fallbackErr) {
        deps.logger.error(`plan-capture: legacy client messages fallback failed for ${sessionID}`, fallbackErr as Error)
      }
    }

    if (!messagesResult.data || messagesResult.data.length === 0) {
      deps.logger.log(`plan-capture: no messages found for session ${sessionID}`)
      return { status: 'not-found' }
    }

    const messages = messagesResult.data as unknown as PlanCaptureMessage[]
    const extraction = extractLatestMarkedPlan(messages)

    if (!extraction) {
      deps.logger.log(`plan-capture: no valid marked plan found in session ${sessionID}`)
      return { status: 'not-found' }
    }

    return writeCapturedPlanForSession(deps, sessionID, extraction.planText, extraction.messageId)
  } catch (error) {
    deps.logger.error(`plan-capture: failed to read messages for session ${sessionID}`, error as Error)
    return { status: 'read-failed', error }
  }
}
