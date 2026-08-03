import { isAbsolute } from 'path'
import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { executeSandboxGlob, executeSandboxGrep } from '../sandbox/exec-fs'
import { isInsideAnyMount } from '../sandbox/path'

interface SandboxToolHookDeps {
  resolveSandboxForSession: (sessionID: string, opts?: { throwOnRestoreError?: boolean }) => Promise<SandboxContext | null>
  logger: Logger
}

const pendingResults = new Map<string, { result: string; storedAt: number }>()

const STALE_THRESHOLD_MS = 5 * 60 * 1000

export function createSandboxToolBeforeHook(deps: SandboxToolHookDeps): Hooks['tool.execute.before'] {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
    output: { args: any },
  ) => {
    // This hook only intercepts search tools. Return before any resolution so a fail-closed
    // resolver error can never block native file or management tools (`read`, `edit`, `write`,
    // bash, etc.), preserving the shell + search isolation scope.
    if (input.tool !== 'glob' && input.tool !== 'grep') return

    // Request fail-closed resolution exactly as bash does: when an acknowledged sandbox cannot be
    // restored (or the selected session's start failed), the resolver throws and the tool call
    // fails rather than silently searching the host checkout.
    const sandbox = await deps.resolveSandboxForSession(input.sessionID, { throwOnRestoreError: true })
    if (!sandbox) {
      deps.logger.debug(`[sandbox-hook] no sandbox for session ${input.sessionID} tool=${input.tool}`)
      return
    }

    const { runtime, containerName, mounts } = sandbox

    const requestedPath = output.args?.path
    if (
      (input.tool === 'glob' || input.tool === 'grep') &&
      typeof requestedPath === 'string' &&
      isAbsolute(requestedPath) &&
      !isInsideAnyMount(requestedPath, mounts)
    ) {
      // Fail closed: an absolute search path outside the sandbox mounts must not silently fall
      // back to host execution, which would violate the shell + search isolation scope. Throwing
      // blocks the search rather than running it on the host.
      throw new Error(`Refusing to run ${input.tool} outside the sandbox workspace mount: ${requestedPath}`)
    }

    if (input.tool === 'glob') {
      const args = output.args
      deps.logger.log(`[sandbox-hook] intercepting glob: pattern=${args.pattern}, path=${args.path}`)

      try {
        const result = await executeSandboxGlob(
          { runtime, containerName, hostDir: sandbox.hostDir, envFile: sandbox.envFile },
          args.pattern,
          args.path,
        )
        pendingResults.set(input.callID, { result, storedAt: Date.now() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.logger.log(`[sandbox-hook] glob failed for callID ${input.callID}: ${message}`)
        pendingResults.set(input.callID, { result: `Glob failed: ${message}`, storedAt: Date.now() })
      }
      return
    }

    if (input.tool === 'grep') {
      const args = output.args
      deps.logger.log(`[sandbox-hook] intercepting grep: pattern=${args.pattern}, path=${args.path}, include=${args.include}`)

      try {
        const result = await executeSandboxGrep(
          { runtime, containerName, hostDir: sandbox.hostDir, envFile: sandbox.envFile },
          args.pattern,
          { path: args.path, include: args.include },
        )
        pendingResults.set(input.callID, { result, storedAt: Date.now() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.logger.log(`[sandbox-hook] grep failed for callID ${input.callID}: ${message}`)
        pendingResults.set(input.callID, { result: `Grep failed: ${message}`, storedAt: Date.now() })
      }
      return
    }
  }
}

export function createSandboxToolAfterHook(deps: SandboxToolHookDeps): Hooks['tool.execute.after'] {
  return async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
    input: { tool: string; sessionID: string; callID: string; args: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
    output: { title: string; output: string; metadata: any },
  ) => {
    if (input.tool !== 'glob' && input.tool !== 'grep') return

    const now = Date.now()
    for (const [key, entry] of pendingResults) {
      if (now - entry.storedAt > STALE_THRESHOLD_MS) {
        pendingResults.delete(key)
      }
    }

    const entry = pendingResults.get(input.callID)
    if (entry === undefined) return

    pendingResults.delete(input.callID)
    deps.logger.log(`[sandbox-hook] replacing ${input.tool} output for callID ${input.callID}`)
    output.output = entry.result
  }
}
