import { z } from 'zod'
import type { ForgeClient, ForgeEvent, SessionPermissionRule } from '../client/port'
import type { Logger } from '../types'
import type { createSessionLoopResolver } from '../services/session-loop-resolver'
import { buildLoopPermissionRuleset, type LoopPermissionRulesetOptions } from '../constants/loop'

const PATCHED_SESSIONS = new Set<string>()
const PATCHED_SESSIONS_MAX = 5000

export function __resetLoopPermissionCache() {
  PATCHED_SESSIONS.clear()
}

const sessionCreatedPropertiesSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().optional(),
    parentID: z.string().optional(),
    directory: z.string().optional(),
    title: z.string().optional(),
  }).optional(),
})

const permissionRuleSchema = z.looseObject({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(['allow', 'deny', 'ask']),
})

const permissionRulesSchema = z.array(permissionRuleSchema)


type ResolvedLoop = Awaited<
  ReturnType<ReturnType<typeof createSessionLoopResolver>['resolveActiveLoopForSession']>
>

function hasBlanketAllow(rules: SessionPermissionRule[] | null | undefined): boolean {
  if (!rules) return false
  return rules.some((rule) => rule.permission === '*' && rule.pattern === '*' && rule.action === 'allow')
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
  getPermissionOptions?: (workspaceId?: string) => LoopPermissionRulesetOptions | Promise<LoopPermissionRulesetOptions> | undefined
}

export interface LoopPermissionPatcher {
  onSessionCreated(input: { event: { type: string; properties?: ForgeEvent['properties'] } }): Promise<void>
  ensurePatched(input: { sessionID: string; resolved?: ResolvedLoop }): Promise<void>
}

export function createLoopPermissionPatcher(deps: CreateLoopPermissionPatcherDeps): LoopPermissionPatcher {
  const { client, sessionLoopResolver, directory, logger, getPermissionOptions } = deps

  async function applyRuleset(input: {
    sessionID: string
    parentID: string
    targetDirectory: string
    loopName: string
    workspaceId?: string
  }): Promise<void> {
    const { sessionID, parentID, targetDirectory, loopName, workspaceId } = input

    let ruleset: SessionPermissionRule[] | null = null
    let rulesetSource = 'loop-default'
    try {
      const parent = await client.session.get({ sessionID: parentID, directory: targetDirectory })
      const parsedParentRules = permissionRulesSchema.safeParse(parent.permission)
      const parentRules = parsedParentRules.success ? parsedParentRules.data : null
      if (hasBlanketAllow(parentRules)) {
        ruleset = parentRules
        rulesetSource = `inherited-from-parent=${parentID}`
      }
    } catch (err) {
      logger.error(`[loop-permission] failed to fetch parent ${parentID} for inheritance`, err)
    }
    if (!ruleset) {
      try {
        ruleset = buildLoopPermissionRuleset((await getPermissionOptions?.(workspaceId)) ?? {})
      } catch (err) {
        logger.error(`[loop-permission] failed to resolve permission options for ${sessionID}`, err)
        ruleset = buildLoopPermissionRuleset()
      }
    }

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

      const props = sessionCreatedPropertiesSchema.safeParse(eventInput.event.properties)
      const info = props.success ? props.data.info : undefined
      const sessionID = info?.id
      const parentID = info?.parentID
      if (!sessionID || !parentID) return

      let resolved: ResolvedLoop | null
      try {
        resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      } catch (err) {
        logger.error(`[loop-permission] ancestry lookup failed for ${sessionID}, skipping patch`, err)
        return
      }
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
        workspaceId: resolved.workspaceId,
      })
    },

    async ensurePatched(input) {
      const { sessionID } = input
      if (!sessionID || PATCHED_SESSIONS.has(sessionID)) return

      let resolved: ResolvedLoop | null
      if (input.resolved !== undefined) {
        resolved = input.resolved
      } else {
        try {
          resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
        } catch (err) {
          logger.error(`[loop-permission] ancestry lookup failed for ${sessionID}, skipping fallback patch`, err)
          return
        }
      }
      if (!resolved?.active) return

      const targetDirectory = resolved.worktreeDir ?? directory

      let parentID: string | undefined
      try {
        const self = await client.session.get({ sessionID, directory: targetDirectory })
        const parsedSelfRules = permissionRulesSchema.safeParse(self.permission)
        if (!self.parentID || hasBlanketAllow(parsedSelfRules.success ? parsedSelfRules.data : undefined)) {
          markPatched(sessionID)
          return
        }
        parentID = self.parentID
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
        workspaceId: resolved.workspaceId,
      })
    },
  }
}
