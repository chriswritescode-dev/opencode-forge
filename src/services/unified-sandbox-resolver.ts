import type { SandboxContext } from '../sandbox/context'
import type { ResolvedLoop } from './session-loop-resolver'

export interface ResolveSandboxForSessionOpts {
  throwOnRestoreError?: boolean
}

export interface UnifiedSandboxResolverDeps {
  resolveActiveLoopForSession(sessionID: string): Promise<ResolvedLoop | null>
  /** Resolves the loop-owned sandbox context for an active sandbox loop. */
  resolveLoopSandbox(resolved: ResolvedLoop, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  /** Resolves the acknowledged host-session sandbox for a session outside any loop. */
  resolveHostSandbox(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
}

function unavailableLoopError(loopName: string): Error {
  return new Error(`Sandbox container for loop "${loopName}" is unavailable; refusing to run the command on the host.`)
}

/**
 * Bounded revalidation retries. After an asynchronous loop sandbox restoration a loop may have
 * terminated, changed mode, or been replaced; loop membership is re-checked and re-routed up to
 * this many times so a stale loop context is never returned. A loop that keeps changing identity
 * past this cap falls back to the most recently resolved loop context rather than looping forever.
 */
const MAX_REVALIDATION_RETRIES = 4

/**
 * The single loop-first sandbox resolver feeding bash, glob, and grep. Loop resolution always
 * takes precedence: an active sandbox loop owns its sessions; an active non-sandbox loop forces
 * host (a host preference cannot override loop/worktree behavior); only sessions with no active
 * loop consult the acknowledged host-session sandbox.
 *
 * The host fallback is computed asynchronously (parent lookups, container restore), during which
 * a loop can start. Loop membership is therefore revalidated after the deferred host resolution
 * so a command never receives the host-session sandbox for a session that has just joined a loop.
 * Likewise, loop membership is revalidated after every asynchronous loop sandbox restoration so a
 * loop that terminates, changes mode, or is replaced while `ensureRunning` is pending never
 * returns (or recreates) a stale loop container.
 */
export function createUnifiedSandboxResolver(
  deps: UnifiedSandboxResolverDeps,
): (sessionID: string, opts?: ResolveSandboxForSessionOpts) => Promise<SandboxContext | null> {
  /**
   * Resolves and returns the sandbox context for an active sandbox loop, revalidating loop
   * membership after the asynchronous restoration so a stale loop context is never returned.
   */
  async function resolveLoop(
    sessionID: string,
    resolved: ResolvedLoop,
    opts: ResolveSandboxForSessionOpts | undefined,
    depth: number,
  ): Promise<SandboxContext | null> {
    let sandbox: SandboxContext | null = null
    let error: unknown
    try {
      sandbox = await deps.resolveLoopSandbox(resolved, opts)
    } catch (err) {
      error = err
    }
    // Revalidate loop membership after the asynchronous restore for every outcome (restored, null,
    // or rejected). The loop may have terminated, changed mode, or been replaced while
    // `ensureRunning` was pending; loop-first precedence must reflect the current state, never the
    // stale loop captured before the restore.
    const now = await deps.resolveActiveLoopForSession(sessionID)
    if (now?.active && now.sandbox && now.loopName === resolved.loopName) {
      // The same loop is still active: its restored context (or failure) is authoritative.
      if (error !== undefined) throw error
      if (!sandbox && opts?.throwOnRestoreError) throw unavailableLoopError(resolved.loopName)
      return sandbox
    }
    // Loop membership changed (or was lost) during the restore. Re-route to the current state while
    // the retry budget lasts; on exhaustion fail closed rather than return (or recreate) a stale
    // loop container.
    if (depth <= 0) {
      if (now?.active && now.sandbox) throw unavailableLoopError(now.loopName)
      if (error !== undefined) throw error
      throw unavailableLoopError(resolved.loopName)
    }
    if (now?.active && now.sandbox) return resolveLoop(sessionID, now, opts, depth - 1)
    if (now?.active) return null
    return resolveSession(sessionID, opts, depth - 1)
  }

  /**
   * Full loop-first resolution for a session, re-running with a bounded depth when loop membership
   * moves during an asynchronous step.
   */
  async function resolveSession(
    sessionID: string,
    opts: ResolveSandboxForSessionOpts | undefined,
    depth: number,
  ): Promise<SandboxContext | null> {
    const resolved = await deps.resolveActiveLoopForSession(sessionID)
    if (resolved?.active && resolved.sandbox) {
      return resolveLoop(sessionID, resolved, opts, depth)
    }
    if (resolved?.active) return null

    // Resolve the host sandbox, then revalidate loop membership whether the host path succeeds or
    // rejects. A loop may start during the asynchronous host resolution (ensureRunning / parent
    // lookups); loop-first precedence must win even for a host fallback computed before the loop
    // existed, and even when the host resolution itself failed (a stale host error must never
    // override loop-first routing).
    let context: SandboxContext | null
    try {
      context = await deps.resolveHostSandbox(sessionID, opts)
    } catch (err) {
      const now = await deps.resolveActiveLoopForSession(sessionID)
      if (now?.active && now.sandbox) {
        return resolveLoop(sessionID, now, opts, depth)
      }
      if (now?.active) return null
      throw err
    }

    const now = await deps.resolveActiveLoopForSession(sessionID)
    if (now?.active && now.sandbox) {
      return resolveLoop(sessionID, now, opts, depth)
    }
    if (now?.active) return null
    return context
  }

  return (sessionID, opts) => resolveSession(sessionID, opts, MAX_REVALIDATION_RETRIES)
}
