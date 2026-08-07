import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { SANDBOX_CONTEXT_NOTE } from '../sandbox/context'

export interface CreateSandboxMessageHookDeps {
  /**
   * The unified loop-first sandbox resolver — the same one that routes bash, glob, and grep.
   * Reusing it is what keeps the note truthful: it is added exactly when tool calls are actually
   * routed into a container, and it inherits loop-first precedence for free (an active
   * worktree-only loop forces host and gets no note even when a host sandbox is toggled on).
   */
  resolveSandboxForSession(sessionID: string): Promise<SandboxContext | null>
  logger: Logger
}

type SystemTransformInput = { sessionID?: string }
type SystemTransformOutput = { system: string[] }

/**
 * Appends the sandbox context note (container caveat + review focus) to the system prompt of any
 * session whose tool calls run in a container: sandbox loops, their Task-tool subagents, and
 * sessions with the host sandbox toggled on. Subagents otherwise never receive this guidance
 * because they don't see the loop/audit prompt body where it used to live, and a host-sandbox
 * session has no prompt body at all.
 *
 * This uses `experimental.chat.system.transform` rather than `chat.message` because a loop is
 * driven entirely by programmatic `promptAsync` calls (and subagents via the Task tool) — there is
 * no human user turn, so `chat.message` never fires. The system transform runs before every LLM
 * request for a session and exposes the `sessionID`, so it reliably reaches loop and subagent
 * sessions.
 *
 * Resolution is deliberately not fail-closed: the note is informational, so an unavailable
 * container drops the note rather than blocking the request.
 */
export function createSandboxMessageHook(deps: CreateSandboxMessageHookDeps) {
  const { resolveSandboxForSession, logger } = deps

  return async (input: SystemTransformInput, output: SystemTransformOutput): Promise<void> => {
    const sessionID = input?.sessionID
    if (!sessionID || !Array.isArray(output?.system)) return

    let sandbox: SandboxContext | null
    try {
      sandbox = await resolveSandboxForSession(sessionID)
    } catch (err) {
      logger.error(`[sandbox-message] failed to resolve sandbox for session=${sessionID}`, err)
      return
    }
    if (!sandbox) return

    output.system.push(SANDBOX_CONTEXT_NOTE)
  }
}
