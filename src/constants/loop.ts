export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Builds the permission ruleset for loop sessions.
 *
 * All loops use worktree isolation with a blanket allow-all, plus
 * explicit deny rules for review tools, plan tools, and loop-management tools.
 * External directory access is always denied to prevent unauthorized file system traversal.
 */
export function buildLoopPermissionRuleset(): PermissionRule[] {
  const rules: PermissionRule[] = []

  // Blanket allow-all for worktree loops (isolated environment).
  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  // External directory access: always denied. Bash runs inside the sandbox
  // while read/write run on the host, so any shared path (including /tmp)
  // would resolve to different filesystems and create false-positive escape
  // hatches. Worktree-only access keeps host and sandbox views consistent.
  rules.push({
    permission: 'external_directory',
    pattern: '*',
    action: 'deny',
  })

  // Code agent forbidden tools. Placed after *:allow so findLast picks them up.
  rules.push(
    { permission: 'review-write',  pattern: '*', action: 'deny' },
    { permission: 'review-delete', pattern: '*', action: 'deny' },
    { permission: 'plan',          pattern: '*', action: 'deny' },
    { permission: 'plan_enter',    pattern: '*', action: 'deny' },
    { permission: 'plan_exit',     pattern: '*', action: 'deny' },
    { permission: 'loop',          pattern: '*', action: 'deny' },
    { permission: 'question',      pattern: '*', action: 'deny' },
  )

  // Common restrictions. Plain bash runs on the host, so loop sessions deny it.
  // sh is the sanctioned shell path for loops and executes inside the
  // active sandbox container; allow it explicitly after bash:*:deny so the
  // session ruleset communicates that intent instead of relying on *:*:allow.
  rules.push(
    { permission: 'bash',        pattern: '*', action: 'deny' },
    { permission: 'sh',          pattern: '*', action: 'allow' },
    { permission: 'loop-cancel', pattern: '*', action: 'deny' },
    { permission: 'loop-status', pattern: '*', action: 'deny' },
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
 * External directory access is always denied to prevent unauthorized file system traversal.
 */
export function buildAuditSessionPermissionRuleset(): PermissionRule[] {
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    // Audit sessions must not mutate code.
    { permission: 'edit',        pattern: '*', action: 'deny' },
    { permission: 'write',       pattern: '*', action: 'deny' },
    { permission: 'multiedit',   pattern: '*', action: 'deny' },
    { permission: 'apply_patch', pattern: '*', action: 'deny' },
    { permission: 'bash',        pattern: '*', action: 'deny' },
    { permission: 'sh',          pattern: '*', action: 'allow' },
    // Auditors must never launch loops or manage other loops.
    { permission: 'plan',         pattern: '*', action: 'deny' },
    { permission: 'plan_enter',   pattern: '*', action: 'deny' },
    { permission: 'plan_exit',    pattern: '*', action: 'deny' },
    { permission: 'loop',         pattern: '*', action: 'deny' },
    { permission: 'question',     pattern: '*', action: 'deny' },
    { permission: 'loop-cancel',  pattern: '*', action: 'deny' },
    { permission: 'loop-status',  pattern: '*', action: 'deny' },
  ]
  return rules
}
