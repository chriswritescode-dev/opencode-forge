import { z } from 'zod'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { SANDBOX_OFF_NOTE, buildSandboxContextNote, buildSandboxOffNote, detectSandboxChange } from '../sandbox/context'
import type { EnvironmentProbe } from '../sandbox/env-probe'
import type { ResolveSandboxForSessionOpts } from '../services/unified-sandbox-resolver'
import { LRUCache } from '../utils/lru-cache'

export const SANDBOX_TRACKED_SESSION_LIMIT = 500

export const SANDBOX_INSTRUCTION_KEY = 'forge-sandbox'

export interface SessionInstructionEntries {
  list(sessionID: string): Promise<ReadonlyArray<{ key: string; value: unknown }>>
  put(input: { sessionID: string; key: string; value: string }): Promise<void>
}

const storedNoteSchema = z.string()

async function readStoredNote(entries: SessionInstructionEntries, sessionID: string): Promise<{ text: string | null } | null> {
  const stored = (await entries.list(sessionID)).find((entry) => entry.key === SANDBOX_INSTRUCTION_KEY)
  if (!stored) return null
  const text = storedNoteSchema.safeParse(stored.value)
  return { text: text.success ? text.data : null }
}

function isHostNote(text: string | null): boolean {
  return text !== null && text.includes(SANDBOX_OFF_NOTE.split('\n')[0]!)
}

export interface CreateSandboxMessageHookDeps {
  resolveSandboxForSession(sessionID: string, opts?: ResolveSandboxForSessionOpts): Promise<SandboxContext | null>
  probe?: EnvironmentProbe
  logger: Logger
}

type TrackedSession =
  | { sandbox: SandboxContext; env: string | null; stable: string }
  | { hostEnv: string | null | undefined }

export function createSandboxMessageHook(deps: CreateSandboxMessageHookDeps) {
  const { resolveSandboxForSession, probe, logger } = deps

  const trackedSessions = new LRUCache<TrackedSession>(SANDBOX_TRACKED_SESSION_LIMIT)

  return async (sessionID: string, entries: SessionInstructionEntries): Promise<void> => {
    let sandbox: SandboxContext | null
    try {
      sandbox = await resolveSandboxForSession(sessionID, { throwOnRestoreError: true })
    } catch (err) {
      logger.error(`[sandbox-message] failed to resolve sandbox for session=${sessionID}`, err)
      return
    }

    const tracked = trackedSessions.get(sessionID)

    try {
      if (sandbox) {
        const env = probe ? await probe.describeSandbox(sandbox) : null
        const stable = buildSandboxContextNote({ switched: false, to: env }, { settings: sandbox.settings })
        if (tracked && 'sandbox' in tracked) {
          const change = detectSandboxChange(tracked.sandbox, sandbox)
          if (change || tracked.stable !== stable) {
            await entries.put({
              sessionID,
              key: SANDBOX_INSTRUCTION_KEY,
              value: buildSandboxContextNote({ switched: false, to: env }, { settings: sandbox.settings, change }),
            })
          }
        } else if (tracked) {
          const from = tracked.hostEnv ?? (probe ? await probe.describeHost() : null)
          await entries.put({
            sessionID,
            key: SANDBOX_INSTRUCTION_KEY,
            value: buildSandboxContextNote({ switched: true, from, to: env }, { settings: sandbox.settings }),
          })
        } else {
          const stored = await readStoredNote(entries, sessionID)
          if (stored && isHostNote(stored.text)) {
            const hostEnv = probe ? await probe.describeHost() : null
            await entries.put({
              sessionID,
              key: SANDBOX_INSTRUCTION_KEY,
              value: buildSandboxContextNote({ switched: true, from: hostEnv, to: env }, { settings: sandbox.settings }),
            })
          } else if (stored?.text !== stable) {
            await entries.put({ sessionID, key: SANDBOX_INSTRUCTION_KEY, value: stable })
          }
        }
        trackedSessions.set(sessionID, { sandbox, env, stable })
        return
      }

      if (tracked && 'sandbox' in tracked) {
        const hostEnv = probe ? await probe.describeHost() : null
        await entries.put({
          sessionID,
          key: SANDBOX_INSTRUCTION_KEY,
          value: buildSandboxOffNote({ from: tracked.env, to: hostEnv }),
        })
        trackedSessions.set(sessionID, { hostEnv })
        return
      }

      if (tracked) return

      const stored = await readStoredNote(entries, sessionID)
      if (!stored || isHostNote(stored.text)) {
        trackedSessions.set(sessionID, { hostEnv: undefined })
        return
      }
      const hostEnv = probe ? await probe.describeHost() : null
      await entries.put({
        sessionID,
        key: SANDBOX_INSTRUCTION_KEY,
        value: buildSandboxOffNote({ to: hostEnv }),
      })
      trackedSessions.set(sessionID, { hostEnv })
    } catch (err) {
      logger.error(`[sandbox-message] failed to sync the sandbox instruction entry for session=${sessionID}`, err)
    }
  }
}
