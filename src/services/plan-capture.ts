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

/** The only two outcomes a direct write can produce. */
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

/**
 * The single write path into a session-scoped `plans` row. Sanitizes
 * project-dir prefixes from the plan text and no-ops when the sanitized
 * content already matches the stored row. All session-scoped plan writes —
 * marked-plan capture, latest-plan capture, and the `plan-write` tool — go
 * through here so sanitization and dedupe cannot diverge.
 */
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

/**
 * Maps an `inspectLatestMarkedPlan` outcome onto a capture result, persisting
 * the plan when one was found. Shared by both message-scanning capture paths so
 * their logging and status mapping cannot diverge.
 */
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
      return { status: 'found', messages: messages as unknown as PlanCaptureMessage[] }
    }

    return { status: 'missing' }
  } catch (error) {
    deps.logger.error(`plan-capture: failed to read messages for ${sessionID}`, error as Error)
    return { status: 'read-failed', error }
  }
}

/**
 * Legacy latest-message capture. Scans recent assistant messages for the
 * newest marked plan and persists it regardless of which message currently
 * completing. Used only when no session-scoped `plans` row exists yet (e.g.
 * `execute-plan` with no inline plan and no prior `plan-write`, or the group
 * orchestrator capturing an architect's freshly emitted plan). Storage is the
 * plan of record; new writes go through marked-plan streaming capture or
 * `plan-write` so this path must not be invoked after a row exists.
 */
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

  // Storage revalidation: the caller invokes this legacy path only when no
  // row existed at check time, but `session.messages` is awaited above and a
  // concurrent `plan-write` (or completion hook) may have authored a newer
  // session row during that await. Storage is the plan of record, so never
  // replay an older marked assistant message over it. Return `already-current`
  // so the caller still proceeds against the stored row.
  const existing = deps.plansRepo.getForSession(deps.projectId, sessionID)
  if (existing) {
    deps.logger.log(
      `plan-capture: session row appeared during message read for ${sessionID}; preserving stored plan`,
    )
    return { status: 'already-current', planText: existing.content }
  }

  return resultForInspection(deps, sessionID, inspectLatestMarkedPlan(read.messages))
}

/**
 * Resolves the plan of record for a session: the stored `plans` row when one
 * exists, else a legacy marked-message capture. The single implementation of
 * "storage wins, chat is the fallback" for every server-side consumer, so the
 * precedence rule and its post-await race handling live in one place.
 *
 * Checking the row before reading messages also skips the `session.messages`
 * round trip entirely in the common `plan-write` case. The second check covers
 * a read failure, where `captureLatestPlanForSession` returns before its own
 * revalidation.
 */
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
