import type { PluginConfig } from '../types'

type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment).
 * - In-place loops omit the allow-all so the agent's own permissions apply.
 * - Adds external_directory allow rule for worktree logging when configured AND needed.
 *   Note: With host-session dispatch, worktree sessions no longer need direct host log access.
 *   This parameter is kept for backward compatibility but should be null for new designs.
 * - Agent tool exclusions are appended as deny rules at the END to ensure they take precedence.
 *
 * Note on external_directory evaluation: The blanket `*:*:allow` for worktree loops
 * covers the session's own cwd. The `external_directory:*:deny` rule only blocks
 * paths outside the worktree. Audit performed: sandbox worktree loops launch
 * without permission prompts for their own cwd because the container-mapped
 * directory falls within the worktree scope that the blanket allow covers.
 *
 * @param excludedTools - List of tool names to exclude (from agent definition). These are appended as deny rules last.
 */
export function buildLoopPermissionRuleset(
  config: PluginConfig,
  logDirectory?: string | null,
  options?: { isWorktree?: boolean; excludedTools?: string[] },
): PermissionRule[] {
  const isWorktree = options?.isWorktree ?? true
  const excludedTools = options?.excludedTools ?? []
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

  rules.push(
    { permission: 'loop-cancel', pattern: '*', action: 'deny' },
    { permission: 'loop-status', pattern: '*', action: 'deny' },
  )

  // Append agent tool exclusions as deny rules at the END
  // This ensures they take precedence due to findLast evaluation in opencode
  for (const tool of excludedTools) {
    rules.push({ permission: tool, pattern: '*', action: 'deny' })
  }

  return rules
}
