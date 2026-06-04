import type { ToolContext } from '../tools/types'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { Logger } from '../types'
import type { PlanCaptureMessage } from '../utils/marked-plan-parser'
import type { PluginInput } from '@opencode-ai/plugin'
import { extractMarkedPlan, inspectLatestMarkedPlan, inspectLatestPastedPlan, sanitizePlanPaths } from '../utils/marked-plan-parser'

export interface CaptureLatestPlanDeps {
  v2: ToolContext['v2']
  client: PluginInput['client']
  plansRepo: PlansRepo
  projectId: string
  directory: string
  logger: Logger
}

type CaptureLatestPlanResult =
  | { status: 'captured'; planText: string; messageId?: string }
  | { status: 'already-current'; planText: string; messageId?: string }
  | { status: 'not-found' }
  | { status: 'invalid'; reason: string }
  | { status: 'read-failed'; error: unknown }

type ReadRecentMessagesResult =
  | { status: 'found'; messages: PlanCaptureMessage[] }
  | { status: 'missing' }
  | { status: 'read-failed'; error: unknown }

interface CaptureMarkedPlanTextDeps {
  plansRepo: PlansRepo
  projectId: string
  directory?: string
  logger: Logger
}

function writeCapturedPlanForSession(
  deps: CaptureMarkedPlanTextDeps,
  sessionID: string,
  planText: string,
  messageId?: string
): CaptureLatestPlanResult {
  const sanitized = sanitizePlanPaths(planText, deps.directory)
  if (sanitized !== planText) {
    deps.logger.log(`plan-capture: stripped project-dir prefix from plan for session ${sessionID}`)
  }
  const existing = deps.plansRepo.getForSession(deps.projectId, sessionID)
  if (existing && existing.content === sanitized) {
    deps.logger.log(`plan-capture: plan already current for session ${sessionID}`)
    return { status: 'already-current', planText: sanitized, messageId }
  }

  deps.plansRepo.writeForSession(deps.projectId, sessionID, sanitized)
  deps.logger.log(`plan-capture: captured plan for session ${sessionID} (${messageId ?? 'unknown message'})`)
  return { status: 'captured', planText: sanitized, messageId }
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

async function readRecentMessages(
  deps: Pick<CaptureLatestPlanDeps, 'v2' | 'client' | 'directory' | 'logger'>,
  sessionID: string
): Promise<ReadRecentMessagesResult> {
  try {
    const messagesResult = await deps.v2.session.messages({
      sessionID,
      directory: deps.directory,
      limit: 20,
    })

    if (!messagesResult.error && messagesResult.data && messagesResult.data.length > 0) {
      return { status: 'found', messages: messagesResult.data as unknown as PlanCaptureMessage[] }
    }

    try {
      deps.logger.log(`plan-capture: v2 messages empty/error, falling back to legacy client for ${sessionID}`)
      const legacyResult = await deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: deps.directory, limit: 20 },
      })
      if (!legacyResult.error && legacyResult.data && legacyResult.data.length > 0) {
        return { status: 'found', messages: legacyResult.data as unknown as PlanCaptureMessage[] }
      }
    } catch (fallbackErr) {
      deps.logger.error(`plan-capture: legacy client messages fallback failed for ${sessionID}`, fallbackErr as Error)
    }

    return { status: 'missing' }
  } catch (error) {
    deps.logger.error(`plan-capture: failed to read messages for ${sessionID}`, error as Error)
    return { status: 'read-failed', error }
  }
}

async function captureInspectedPlanForSession(
  deps: CaptureLatestPlanDeps,
  sessionID: string,
  inspect: (messages: PlanCaptureMessage[]) => ReturnType<typeof inspectLatestMarkedPlan>,
  label: string
): Promise<CaptureLatestPlanResult> {
  const read = await readRecentMessages(deps, sessionID)
  if (read.status === 'read-failed') return read
  if (read.status === 'missing') {
    deps.logger.log(`plan-capture: no messages found for session ${sessionID}`)
    return { status: 'not-found' }
  }

  const inspection = inspect(read.messages)

  if (inspection.status === 'found') {
    return writeCapturedPlanForSession(deps, sessionID, inspection.planText, inspection.messageId)
  }

  if (inspection.status === 'invalid') {
    deps.logger.log(`plan-capture: invalid ${label} plan in session ${sessionID}: ${inspection.reason}`)
    return { status: 'invalid', reason: inspection.reason }
  }

  deps.logger.log(`plan-capture: no valid ${label} plan found in session ${sessionID}`)
  return { status: 'not-found' }
}

export async function captureLatestPlanForSession(
  deps: CaptureLatestPlanDeps,
  sessionID: string
): Promise<CaptureLatestPlanResult> {
  return captureInspectedPlanForSession(deps, sessionID, inspectLatestMarkedPlan, 'marked')
}

export async function capturePastedPlanForSession(
  deps: CaptureLatestPlanDeps,
  sessionID: string
): Promise<CaptureLatestPlanResult> {
  return captureInspectedPlanForSession(deps, sessionID, inspectLatestPastedPlan, 'pasted')
}
