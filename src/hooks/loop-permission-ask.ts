// Scope decision: this hook always uses buildLoopPermissionRuleset() regardless of session lineage.
// Audit sessions already have their own session-level ruleset applied at session.create time;
// opencode evaluates session-level rules before falling through to permission.ask, so the
// auditor's own mutations are already blocked at the session layer. A child subagent of the
// auditor reaching this hook would receive the loop allow-all, which is acceptable for the
// current threat model. If audit subagent specialization is needed, add a follow-up that
// switches the ruleset based on resolved session lineage.
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import type { Logger } from '../types'
import { buildLoopPermissionRuleset, evaluatePermissionRuleset } from '../constants/loop'

export interface CreateLoopPermissionAskHookDeps {
  sessionLoopResolver: ReturnType<typeof createSessionLoopResolver>
  logger: Logger
}

type AskHookInput = { sessionID: string; type: string; pattern?: string | string[] }
type AskHookOutput = { status: 'ask' | 'deny' | 'allow' }
export type LoopPermissionAskHook = (input: AskHookInput, output: AskHookOutput) => Promise<void>

export function createLoopPermissionAskHook(
  deps: CreateLoopPermissionAskHookDeps,
): LoopPermissionAskHook {
  const { sessionLoopResolver, logger } = deps
  return async (input, output) => {
    if (!input?.sessionID) return

    let resolved: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>>
    try {
      resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
    } catch (err) {
      logger.error(`[loop-permission-ask] resolver threw for session=${input.sessionID}`, err)
      return
    }

    if (!resolved?.active) return

    const patternStr = Array.isArray(input.pattern)
      ? input.pattern[0] ?? ''
      : input.pattern ?? ''

    const decision = evaluatePermissionRuleset(buildLoopPermissionRuleset(), {
      permission: input.type,
      pattern: patternStr,
    })

    if (decision === 'allow' || decision === 'deny') {
      output.status = decision
      logger.log(
        `[loop-permission-ask] session=${input.sessionID} loop=${resolved.loopName} type=${input.type} pattern=${patternStr || 'none'} -> ${decision}`,
      )
    } else {
      logger.log(
        `[loop-permission-ask] session=${input.sessionID} loop=${resolved.loopName} type=${input.type} pattern=${patternStr || 'none'} -> ask (no matching rule)`,
      )
    }
  }
}
