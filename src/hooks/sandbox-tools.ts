import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { createLoopService } from '../services/loop'
import type { createSandboxManager } from '../sandbox/manager'
import { toContainerPath, rewriteOutput } from '../sandbox/path'
import { getSandboxForSession } from '../sandbox/context'
import { executeSandboxGlob, executeSandboxGrep } from '../tools/sandbox-fs'

interface SandboxToolHookDeps {
  loopService: ReturnType<typeof createLoopService>
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  logger: Logger
}

const pendingResults = new Map<string, { result: string; storedAt: number }>()

const BASH_DEFAULT_TIMEOUT_MS = 120_000
const STALE_THRESHOLD_MS = 5 * 60 * 1000

export function createSandboxToolBeforeHook(deps: SandboxToolHookDeps): Hooks['tool.execute.before'] {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
    output: { args: any },
  ) => {
    const sandbox = getSandboxForSession(deps, input.sessionID)
    if (!sandbox) return

    const { docker, containerName, hostDir } = sandbox

    if (input.tool === 'bash') {
      const args = output.args

      output.args = { ...args, command: 'true' }

      const cmd = (args.command ?? '').trimStart()
      if (cmd === 'git push' || cmd.startsWith('git push ')) {
        pendingResults.set(input.callID, { result: 'Git push is not available in sandbox mode. Pushes must be run on the host.', storedAt: Date.now() })
        return
      }

      deps.logger.log(`[sandbox-hook] intercepting bash: ${args.command?.slice(0, 100)}`)

      const hookTimeout = (args.timeout ?? BASH_DEFAULT_TIMEOUT_MS) + 10_000
      const cwd = args.workdir ? toContainerPath(args.workdir, hostDir) : undefined

      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sandbox hook timeout after ${hookTimeout}ms`)), hookTimeout),
        )

        const execPromise = docker.exec(containerName, args.command, {
          timeout: args.timeout,
          cwd,
        })

        const result = await Promise.race([execPromise, timeoutPromise])

        let dockerOutput = rewriteOutput(result.stdout, hostDir)
        if (result.stderr && result.exitCode !== 0) {
          dockerOutput += rewriteOutput(result.stderr, hostDir)
        }
        if (result.exitCode === 124) {
          const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS
          dockerOutput += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
        } else if (result.exitCode !== 0) {
          dockerOutput += `\n\n[Exit code: ${result.exitCode}]`
        }

        pendingResults.set(input.callID, { result: dockerOutput.trim(), storedAt: Date.now() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.logger.log(`[sandbox-hook] exec failed for callID ${input.callID}: ${message}`)
        pendingResults.set(input.callID, { result: `Command failed: ${message}`, storedAt: Date.now() })
      }
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
    if (input.tool !== 'bash' && input.tool !== 'glob' && input.tool !== 'grep') return

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
