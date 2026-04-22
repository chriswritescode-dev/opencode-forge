type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment).
 * - In-place loops omit the allow-all so the agent's own permissions apply.
 *
 * Note on external_directory evaluation: The blanket `*:*:allow` for worktree loops
 * covers the session's own cwd. The `external_directory:*:deny` rule only blocks
 * paths outside the worktree. Sandbox worktree loops launch without permission
 * prompts for their own cwd because the container-mapped directory falls within
 * the worktree scope that the blanket allow covers.
 *
 * Per-agent tool restrictions are enforced by opencode's per-agent `tools` map
 * (see `src/config.ts`), not at the session level. This keeps subagents
 * (e.g., the auditor subtask) from inheriting restrictions intended only for
 * the primary agent.
 *
 * Worktree completion logs are written by the host session (see
 * `src/hooks/loop.ts` -> `writeWorktreeCompletionLog`), so the loop session
 * itself does not need an external_directory allow rule for the log path.
 */
export function buildLoopPermissionRuleset(
  options?: { isWorktree?: boolean },
): PermissionRule[] {
  const isWorktree = options?.isWorktree ?? true
  const rules: PermissionRule[] = []

  if (isWorktree) {
    rules.push({ permission: '*', pattern: '*', action: 'allow' })
  }

  rules.push(
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: 'git push *', action: 'deny' },
    { permission: 'loop-cancel', pattern: '*', action: 'deny' },
    { permission: 'loop-status', pattern: '*', action: 'deny' },
  )

  return rules
}
