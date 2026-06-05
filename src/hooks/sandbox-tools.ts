import { isAbsolute } from 'path'
import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { executeSandboxGlob, executeSandboxGrep } from '../sandbox/exec-fs'
import { isInsideWorkspace } from '../sandbox/path'

interface SandboxToolHookDeps {
  resolveSandboxForSession: (sessionID: string) => Promise<SandboxContext | null>
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
    const sandbox = await deps.resolveSandboxForSession(input.sessionID)
    if (!sandbox) {
      deps.logger.debug(`[sandbox-hook] no sandbox for session ${input.sessionID} tool=${input.tool}`)
      return
    }

    const { docker, containerName, hostDir } = sandbox

    const requestedPath = output.args?.path
    if (
      (input.tool === 'glob' || input.tool === 'grep') &&
      typeof requestedPath === 'string' &&
      isAbsolute(requestedPath) &&
      !isInsideWorkspace(requestedPath, hostDir)
    ) {
      deps.logger.debug(`[sandbox-hook] ${input.tool} path '${requestedPath}' is outside the workspace mount; deferring to host execution`)
      return
    }

    if (input.tool === 'glob') {
      const args = output.args
      deps.logger.log(`[sandbox-hook] intercepting glob: pattern=${args.pattern}, path=${args.path}`)

      try {
        const result = await executeSandboxGlob(
          { docker, containerName, hostDir },
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
          { docker, containerName, hostDir },
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
