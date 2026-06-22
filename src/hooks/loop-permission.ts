import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import { buildLoopPermissionRuleset } from '../constants/loop'

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

export interface CreateLoopPermissionRejectHookDeps {
  client: ForgeClient
  sessionLoopResolver: ReturnType<typeof createSessionLoopResolver>
  directory: string
  logger: Logger
  /** Resolves the configured external-directory allowlist for loop sessions. */
  getAllowExternalDirectories?: () => string[] | undefined
}

export type LoopPermissionRejectHook = (
  input: { event: { type: string; properties?: Record<string, unknown> } }
) => Promise<void>

export function createLoopPermissionRejectHook(
  deps: CreateLoopPermissionRejectHookDeps,
): LoopPermissionRejectHook {
  const { client, sessionLoopResolver, directory, logger, getAllowExternalDirectories } = deps

  return async (eventInput) => {
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

    const targetDirectory = info?.directory ?? resolved.worktreeDir ?? directory

    let ruleset: PermissionRule[] | null = null
    let rulesetSource = 'loop-default'
    try {
      const parent = await client.session.get({ sessionID: parentID, directory: targetDirectory })
      const parentRules = (parent as { permission?: PermissionRule[] })?.permission
      if (Array.isArray(parentRules) && parentRules.some((r) => r.permission === '*' && r.action === 'allow')) {
        ruleset = parentRules
        rulesetSource = `inherited-from-parent=${parentID}`
      }
    } catch (err) {
      logger.error(`[loop-permission] failed to fetch parent ${parentID} for inheritance`, err)
    }
    if (!ruleset) ruleset = buildLoopPermissionRuleset({ sandbox: resolved.sandbox ?? false, allowDirectories: getAllowExternalDirectories?.() })

    logger.log(
      `[loop-permission] patching loop=${resolved.loopName} session=${sessionID} parent=${parentID} ruleset=${rulesetSource}`,
    )

    try {
      await client.session.update({
        sessionID,
        directory: targetDirectory,
        permission: ruleset,
      })
      PATCHED_SESSIONS.add(sessionID)
      if (PATCHED_SESSIONS.size > PATCHED_SESSIONS_MAX) {
        const oldest = PATCHED_SESSIONS.values().next().value
        if (oldest) PATCHED_SESSIONS.delete(oldest)
      }
      logger.log(
        `[loop-permission] applied loop=${resolved.loopName} session=${sessionID} ruleCount=${ruleset.length}`,
      )
    } catch (err) {
      logger.error(`[loop-permission] session.update threw for ${sessionID}`, err)
    }
  }
}
