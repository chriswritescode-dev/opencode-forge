import type { SandboxContext } from '../sandbox/context'
import type { ResolvedLoop } from './session-loop-resolver'

export interface ResolveSandboxForSessionOpts {
  throwOnRestoreError?: boolean
}

export interface UnifiedSandboxResolverDeps {
  resolveActiveLoopForSession(sessionID: string): Promise<ResolvedLoop | null>
  resolveLoopSandbox(resolved: ResolvedLoop, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  resolveHostSandbox(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
}

function unavailableLoopError(loopName: string): Error {
  return new Error(`Sandbox container for loop "${loopName}" is unavailable; refusing to run the command on the host.`)
}

const MAX_REVALIDATION_RETRIES = 4

export function createUnifiedSandboxResolver(
  deps: UnifiedSandboxResolverDeps,
): (sessionID: string, opts?: ResolveSandboxForSessionOpts) => Promise<SandboxContext | null> {
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
    const now = await deps.resolveActiveLoopForSession(sessionID)
    if (now?.active && now.sandbox && now.loopName === resolved.loopName) {
      if (error !== undefined) throw error
      if (!sandbox && opts?.throwOnRestoreError) throw unavailableLoopError(resolved.loopName)
      return sandbox
    }
    if (depth <= 0) {
      if (now?.active && now.sandbox) throw unavailableLoopError(now.loopName)
      if (error !== undefined) throw error
      throw unavailableLoopError(resolved.loopName)
    }
    if (now?.active && now.sandbox) return resolveLoop(sessionID, now, opts, depth - 1)
    if (now?.active) return null
    return resolveSession(sessionID, opts, depth - 1)
  }

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
