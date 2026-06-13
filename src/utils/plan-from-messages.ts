/**
 * TUI helper that fetches the latest marked plan for a session by reading
 * the assistant's chat history over the OpenCode SDK and running the same
 * parser the server uses (`inspectLatestMarkedPlan`).
 *
 * Used by the standalone execution-dialog trigger introduced in Phase D
 * (when the in-TUI plan viewer was removed). Returning `null` covers all
 * non-found cases (network failure, no messages, no marked plan, invalid
 * marked plan) so the caller can toast a single "no plan in current
 * session" message — the precise reason ends up in the log via the
 * provided `debug` callback when supplied.
 */

import type { ForgeClient } from '../client/port'
import {
  inspectLatestMarkedPlan,
  type PlanCaptureMessage,
} from './marked-plan-parser'

export interface FetchLatestPlanForSessionDeps {
  /** Optional logger; receives a single descriptive string per call. */
  debug?: (message: string) => void
  /**
   * Maximum number of recent messages to inspect. The server's
   * `captureLatestPlanForSession` uses 20; keep this in sync so the TUI's
   * view matches the server's capture window.
   */
  limit?: number
}

const DEFAULT_LIMIT = 20

export async function fetchLatestPlanForSession(
  client: ForgeClient,
  sessionID: string,
  directory: string | undefined,
  deps: FetchLatestPlanForSessionDeps = {},
): Promise<string | null> {
  const limit = deps.limit ?? DEFAULT_LIMIT
  const debug = deps.debug ?? (() => {})

  let messages: PlanCaptureMessage[]
  try {
    const data = await client.session.messages({
      sessionID,
      ...(directory ? { directory } : {}),
      limit,
    })
    if (!data || data.length === 0) {
      debug(`fetchLatestPlanForSession: no messages for session ${sessionID}`)
      return null
    }
    messages = data as unknown as PlanCaptureMessage[]
  } catch (err) {
    debug(`fetchLatestPlanForSession: messages threw for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  const inspection = inspectLatestMarkedPlan(messages)
  if (inspection.status === 'found') {
    debug(`fetchLatestPlanForSession: found plan in session ${sessionID} (message ${inspection.messageId ?? 'unknown'})`)
    return inspection.planText
  }
  if (inspection.status === 'invalid') {
    debug(`fetchLatestPlanForSession: invalid marked plan in session ${sessionID}: ${inspection.reason}`)
    return null
  }
  debug(`fetchLatestPlanForSession: no marked plan in session ${sessionID}`)
  return null
}
