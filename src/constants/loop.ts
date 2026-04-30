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
 * (see `src/config.ts`), not at the session level. However, now that the auditor
 * runs in a separate session (not a subtask), we add explicit session-level denies
 * for tools the code agent should not call (review-write, review-delete, plan-*, loop).
 * These denies are placed AFTER the *:allow so findLast picks them up.
 *
 * Worktree completion logs are written by the host session (see
 * `src/hooks/loop.ts` -> `writeWorktreeCompletionLog`), so the loop session
 * itself does not need an external_directory allow rule for the log path.
 */
/**
 * @param options.isWorktree - Defaults to false (in-place loop). Worktree loops are isolated.
 * @param options.isSandbox - Defaults to false (non-sandbox). Sandbox provides container isolation.
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

  // Code agent forbidden tools (enforced at session level now that audit runs
  // in a separate session). Placed after *:allow so findLast picks these.
  rules.push(
    { permission: 'review-write',  pattern: '*', action: 'deny' },
    { permission: 'review-delete', pattern: '*', action: 'deny' },
    { permission: 'plan-execute',  pattern: '*', action: 'deny' },
    { permission: 'loop',          pattern: '*', action: 'deny' },
  )

  // Common restrictions for all loop types
  rules.push(
    { permission: 'bash',        pattern: 'git push *', action: 'deny' },
    { permission: 'loop-cancel', pattern: '*',          action: 'deny' },
    { permission: 'loop-status', pattern: '*',          action: 'deny' },
  )

  return rules
}

/**
 * Builds the permission ruleset for audit sessions.
 *
 * Audit sessions run the auditor agent in an isolated session that cannot
 * modify source files. The ruleset allows read-only operations (read, grep,
 * glob, graph-*, codesearch, webfetch, websearch, list, task) and review
 * tools (review-write, review-delete), but denies all code mutation tools.
 *
 * - isSandbox: controls external_directory access (same as coding sessions)
 */
export function buildAuditSessionPermissionRuleset(
  options?: { isSandbox?: boolean },
): PermissionRule[] {
  const isSandbox = options?.isSandbox ?? false
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'external_directory', pattern: '*', action: isSandbox ? 'allow' : 'deny' },
    // Audit sessions must not mutate code.
    { permission: 'edit',        pattern: '*', action: 'deny' },
    { permission: 'write',       pattern: '*', action: 'deny' },
    { permission: 'multiedit',   pattern: '*', action: 'deny' },
    { permission: 'apply_patch', pattern: '*', action: 'deny' },
    { permission: 'bash',        pattern: 'git commit *', action: 'deny' },
    { permission: 'bash',        pattern: 'git push *',   action: 'deny' },
    { permission: 'bash',        pattern: 'git reset *',  action: 'deny' },
    { permission: 'bash',        pattern: 'git rm *',     action: 'deny' },
    { permission: 'bash',        pattern: 'git mv *',     action: 'deny' },
    { permission: 'bash',        pattern: 'rm *',         action: 'deny' },
    { permission: 'bash',        pattern: 'mv *',         action: 'deny' },
    // Auditors must never launch loops, execute plans, or manage other loops.
    { permission: 'loop',         pattern: '*', action: 'deny' },
    { permission: 'plan-execute', pattern: '*', action: 'deny' },
    { permission: 'loop-cancel',  pattern: '*', action: 'deny' },
    { permission: 'loop-status',  pattern: '*', action: 'deny' },
  ]
  return rules
}
