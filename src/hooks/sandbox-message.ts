import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { buildSandboxContextNote, buildSandboxOffNote, detectSandboxChange } from '../sandbox/context'
import type { EnvironmentProbe } from '../sandbox/env-probe'
import type { ResolveSandboxForSessionOpts } from '../services/unified-sandbox-resolver'
import { LRUCache } from '../utils/lru-cache'

export const SANDBOX_TRACKED_SESSION_LIMIT = 500

export const SANDBOX_BLOCK_OPEN = '<forge-sandbox-context>'
export const SANDBOX_BLOCK_CLOSE = '</forge-sandbox-context>'

function sandboxBlockBounds(entry: string): { start: number; end: number } | null {
  const start = entry.indexOf(SANDBOX_BLOCK_OPEN)
  if (start === -1) return null
  const close = entry.indexOf(SANDBOX_BLOCK_CLOSE, start + SANDBOX_BLOCK_OPEN.length)
  if (close === -1) return null
  return { start, end: close + SANDBOX_BLOCK_CLOSE.length }
}

function applySandboxSystemNote(system: string[], note: string | null): void {
  const index = system.findIndex((entry) => sandboxBlockBounds(entry) !== null)

  if (note === null) {
    if (index === -1) return
    const entry = system[index]!
    const bounds = sandboxBlockBounds(entry)!
    system[index] = entry.slice(0, bounds.start) + entry.slice(bounds.end)
    return
  }

  const block = `${SANDBOX_BLOCK_OPEN}\n${note}\n${SANDBOX_BLOCK_CLOSE}`
  if (index !== -1) {
    const entry = system[index]!
    const bounds = sandboxBlockBounds(entry)!
    system[index] = entry.slice(0, bounds.start) + block + entry.slice(bounds.end)
    return
  }
  if (system.length === 0) {
    system.push(block)
    return
  }
  const last = system.length - 1
  const previous = system[last]!
  system[last] = previous === '' ? block : `${previous}\n\n${block}`
}

export interface CreateSandboxMessageHookDeps {
  /**
   * The unified loop-first sandbox resolver — the same one that routes bash, glob, and grep.
   * Reusing it is what keeps the note truthful: it is added exactly when tool calls are actually
   * routed into a container, and it inherits loop-first precedence for free (an active
   * worktree-only loop forces host and gets no note even when a host sandbox is toggled on).
   */
  resolveSandboxForSession(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  /**
   * Probes the real host and container environments so the note can name what actually changed.
   * Omitted, the notes keep their environment-agnostic text.
   */
  probe?: EnvironmentProbe
  logger: Logger
}

type SystemTransformInput = { sessionID?: string }
type SystemTransformOutput = { system: string[] }

/**
 * Merges environment guidance into the system prompt when a session runs in a container and once
 * when it returns to the host. This covers sandbox loops, their Task-tool subagents, and sessions
 * with the host sandbox toggled on.
 *
 * Both notes lead with the concrete environment change, probed from the two environments
 * themselves rather than described in the abstract: host -> container while sandboxed (repeated on
 * every request, so it stands for as long as the toggle is on) and container -> host on the single
 * request that observes the toggle going off. The container note also carries the sandbox's known
 * CPUs, memory, and LAN access, and on the first request after the same sandbox is restarted
 * (a resize) or recreated (a LAN change, or an off/on toggle between requests) it says so once.
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
  const { resolveSandboxForSession, probe, logger } = deps

  /**
   * Session -> the sandbox it was in on its previous request and that container's descriptor,
   * retained so the off note can name it and a restart or recreation is reported once.
   */
  const sandboxedSessions = new LRUCache<{ sandbox: SandboxContext; env: string | null }>(SANDBOX_TRACKED_SESSION_LIMIT)

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
      const [hostEnv, containerEnv] = await Promise.all([
        probe ? probe.describeHost() : null,
        probe ? probe.describeSandbox(sandbox) : null,
      ])
      const change = detectSandboxChange(sandboxedSessions.get(sessionID)?.sandbox, sandbox)
      sandboxedSessions.set(sessionID, { sandbox, env: containerEnv })
      applySandboxSystemNote(
        output.system,
        buildSandboxContextNote({ from: hostEnv, to: containerEnv }, { settings: sandbox.settings, change }),
      )
      return
    }

    if (!sandboxedSessions.has(sessionID)) {
      applySandboxSystemNote(output.system, null)
      return
    }
    const containerEnv = sandboxedSessions.get(sessionID)?.env ?? null
    sandboxedSessions.delete(sessionID)
    applySandboxSystemNote(
      output.system,
      buildSandboxOffNote({ from: containerEnv, to: probe ? await probe.describeHost() : null }),
    )
  }
}
