import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { SANDBOX_CONTEXT_NOTE, SANDBOX_OFF_NOTE } from '../sandbox/context'
import type { ResolveSandboxForSessionOpts } from '../services/unified-sandbox-resolver'
import { LRUCache } from '../utils/lru-cache'

export const SANDBOX_TRACKED_SESSION_LIMIT = 500

export interface CreateSandboxMessageHookDeps {
  /**
   * The unified loop-first sandbox resolver — the same one that routes bash, glob, and grep.
   * Reusing it is what keeps the note truthful: it is added exactly when tool calls are actually
   * routed into a container, and it inherits loop-first precedence for free (an active
   * worktree-only loop forces host and gets no note even when a host sandbox is toggled on).
   */
  resolveSandboxForSession(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  logger: Logger
}

type SystemTransformInput = { sessionID?: string }
type SystemTransformOutput = { system: string[] }

/**
 * Appends environment guidance to the system prompt when a session runs in a container and once
 * when it returns to the host. This covers sandbox loops, their Task-tool subagents, and sessions
 * with the host sandbox toggled on.
 *
 * This uses `experimental.chat.system.transform` rather than `chat.message` because a loop is
 * driven entirely by programmatic `promptAsync` calls (and subagents via the Task tool) — there is
 * no human user turn, so `chat.message` never fires. The system transform runs before every LLM
 * request for a session and exposes the `sessionID`, so it reliably reaches loop and subagent
 * sessions.
 *
 * Resolution is fail-closed so an unavailable container is not mistaken for a transition to the
 * host. The note remains informational, so resolution errors do not block the request.
 */
export function createSandboxMessageHook(deps: CreateSandboxMessageHookDeps) {
  const { resolveSandboxForSession, logger } = deps

  const sandboxedSessions = new LRUCache<true>(SANDBOX_TRACKED_SESSION_LIMIT)

  return async (input: SystemTransformInput, output: SystemTransformOutput): Promise<void> => {
    const sessionID = input?.sessionID
    if (!sessionID || !Array.isArray(output?.system)) return

    let sandbox: SandboxContext | null
    try {
      sandbox = await resolveSandboxForSession(sessionID, { throwOnRestoreError: true })
    } catch (err) {
      logger.error(`[sandbox-message] failed to resolve sandbox for session=${sessionID}`, err)
      return
    }

    if (sandbox) {
      sandboxedSessions.set(sessionID, true)
      output.system.push(SANDBOX_CONTEXT_NOTE)
      return
    }

    if (sandboxedSessions.delete(sessionID)) {
      output.system.push(SANDBOX_OFF_NOTE)
    }
  }
}
