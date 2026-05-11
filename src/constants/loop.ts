type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment), with
 *   more restrictive rules layered on top:
 *   - Worktree + sandbox: external_directory is allowed (no prompt)
 *   - Worktree + non-sandbox: external_directory is denied (no prompt)
 * - In-place loops omit the blanket allow-all so opencode still consults the
 *   user's global config (and the plugin's `permission.ask` hook), but we
 *   *must* return a non-empty session ruleset. Returning `undefined` causes
 *   opencode to skip the plugin hook entirely and route `ask` rules directly
 *   to a TUI prompt that, in plugin-launched loop sessions, never resolves
 *   the reply back to the paused tool. The forge-specific tool denies are
 *   sufficient to keep the session-level evaluation path active.
 *
 * Per-agent tool restrictions are also enforced by opencode's per-agent
 * `tools` map (see `src/config.ts`), but session-level denies are included
 * here so the worktree blanket allow-all does not accidentally permit them,
 * and so in-place loops continue to evaluate at the session level.
 *
 * Worktree completion logs are written by the host session (see
 * `src/hooks/host-side-effects.ts` -> `writeWorktreeCompletionLog`), so the
 * loop session itself does not need an external_directory allow rule for the
 * log path.
 *
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
    rules.push({
      permission: 'external_directory',
      pattern: '*',
      action: isSandbox ? 'allow' : 'deny',
    })
  }

  // Code agent forbidden tools. Placed after any *:allow so findLast picks
  // them up for worktree loops. For in-place loops these denies are the
  // entire session ruleset, which is enough to keep opencode on the
  // session-level evaluation path (and therefore invoking the plugin's
  // permission.ask hook for everything else).
  rules.push(
    { permission: 'review-write',  pattern: '*', action: 'deny' },
    { permission: 'review-delete', pattern: '*', action: 'deny' },
    { permission: 'plan-execute',  pattern: '*', action: 'deny' },
    { permission: 'loop',          pattern: '*', action: 'deny' },
  )

  // Common restrictions for all loop types.
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
 * glob, codesearch, webfetch, websearch, list, task) and review
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
