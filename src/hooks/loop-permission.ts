import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import { buildLoopPermissionRuleset } from '../constants/loop'

/**
 * Sessions already verified to carry a loop ruleset (or verified to not need
 * one, e.g. loop root sessions created with rules upfront). Prevents repeated
 * session fetches/updates from the high-frequency fallback paths.
 */
const PATCHED_SESSIONS = new Set<string>()
const PATCHED_SESSIONS_MAX = 5000

export function __resetLoopPermissionCache() {
  PATCHED_SESSIONS.clear()
}

interface SessionCreatedProperties {
  info?: {
    id?: string
    parentID?: string
    directory?: string
    title?: string
  }
}

type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }

type ResolvedLoop = Awaited<
  ReturnType<ReturnType<typeof createSessionLoopResolver>['resolveActiveLoopForSession']>
>

function hasBlanketAllow(rules: unknown): rules is PermissionRule[] {
  return (
    Array.isArray(rules) &&
    rules.some((r: PermissionRule) => r.permission === '*' && r.pattern === '*' && r.action === 'allow')
  )
}

function markPatched(sessionID: string) {
  PATCHED_SESSIONS.add(sessionID)
  if (PATCHED_SESSIONS.size > PATCHED_SESSIONS_MAX) {
    const oldest = PATCHED_SESSIONS.values().next().value
    if (oldest) PATCHED_SESSIONS.delete(oldest)
  }
}

export interface CreateLoopPermissionPatcherDeps {
  client: ForgeClient
  sessionLoopResolver: ReturnType<typeof createSessionLoopResolver>
  directory: string
  logger: Logger
  /** Resolves the configured external-directory allowlist for loop sessions. */
  getAllowExternalDirectories?: () => string[] | undefined
}

export interface LoopPermissionPatcher {
  /** `session.created` fast path: patches task-spawned subagent sessions inside active loops. */
  onSessionCreated(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void>
  /**
   * Fallback path for hooks that fire reliably for loop sessions
   * (`chat.message`, `tool.execute.before`). Needed because plugin `event`
   * delivery is filtered by instance directory in opencode, so
   * `session.created` for subagent sessions in loop worktrees may never reach
   * this plugin instance. Verifies the session's actual rules before writing,
   * so it is idempotent across plugin restarts.
   */
  ensurePatched(input: { sessionID: string; resolved?: ResolvedLoop }): Promise<void>
}

export function createLoopPermissionPatcher(deps: CreateLoopPermissionPatcherDeps): LoopPermissionPatcher {
  const { client, sessionLoopResolver, directory, logger, getAllowExternalDirectories } = deps

  async function applyRuleset(input: {
    sessionID: string
    parentID: string
    targetDirectory: string
    loopName: string
  }): Promise<void> {
    const { sessionID, parentID, targetDirectory, loopName } = input

    let ruleset: PermissionRule[] | null = null
    let rulesetSource = 'loop-default'
    try {
      const parent = await client.session.get({ sessionID: parentID, directory: targetDirectory })
      const parentRules = (parent as { permission?: PermissionRule[] })?.permission
      if (hasBlanketAllow(parentRules)) {
        ruleset = parentRules
        rulesetSource = `inherited-from-parent=${parentID}`
      }
    } catch (err) {
      logger.error(`[loop-permission] failed to fetch parent ${parentID} for inheritance`, err)
    }
    if (!ruleset) ruleset = buildLoopPermissionRuleset({ allowDirectories: getAllowExternalDirectories?.() })

    logger.log(
      `[loop-permission] patching loop=${loopName} session=${sessionID} parent=${parentID} ruleset=${rulesetSource}`,
    )

    try {
      await client.session.update({
        sessionID,
        directory: targetDirectory,
        permission: ruleset,
      })
      markPatched(sessionID)
      logger.log(
        `[loop-permission] applied loop=${loopName} session=${sessionID} ruleCount=${ruleset.length}`,
      )
    } catch (err) {
      logger.error(`[loop-permission] session.update threw for ${sessionID}`, err)
    }
  }

  return {
    async onSessionCreated(eventInput) {
      if (eventInput.event?.type !== 'session.created') return

      const props = eventInput.event.properties as SessionCreatedProperties | undefined
      const info = props?.info
      const sessionID = info?.id
      const parentID = info?.parentID
      if (!sessionID || !parentID) return

      const resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      if (!resolved?.active) return

      if (PATCHED_SESSIONS.has(sessionID)) {
        logger.log(
          `[loop-permission] skipped: already patched session=${sessionID} loop=${resolved.loopName}`,
        )
        return
      }

      await applyRuleset({
        sessionID,
        parentID,
        targetDirectory: info?.directory ?? resolved.worktreeDir ?? directory,
        loopName: resolved.loopName,
      })
    },

    async ensurePatched(input) {
      const { sessionID } = input
      if (!sessionID || PATCHED_SESSIONS.has(sessionID)) return

      const resolved = input.resolved !== undefined
        ? input.resolved
        : await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      if (!resolved?.active) return

      const targetDirectory = resolved.worktreeDir ?? directory

      let parentID: string | undefined
      try {
        const self = await client.session.get({ sessionID, directory: targetDirectory })
        const selfInfo = self as { parentID?: string; permission?: PermissionRule[] }
        // Loop root and audit sessions are created with their ruleset upfront;
        // only task-spawned subagent sessions (which have a parent) need patching.
        if (!selfInfo?.parentID || hasBlanketAllow(selfInfo?.permission)) {
          markPatched(sessionID)
          return
        }
        parentID = selfInfo.parentID
      } catch (err) {
        logger.error(`[loop-permission] failed to fetch session ${sessionID} for fallback patch`, err)
        return
      }

      logger.log(
        `[loop-permission] fallback patch triggered loop=${resolved.loopName} session=${sessionID}`,
      )
      await applyRuleset({
        sessionID,
        parentID,
        targetDirectory,
        loopName: resolved.loopName,
      })
    },
  }
}
