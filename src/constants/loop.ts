import type { PluginConfig } from '../types'

type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment).
 * - In-place loops omit the allow-all so the agent's own permissions apply.
 * - Agent tool exclusions are appended as deny rules at the end so they
 *   take precedence over the allow-all via the harness's findLast semantics.
 * - Adds external_directory allow rule for worktree logging when configured AND needed.
 *   Note: With host-session dispatch, worktree sessions no longer need direct host log access.
 *   This parameter is kept for backward compatibility but should be null for new designs.
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

  // Only add external_directory allow rule when logDirectory is provided and logging is enabled
  // In the new host-session dispatch design, this should be null for worktree sessions
  // since the host session (not the worktree) writes the logs
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
