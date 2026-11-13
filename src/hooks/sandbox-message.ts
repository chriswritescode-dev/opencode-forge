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
  resolveSandboxForSession(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  probe?: EnvironmentProbe
  logger: Logger
}

type SystemTransformInput = { sessionID?: string }
type SystemTransformOutput = { system: string[] }

export function createSandboxMessageHook(deps: CreateSandboxMessageHookDeps) {
  const { resolveSandboxForSession, probe, logger } = deps

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
