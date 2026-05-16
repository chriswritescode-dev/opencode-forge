import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import { buildLoopPermissionRuleset } from '../constants/loop'

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
  v2: OpencodeClient
  sessionLoopResolver: ReturnType<typeof createSessionLoopResolver>
  directory: string
  logger: Logger
}

export type LoopPermissionRejectHook = (
  input: { event: { type: string; properties?: Record<string, unknown> } }
) => Promise<void>

/**
 * Patches the permission ruleset of subagent sessions created inside an
 * active loop so they never raise "ask" prompts.
 *
 * Loops are autonomous — no user is available to answer prompts. OpenCode's
 * default subagent ruleset only denies a few tools (typically `todowrite`,
 * `task`); everything else falls back to "ask" and deadlocks the session.
 *
 * To preserve the parent session's intent (e.g. an auditor's subagent must
 * stay read-only just like the auditor itself), we copy the parent session's
 * permission ruleset onto the child. If the parent's ruleset is missing or
 * has no allow-all rule, we fall back to the standard loop ruleset so the
 * child still has full autonomy inside the worktree.
 */
export function createLoopPermissionRejectHook(
  deps: CreateLoopPermissionRejectHookDeps,
): LoopPermissionRejectHook {
  const { v2, sessionLoopResolver, directory, logger } = deps

  return async (eventInput) => {
    if (eventInput.event?.type !== 'session.created') return

    const props = eventInput.event.properties as SessionCreatedProperties | undefined
    const info = props?.info
    const sessionID = info?.id
    const parentID = info?.parentID
    if (!sessionID || !parentID) return

    const resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
    if (!resolved?.active) return

    const targetDirectory = info?.directory ?? resolved.worktreeDir ?? directory

    let ruleset: PermissionRule[] | null = null
    let rulesetSource = 'loop-default'
    try {
      const parent = await v2.session.get({ sessionID: parentID, directory: targetDirectory })
      const parentRules = (parent as { data?: { permission?: PermissionRule[] } })?.data?.permission
      if (Array.isArray(parentRules) && parentRules.some((r) => r.permission === '*' && r.action === 'allow')) {
        ruleset = parentRules
        rulesetSource = `inherited-from-parent=${parentID}`
      }
    } catch (err) {
      logger.error(`[loop-permission] failed to fetch parent ${parentID} for inheritance`, err)
    }
    if (!ruleset) ruleset = buildLoopPermissionRuleset()

    logger.log(
      `[loop-permission] patching subagent permissions loop=${resolved.loopName} session=${sessionID} parent=${parentID} directory=${targetDirectory} ruleset=${rulesetSource} title=${JSON.stringify(info?.title ?? null)}`,
    )

    try {
      const result = await v2.session.update({
        sessionID,
        directory: targetDirectory,
        permission: ruleset,
      })
      if ((result as { error?: unknown })?.error) {
        logger.error(
          `[loop-permission] session.update returned error for ${sessionID}`,
          (result as { error?: unknown }).error,
        )
      }
    } catch (err) {
      logger.error(`[loop-permission] session.update threw for ${sessionID}`, err)
    }
  }
}
