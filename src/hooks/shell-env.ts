import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { SHIM_ENV_CONTAINER, SHIM_ENV_ENV_FILE, SHIM_ENV_HOST_SHELL } from '../sandbox/shell-shim'

export interface ShellEnvHookDeps {
  /** Resolves the sandbox context for a session through the unified loop-first resolver. */
  resolveSandboxForSession: (sessionID: string, opts?: { throwOnRestoreError?: boolean }) => Promise<SandboxContext | null>
  /** The shell the user had configured in opencode before forge pointed `shell` at the shim. */
  getUserConfiguredShell: () => string | undefined
  logger: Logger
}

/**
 * Feeds the sandbox shell shim: for sessions that resolve to a sandbox context (a loop sandbox or
 * an acknowledged host-session sandbox), injects the container name (and env-file path) so the shim
 * routes the command into the microVM via `sbx exec`. Every other session gets no container env, so
 * the shim falls through to the host shell — restoring the user's own configured shell when they had
 * one.
 *
 * Fail-closed: resolution is requested with `{ throwOnRestoreError: true }`, so when an expected
 * sandbox cannot be resolved or restarted the resolver throws (failing the bash call) rather than
 * letting the command silently run on the host.
 */
export function createShellEnvHook(deps: ShellEnvHookDeps): NonNullable<Hooks['shell.env']> {
  return async (input, output) => {
    if (input.sessionID) {
      const sandbox = await deps.resolveSandboxForSession(input.sessionID, { throwOnRestoreError: true })
      if (sandbox) {
        output.env[SHIM_ENV_CONTAINER] = sandbox.containerName
        if (sandbox.envFile) output.env[SHIM_ENV_ENV_FILE] = sandbox.envFile
        return
      }
    }
    const userShell = deps.getUserConfiguredShell()
    if (userShell) output.env[SHIM_ENV_HOST_SHELL] = userShell
  }
}
