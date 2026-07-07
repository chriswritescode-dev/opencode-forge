import type { Logger } from '../types'
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import { SANDBOX_CONTEXT_NOTE } from '../loop/prompts'

export interface CreateSandboxMessageHookDeps {
  sessionLoopResolver: ReturnType<typeof createSessionLoopResolver>
  logger: Logger
}

type SystemTransformInput = { sessionID?: string }
type SystemTransformOutput = { system: string[] }

/**
 * Appends the sandbox context note (container caveat + review focus)
 * to the system prompt of any session that belongs to an active sandbox loop — including
 * subagent sessions spawned via the Task tool, which otherwise never receive this guidance
 * because they don't see the loop/audit prompt body where it used to live.
 *
 * This uses `experimental.chat.system.transform` rather than `chat.message` because the loop
 * is driven entirely by programmatic `promptAsync` calls (and subagents via the Task tool) —
 * there is no human user turn, so `chat.message` never fires. The system transform runs before
 * every LLM request for a session and exposes the `sessionID`, so it reliably reaches loop and
 * subagent sessions.
 *
 * The note is only added when the resolved loop is BOTH active AND sandboxed, so
 * worktree-only loops and non-loop sessions are unaffected.
 */
export function createSandboxMessageHook(deps: CreateSandboxMessageHookDeps) {
  const { sessionLoopResolver, logger } = deps

  return async (input: SystemTransformInput, output: SystemTransformOutput): Promise<void> => {
    const sessionID = input?.sessionID
    if (!sessionID || !Array.isArray(output?.system)) return

    let resolved
    try {
      resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
    } catch (err) {
      logger.error(`[sandbox-message] failed to resolve loop for session=${sessionID}`, err)
      return
    }
    if (!resolved?.active || !resolved.sandbox) return

    output.system.push(SANDBOX_CONTEXT_NOTE)
  }
}
