import type { ForgeClient } from '../client/port'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { Logger } from '../types'
import type { PlanCaptureMessage } from '../utils/marked-plan-parser'
import { extractMarkedPlan, inspectLatestMarkedPlan, sanitizePlanPaths } from '../utils/marked-plan-parser'

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

  return writeSessionPlanContent(deps, sessionID, extraction.planText, messageId)
}

async function readRecentMessages(
  deps: Pick<CaptureLatestPlanDeps, 'client' | 'directory' | 'logger'>,
  sessionID: string
): Promise<ReadRecentMessagesResult> {
  try {
    const messages = await deps.client.session.messages({
      sessionID,
      directory: deps.directory,
      limit: 20,
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
 * Completion-scoped capture. Persists a marked plan only when the selected
 * message (or split-message end marker) is the assistant message currently
 * completing. A marker-free completion must never replay an older marked
 * response over a newer tool-authored row, so this path skips the write when
 * the inspected plan belongs to a different message.
 *
 * Reads recent messages through `client.session.messages` (best effort) and
 * delegates selection to `inspectLatestMarkedPlan`, then filters by id.
 */
export async function capturePlanForCompletedMessage(
  deps: CaptureLatestPlanDeps,
  sessionID: string,
  completingMessageId: string
): Promise<CaptureLatestPlanResult> {
  // Snapshot the session row before awaiting message retrieval. A concurrent
  // `plan-write`, `plan-edit`, or completion hook can store a newer revision
  // while `session.messages` is pending; storage is the plan of record, so the
  // stale marked message must never overwrite it.
  const snapshot = deps.plansRepo.getForSession(deps.projectId, sessionID)

  const read = await readRecentMessages(deps, sessionID)
  if (read.status === 'read-failed') return read
  if (read.status === 'missing') {
    deps.logger.log(`plan-capture: no messages found for session ${sessionID}`)
    return { status: 'not-found' }
  }

  // Revalidate storage after the await: if a row appeared or changed during
  // message retrieval, preserve it and report the stored plan as current.
  // Compare both content and `updatedAt`: a concurrent `plan-write`/`plan-edit`
  // revision can produce the same content as the snapshot at a newer timestamp
  // (e.g. an A→B→A edit), and a same-millisecond write can produce different
  // content at the same timestamp. Either field differing means storage moved
  // while messages were being read, so the stale marked message must not
  // overwrite it.
  const current = deps.plansRepo.getForSession(deps.projectId, sessionID)
  if (current && (!snapshot || current.content !== snapshot.content || current.updatedAt !== snapshot.updatedAt)) {
    deps.logger.log(
      `plan-capture: session row changed during message read for ${sessionID}; preserving stored plan`,
    )
    return { status: 'already-current', planText: current.content }
  }

  const inspection = inspectLatestMarkedPlan(read.messages)
  const selectedMessageId = inspection.status === 'missing' ? undefined : inspection.messageId

  if (selectedMessageId !== completingMessageId) {
    deps.logger.log(
      `plan-capture: completing message ${completingMessageId} has no marked plan for session ${sessionID}`,
    )
    return { status: 'not-found' }
  }

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

/**
 * Legacy latest-message capture. Scans recent assistant messages for the
 * newest marked plan and persists it regardless of which message currently
 * completing. Used only when no session-scoped `plans` row exists yet (e.g.
 * `execute-plan` with no inline plan and no prior `plan-write`, or the group
 * orchestrator capturing an architect's freshly emitted plan). Storage is the
 * plan of record; new writes go through `capturePlanForCompletedMessage` or
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

  const inspection = inspectLatestMarkedPlan(read.messages)

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
