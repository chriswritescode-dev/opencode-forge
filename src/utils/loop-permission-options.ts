import type { ForgeClient } from '../client/port'
import {
  resolveLoopPermissionOptions,
  type LoopPermissionRulesetOptions,
  type PermissionRule,
} from '../constants/loop'
import { getForgeWorkspaceEntry, getForgeWorkspacePermissionRules } from '../workspace/forge-worktree'
import type { PluginConfig } from '../types'

const portableRulesCache = new WeakMap<ForgeClient, Map<string, PermissionRule[]>>()

async function readWorkspacePortableRules(
  client: ForgeClient,
  workspaceId: string | undefined,
): Promise<PermissionRule[]> {
  if (!workspaceId) return []
  let perClient = portableRulesCache.get(client)
  if (!perClient) {
    perClient = new Map()
    portableRulesCache.set(client, perClient)
  }
  const cached = perClient.get(workspaceId)
  if (cached) return cached
  try {
    const entry = await getForgeWorkspaceEntry(client, workspaceId)
    const rules = entry ? getForgeWorkspacePermissionRules(entry) : []
    perClient.set(workspaceId, rules)
    return rules
  } catch {
    return []
  }
}

/**
 * Resolves the full ruleset options for a loop, merging the configured
 * `loop.permissions` rules with the portable rules persisted in the given
 * workspace's metadata. Portable rules are written by the remote launcher into
 * `extra.permissionRules` so remote loops keep the launching machine's rules
 * even though the remote server's own config does not carry them.
 *
 * The portable-rules lookup is memoised per client/workspace, so this is not a
 * per-tick or per-permission-check fetch. Empty results are cached (empty
 * arrays are truthy) so a workspace with no portable rules stays cached.
 */
export async function resolveLoopPermissionOptionsForWorkspace(
  client: ForgeClient,
  config: PluginConfig | undefined,
  workspaceId: string | undefined,
): Promise<LoopPermissionRulesetOptions> {
  const opts = resolveLoopPermissionOptions(config)
  const portable = await readWorkspacePortableRules(client, workspaceId)
  if (portable.length === 0) return opts
  return { ...opts, extraRules: [...(opts.extraRules ?? []), ...portable] }
}
