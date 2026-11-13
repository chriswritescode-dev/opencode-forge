import type { ForgeClient } from '../client/port'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { Logger } from '../types'
import type { LatestMarkedPlanInspection, PlanCaptureMessage } from '../utils/marked-plan-parser'
import {
  PLAN_CAPTURE_MESSAGE_LIMIT,
  extractMarkedPlan,
  inspectLatestMarkedPlan,
  sanitizePlanPaths,
} from '../utils/marked-plan-parser'

export interface CaptureLatestPlanDeps {
  client: ForgeClient
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

type WriteSessionPlanResult = Extract<CaptureLatestPlanResult, { status: 'captured' | 'already-current' }>

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

export function writeSessionPlanContent(
  deps: CaptureMarkedPlanTextDeps,
  sessionID: string,
  planText: string,
  messageId?: string
): WriteSessionPlanResult {
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

  return writeSessionPlanContent(deps, sessionID, extraction.planText, messageId)
}

function resultForInspection(
  deps: CaptureMarkedPlanTextDeps,
  sessionID: string,
  inspection: LatestMarkedPlanInspection
): CaptureLatestPlanResult {
  if (inspection.status === 'found') {
    return writeSessionPlanContent(deps, sessionID, inspection.planText, inspection.messageId)
  }

  if (inspection.status === 'invalid') {
    deps.logger.log(`plan-capture: invalid marked plan in session ${sessionID}: ${inspection.reason}`)
    return { status: 'invalid', reason: inspection.reason }
  }

  deps.logger.log(`plan-capture: no valid marked plan found in session ${sessionID}`)
  return { status: 'not-found' }
}

async function readRecentMessages(
  deps: Pick<CaptureLatestPlanDeps, 'client' | 'directory' | 'logger'>,
  sessionID: string
): Promise<ReadRecentMessagesResult> {
  try {
    const messages = await deps.client.session.messages({
      sessionID,
      directory: deps.directory,
      limit: PLAN_CAPTURE_MESSAGE_LIMIT,
    })

    if (messages && messages.length > 0) {
      return { status: 'found', messages }
    }

    return { status: 'missing' }
  } catch (cause) {
    deps.logger.error(`plan-capture: failed to read messages for ${sessionID}`, cause)
    return { status: 'read-failed', error: cause }
  }
}

export async function captureLatestPlanForSession(
  deps: CaptureLatestPlanDeps,
  sessionID: string
): Promise<CaptureLatestPlanResult> {
  const read = await readRecentMessages(deps, sessionID)
  if (read.status === 'read-failed') return read
  if (read.status === 'missing') {
    deps.logger.log(`plan-capture: no messages found for session ${sessionID}`)
    return { status: 'not-found' }
  }

  const existing = deps.plansRepo.getForSession(deps.projectId, sessionID)
  if (existing) {
    deps.logger.log(
      `plan-capture: session row appeared during message read for ${sessionID}; preserving stored plan`,
    )
    return { status: 'already-current', planText: existing.content }
  }

  return resultForInspection(deps, sessionID, inspectLatestMarkedPlan(read.messages))
}

export async function resolveSessionPlanOfRecord(
  deps: CaptureLatestPlanDeps,
  sessionID: string
): Promise<boolean> {
  if (deps.plansRepo.getForSession(deps.projectId, sessionID)) return true

  const capture = await captureLatestPlanForSession(deps, sessionID)
  if (capture.status === 'captured' || capture.status === 'already-current') return true

  if (deps.plansRepo.getForSession(deps.projectId, sessionID)) {
    deps.logger.log(`plan-capture: using stored plan for session ${sessionID} (no marked plan in chat)`)
    return true
  }

  return false
}
