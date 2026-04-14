import type { PluginConfig } from '../types'

type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

export const LOOP_PERMISSION_RULESET: PermissionRule[] = [
  { permission: '*', pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: 'git push *', action: 'deny' },
]

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment).
 * - In-place loops omit the allow-all so the agent's own permissions apply.
 * - Agent tool exclusions are appended as deny rules at the end so they
 *   take precedence over the allow-all via the harness's findLast semantics.
 * - Adds external_directory allow rule for worktree logging when configured.
 */
export function buildLoopPermissionRuleset(
  config: PluginConfig,
  logDirectory?: string | null,
  options?: { isWorktree?: boolean; agentExclusions?: string[] },
): PermissionRule[] {
  const isWorktree = options?.isWorktree ?? true
  const rules: PermissionRule[] = []

  if (isWorktree) {
    rules.push({ permission: '*', pattern: '*', action: 'allow' })
  }

  rules.push(
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: 'git push *', action: 'deny' },
  )

  if (logDirectory && config.loop?.worktreeLogging?.enabled) {
    rules.push({
      permission: 'external_directory',
      pattern: logDirectory,
      action: 'allow',
    })
  }

  if (options?.agentExclusions) {
    for (const tool of options.agentExclusions) {
      rules.push({ permission: tool, pattern: '*', action: 'deny' })
    }
  }

  return rules
}
