type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * - Worktree loops get a blanket allow-all (isolated environment), with
 *   more restrictive rules layered on top:
 *   - Worktree + sandbox: external_directory is allowed (no prompt)
 *   - Worktree + non-sandbox: external_directory is denied (no prompt)
 * - In-place loops return `undefined` so opencode falls back to the user's
 *   global permission config (allowing rm/edit/etc. to prompt normally).
 *   Forge-specific tool denies (review-*, plan-execute, loop) are enforced
 *   per-agent via the `tools.exclude` map in src/agents/code.ts.
 *
 * Per-agent tool restrictions are enforced by opencode's per-agent `tools` map
 * (see `src/config.ts`), not at the session level. However, now that the auditor
 * runs in a separate session (not a subtask), we add explicit session-level denies
 * for tools the code agent should not call (review-write, review-delete, plan-*, loop)
 * for worktree loops where the blanket allow-all would otherwise let them through.
 *
 * Worktree completion logs are written by the host session (see
 * `src/hooks/loop.ts` -> `writeWorktreeCompletionLog`), so the loop session
 * itself does not need an external_directory allow rule for the log path.
 */
/**
 * @param options.isWorktree - Defaults to false (in-place loop). Worktree loops are isolated.
 * @param options.isSandbox - Defaults to false (non-sandbox). Sandbox provides container isolation.
 * @returns The ruleset for worktree loops, or `undefined` for in-place loops
 *          (defers to user's global permission config).
 */
export function buildLoopPermissionRuleset(
  options?: { isWorktree?: boolean; isSandbox?: boolean },
): PermissionRule[] | undefined {
  const isWorktree = options?.isWorktree ?? false
  const isSandbox = options?.isSandbox ?? false

  // In-place loops: defer to user's global permission config so rm/edit/etc.
  // prompt normally. Forge tool denies are enforced via per-agent tools.exclude.
  if (!isWorktree) return undefined

  const rules: PermissionRule[] = []

  // Blanket allow-all for worktree loops (isolated environment).
  // More restrictive rules below layer on top of this.
  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  // External directory access: explicit rule to avoid prompting.
  rules.push({
    permission: 'external_directory',
    pattern: '*',
    action: isSandbox ? 'allow' : 'deny',
  })

  // Code agent forbidden tools (enforced at session level so worktree's
  // *:allow above does not accidentally permit them).
  rules.push(
    { permission: 'review-write',  pattern: '*', action: 'deny' },
    { permission: 'review-delete', pattern: '*', action: 'deny' },
    { permission: 'plan-execute',  pattern: '*', action: 'deny' },
    { permission: 'loop',          pattern: '*', action: 'deny' },
  )

  // Common restrictions for worktree loops
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
