import { z } from 'zod'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import {
  MACOS_SANDBOX_CONTEXT_NOTE,
  MACOS_SANDBOX_OFF_NOTE,
  SANDBOX_CONTEXT_NOTE,
  SANDBOX_OFF_NOTE,
  buildSandboxContextNote,
  buildSandboxKindSwitchNote,
  buildSandboxOffNote,
  detectSandboxChange,
} from '../sandbox/context'
import type { SandboxBackendKind } from '../sandbox/runtime'
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

const MACOS_CONTEXT_MARKER = MACOS_SANDBOX_CONTEXT_NOTE.split('\n')[0]!
const SANDBOX_CONTEXT_MARKER = SANDBOX_CONTEXT_NOTE.split('\n')[0]!
const SANDBOX_OFF_MARKERS = [SANDBOX_OFF_NOTE.split('\n')[0]!, MACOS_SANDBOX_OFF_NOTE.split('\n')[0]!]

async function readStoredNote(entries: SessionInstructionEntries, sessionID: string): Promise<{ text: string | null } | null> {
  const stored = (await entries.list(sessionID)).find((entry) => entry.key === SANDBOX_INSTRUCTION_KEY)
  if (!stored) return null
  const text = storedNoteSchema.safeParse(stored.value)
  return { text: text.success ? text.data : null }
}

function isHostNote(text: string | null): boolean {
  return text !== null && SANDBOX_OFF_MARKERS.some((marker) => text.includes(marker))
}

function storedSandboxKind(text: string | null): SandboxBackendKind | null {
  if (text === null) return null
  if (text.includes(MACOS_CONTEXT_MARKER)) return 'macos'
  if (text.includes(SANDBOX_CONTEXT_MARKER)) return 'msb'
  return null
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
        const stable = buildSandboxContextNote(
          { switched: false, to: env },
          { settings: sandbox.settings, kind: sandbox.runtime.kind },
        )
        if (tracked && 'sandbox' in tracked) {
          const change = detectSandboxChange(tracked.sandbox, sandbox)
          if (change || tracked.stable !== stable) {
            await entries.put({
              sessionID,
              key: SANDBOX_INSTRUCTION_KEY,
              value: buildSandboxContextNote(
                { switched: false, to: env },
                { settings: sandbox.settings, change, kind: sandbox.runtime.kind },
              ),
            })
          }
        } else if (tracked) {
          const from = tracked.hostEnv ?? (probe ? await probe.describeHost() : null)
          await entries.put({
            sessionID,
            key: SANDBOX_INSTRUCTION_KEY,
            value: buildSandboxContextNote(
              { switched: true, from, to: env },
              { settings: sandbox.settings, kind: sandbox.runtime.kind },
            ),
          })
        } else {
          const stored = await readStoredNote(entries, sessionID)
          if (stored && isHostNote(stored.text)) {
            const hostEnv = probe ? await probe.describeHost() : null
            await entries.put({
              sessionID,
              key: SANDBOX_INSTRUCTION_KEY,
              value: buildSandboxContextNote(
                { switched: true, from: hostEnv, to: env },
                { settings: sandbox.settings, kind: sandbox.runtime.kind },
              ),
            })
          } else {
            const previousKind = storedSandboxKind(stored?.text ?? null)
            if (previousKind && previousKind !== sandbox.runtime.kind) {
              await entries.put({
                sessionID,
                key: SANDBOX_INSTRUCTION_KEY,
                value: buildSandboxKindSwitchNote({
                  from: previousKind,
                  to: sandbox.runtime.kind,
                  transition: { to: env },
                  settings: sandbox.settings,
                }),
              })
            } else if (stored?.text !== stable) {
              await entries.put({ sessionID, key: SANDBOX_INSTRUCTION_KEY, value: stable })
            }
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
          value: buildSandboxOffNote({ from: tracked.env, to: hostEnv }, { kind: tracked.sandbox.runtime.kind }),
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
        value: buildSandboxOffNote(
          { to: hostEnv },
          { kind: storedSandboxKind(stored.text) ?? undefined },
        ),
      })
      trackedSessions.set(sessionID, { hostEnv })
    } catch (err) {
      logger.error(`[sandbox-message] failed to sync the sandbox instruction entry for session=${sessionID}`, err)
    }
  }
}
