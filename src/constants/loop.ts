type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment), with
 *   more restrictive rules layered on top:
 *   - Worktree + sandbox: external_directory is allowed (no prompt)
 *   - Worktree + non-sandbox: external_directory is denied (no prompt)
 * - In-place loops omit the allow-all so the agent's own permissions apply,
 *   and no external_directory rule is added (OpenCode will ask by default).
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
  options?: { isWorktree?: boolean; isSandbox?: boolean },
): PermissionRule[] {
  const isWorktree = options?.isWorktree ?? false
  const isSandbox = options?.isSandbox ?? false
  const rules: PermissionRule[] = []

  if (isWorktree) {
    // Blanket allow-all for worktree loops (isolated environment).
    // More restrictive rules below layer on top of this.
    rules.push({ permission: '*', pattern: '*', action: 'allow' })

    // External directory access: explicit rule to avoid prompting.
    if (isSandbox) {
      // Sandbox worktree: allow external directory access
      rules.push({ permission: 'external_directory', pattern: '*', action: 'allow' })
    } else {
      // Non-sandbox worktree: deny external directory access
      rules.push({ permission: 'external_directory', pattern: '*', action: 'deny' })
    }
  }
  // In-place loops: no blanket allow and no external_directory rule;
  // the agent's own permissions apply and OpenCode will ask by default.

  // Common restrictions for all loop types
  rules.push(
    { permission: 'bash', pattern: 'git push *', action: 'deny' },
    { permission: 'loop-cancel', pattern: '*', action: 'deny' },
    { permission: 'loop-status', pattern: '*', action: 'deny' },
  )

  return rules
}
