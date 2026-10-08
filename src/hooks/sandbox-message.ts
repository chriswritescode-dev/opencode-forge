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
 * Merges environment guidance into the system prompt when a session runs in a container and after
 * it returns to the host. This covers sandbox loops, their Task-tool subagents, and sessions with
 * the host sandbox toggled on.
 *
 * Both notes lead with the concrete environment change, probed from the two environments
 * themselves rather than described in the abstract, and both repeat on every request so they stand
 * for as long as the state they describe: host -> container while sandboxed, and container -> host
 * from the request that observes the toggle going off until the sandbox is re-enabled (the host is
 * probed once, on that first request). The container note also carries the sandbox's known
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
   * Session -> either the sandbox it was in on its previous request and that container's
   * descriptor (so the off note can name it and a restart or recreation is reported once), or the
   * off note it received on returning to the host, repeated until the sandbox is re-enabled.
   */
  const trackedSessions = new LRUCache<
    { sandbox: SandboxContext; env: string | null } | { offNote: string }
  >(SANDBOX_TRACKED_SESSION_LIMIT)

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
      const previous = trackedSessions.get(sessionID)
      const change = detectSandboxChange(previous && 'sandbox' in previous ? previous.sandbox : undefined, sandbox)
      trackedSessions.set(sessionID, { sandbox, env: containerEnv })
      applySandboxSystemNote(
        output.system,
        buildSandboxContextNote({ from: hostEnv, to: containerEnv }, { settings: sandbox.settings, change }),
      )
      return
    }

    const tracked = trackedSessions.get(sessionID)
    if (!tracked) {
      applySandboxSystemNote(output.system, null)
      return
    }
    if ('offNote' in tracked) {
      applySandboxSystemNote(output.system, tracked.offNote)
      return
    }
    const offNote = buildSandboxOffNote({ from: tracked.env, to: probe ? await probe.describeHost() : null })
    trackedSessions.set(sessionID, { offNote })
    applySandboxSystemNote(output.system, offNote)
  }
}
