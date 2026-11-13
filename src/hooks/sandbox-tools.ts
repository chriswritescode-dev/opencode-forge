import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import type { ToolAfterHook, ToolAfterInput, ToolAfterOutput, ToolArgs, ToolBeforeHook, ToolBeforeOutput } from './tool-hook-types'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { executeSandboxGlob, executeSandboxGrep } from '../sandbox/exec-fs'
import { canonicalizeExistingPath, canonicalizePath, findContainingMount, isInsideAnyMount } from '../sandbox/path'

const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'patch'])
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm

function fileToolTargets(tool: string, args: ToolArgs): string[] {
  if (tool === 'patch') {
    const text = args.patchText
    return text === undefined ? [] : [...text.matchAll(PATCH_FILE_HEADER)].map((match) => match[1])
  }
  const path = args.path ?? args.filePath
  return path === undefined ? [] : [path]
}

function resolveToolPath(path: string, baseDir: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  return canonicalizeExistingPath(resolve(baseDir, expanded))
}

function assertFileToolInsideSandbox(tool: string, args: ToolArgs, sandbox: SandboxContext): void {
  const mounts = sandbox.mounts.map((mount) => ({
    ...mount,
    hostDir: canonicalizePath(mount.hostDir),
    containerDir: canonicalizePath(mount.containerDir),
  }))
  for (const target of fileToolTargets(tool, args)) {
    const mount = findContainingMount(resolveToolPath(target, sandbox.hostDir), mounts)
    if (!mount) {
      throw new Error(`Refusing to ${tool} outside the sandbox mounts: ${target}`)
    }
    if (mount.readOnly && tool !== 'read') {
      throw new Error(`Refusing to ${tool} inside a read-only sandbox mount: ${target}`)
    }
  }
}

interface SandboxToolHookDeps {
  resolveSandboxForSession: (sessionID: string, opts?: { throwOnRestoreError?: boolean }) => Promise<SandboxContext | null>
  logger: Logger
}

const pendingResults = new Map<string, { result: string; storedAt: number }>()

const STALE_THRESHOLD_MS = 5 * 60 * 1000

export function createSandboxToolBeforeHook(deps: SandboxToolHookDeps): ToolBeforeHook {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    output: ToolBeforeOutput,
  ) => {
    if (input.tool !== 'glob' && input.tool !== 'grep' && !FILE_TOOLS.has(input.tool)) return

    const sandbox = await deps.resolveSandboxForSession(input.sessionID, { throwOnRestoreError: true })
    if (!sandbox) {
      deps.logger.debug(`[sandbox-hook] no sandbox for session ${input.sessionID} tool=${input.tool}`)
      return
    }

    if (FILE_TOOLS.has(input.tool)) {
      assertFileToolInsideSandbox(input.tool, output.args, sandbox)
      return
    }

    const { runtime, containerName, mounts } = sandbox

    const requestedPath = output.args?.path
    if (
      (input.tool === 'glob' || input.tool === 'grep') &&
      requestedPath !== undefined &&
      isAbsolute(requestedPath) &&
      !isInsideAnyMount(requestedPath, mounts)
    ) {
      throw new Error(`Refusing to run ${input.tool} outside the sandbox workspace mount: ${requestedPath}`)
    }

    if (input.tool === 'glob') {
      const args = output.args
      deps.logger.log(`[sandbox-hook] intercepting glob: pattern=${args.pattern}, path=${args.path}`)

      if (args.pattern === undefined) {
        pendingResults.set(input.callID, { result: 'Glob failed: pattern is required', storedAt: Date.now() })
        return
      }

      try {
        const result = await executeSandboxGlob(
          { runtime, containerName, hostDir: sandbox.hostDir },
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

      if (args.pattern === undefined) {
        pendingResults.set(input.callID, { result: 'Grep failed: pattern is required', storedAt: Date.now() })
        return
      }

      try {
        const result = await executeSandboxGrep(
          { runtime, containerName, hostDir: sandbox.hostDir },
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

export function createSandboxToolAfterHook(deps: SandboxToolHookDeps): ToolAfterHook {
  return async (
    input: ToolAfterInput,
    output: ToolAfterOutput,
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
