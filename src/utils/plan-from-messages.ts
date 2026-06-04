/**
 * TUI helper that fetches the latest plan for a session by reading chat
 * history over the OpenCode SDK and running the same parser the server
 * uses.  Checks assistant messages first (the normal case); falls back to
 * user-pasted plans so that a plan a user pasted into chat input — captured
 * server-side by Phase 3 — is also discoverable when the TUI user triggers
 * {@code forge.plan.execute}.
 *
 * Returning `null` covers all non-found cases (network failure, no messages,
 * no marked plan, invalid marked plan) so the caller can toast a single
 * "no plan in current session" message — the precise reason ends up in the
 * log via the provided `debug` callback when supplied.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  inspectLatestMarkedPlan,
  inspectLatestPastedPlan,
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
  client: OpencodeClient,
  sessionID: string,
  directory: string | undefined,
  deps: FetchLatestPlanForSessionDeps = {},
): Promise<string | null> {
  const limit = deps.limit ?? DEFAULT_LIMIT
  const debug = deps.debug ?? (() => {})

  let messages: PlanCaptureMessage[]
  try {
    const result = await client.session.messages({
      sessionID,
      ...(directory ? { directory } : {}),
      limit,
    })
    if ((result as { error?: unknown }).error) {
      debug(`fetchLatestPlanForSession: messages returned error for session ${sessionID}: ${String((result as { error?: unknown }).error)}`)
      return null
    }
    const data = (result as { data?: unknown[] }).data
    if (!data || data.length === 0) {
      debug(`fetchLatestPlanForSession: no messages for session ${sessionID}`)
      return null
    }
    messages = data as unknown as PlanCaptureMessage[]
  } catch (err) {
    debug(`fetchLatestPlanForSession: messages threw for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  // Prefer assistant-generated plans (the normal case).
  const assistantInspection = inspectLatestMarkedPlan(messages)
  if (assistantInspection.status === 'found') {
    debug(`fetchLatestPlanForSession: found plan in session ${sessionID} (message ${assistantInspection.messageId ?? 'unknown'})`)
    return assistantInspection.planText
  }
  if (assistantInspection.status === 'invalid') {
    debug(`fetchLatestPlanForSession: invalid marked plan in session ${sessionID}: ${assistantInspection.reason}`)
    return null
  }

  // Fallback: check the newest user message for a pasted plan (Phase 3
  // server-side capture writes these into user messages).
  const pastedInspection = inspectLatestPastedPlan(messages)
  if (pastedInspection.status === 'found') {
    debug(`fetchLatestPlanForSession: found pasted plan in session ${sessionID} (message ${pastedInspection.messageId ?? 'unknown'})`)
    return pastedInspection.planText
  }
  if (pastedInspection.status === 'invalid') {
    debug(`fetchLatestPlanForSession: invalid pasted plan in session ${sessionID}: ${pastedInspection.reason}`)
    return null
  }

  debug(`fetchLatestPlanForSession: no marked or pasted plan in session ${sessionID}`)
  return null
}
