import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import type { ToolAfterHook, ToolBeforeHook } from './tool-hook-types'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { executeSandboxGlob, executeSandboxGrep } from '../sandbox/exec-fs'
import { canonicalizeExistingPath, canonicalizePath, findContainingMount, isInsideAnyMount } from '../sandbox/path'

const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'patch'])
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
function fileToolTargets(tool: string, args: any): string[] {
  if (tool === 'patch') {
    const text = args?.patchText
    return typeof text === 'string' ? [...text.matchAll(PATCH_FILE_HEADER)].map((match) => match[1]) : []
  }
  const path = args?.path ?? args?.filePath
  return typeof path === 'string' ? [path] : []
}

function resolveToolPath(path: string, baseDir: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  return canonicalizeExistingPath(resolve(baseDir, expanded))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
function assertFileToolInsideSandbox(tool: string, args: any, sandbox: SandboxContext): void {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
    output: { args: any },
  ) => {
    // This hook routes search tools into the sandbox and fences host file tools to the sandbox
    // mounts. Return before any resolution for every other tool so a fail-closed resolver error can
    // never block shell or management tools.
    if (input.tool !== 'glob' && input.tool !== 'grep' && !FILE_TOOLS.has(input.tool)) return

    // Request fail-closed resolution exactly as bash does: when an acknowledged sandbox cannot be
    // restored (or the selected session's start failed), the resolver throws and the tool call
    // fails rather than silently touching the host checkout.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
    input: { tool: string; sessionID: string; callID: string; args: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
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
