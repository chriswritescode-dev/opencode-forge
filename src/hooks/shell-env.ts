import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import { resolveSandboxContextForLoop, type SandboxContextManager, type SandboxLoopContextState } from '../sandbox/context'
import { SHIM_ENV_CONTAINER, SHIM_ENV_EXEC_USER, SHIM_ENV_HOST_SHELL } from '../sandbox/shell-shim'

export interface ShellEnvHookDeps {
  resolveActiveLoopForSession: (sessionID: string) => Promise<SandboxLoopContextState | null>
  sandboxManager: SandboxContextManager | null
  /** UID:GID for in-container command execution (matches `docker exec --user`). */
  execUser?: string
  /** The shell the user had configured in opencode before forge pointed `shell` at the shim. */
  getUserConfiguredShell: () => string | undefined
  logger: Logger
}

/**
 * Feeds the sandbox shell shim: for sessions that belong to an active sandbox loop, injects the
 * container name (and exec user) so the shim routes the command into the loop container via
 * `docker exec`. Every other session gets no container env, so the shim falls through to the
 * host shell — restoring the user's own configured shell when they had one.
 *
 * Fail-closed: when the session belongs to an active sandbox loop but the container cannot be
 * resolved or restarted, this throws (failing the bash call) rather than letting the command
 * silently run on the host.
 */
export function createShellEnvHook(deps: ShellEnvHookDeps): NonNullable<Hooks['shell.env']> {
  return async (input, output) => {
    if (input.sessionID) {
      const resolved = await deps.resolveActiveLoopForSession(input.sessionID)
      if (resolved?.active && resolved.sandbox) {
        const sandbox = await resolveSandboxContextForLoop(deps.sandboxManager, resolved, deps.logger, {
          throwOnRestoreError: true,
        })
        if (!sandbox) {
          throw new Error(
            `Sandbox container for loop "${resolved.loopName}" is unavailable; refusing to run the command on the host.`,
          )
        }
        output.env[SHIM_ENV_CONTAINER] = sandbox.containerName
        if (deps.execUser) output.env[SHIM_ENV_EXEC_USER] = deps.execUser
        return
      }
    }
    const userShell = deps.getUserConfiguredShell()
    if (userShell) output.env[SHIM_ENV_HOST_SHELL] = userShell
  }
}
