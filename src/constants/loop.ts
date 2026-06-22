export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

export interface LoopPermissionRulesetOptions {
  sandbox?: boolean
  /**
   * Absolute directory paths to grant access to via `external_directory` allow rules.
   * These are layered AFTER the blanket `external_directory` deny so last-match-wins
   * permission resolution grants access to these paths while keeping all others denied.
   */
  allowDirectories?: string[]
}

/**
 * Builds `external_directory` allow rules for the configured directories. Each directory
 * produces two rules: an exact-path allow and a recursive (`/**`) allow. Returns an empty
 * array when no directories are configured, preserving the default deny-only behavior.
 */
function buildExternalDirectoryAllowRules(allowDirectories: string[] = []): PermissionRule[] {
  const rules: PermissionRule[] = []
  for (const dir of allowDirectories) {
    if (typeof dir !== 'string') continue
    const trimmed = dir.trim().replace(/\/+$/, '')
    if (!trimmed) continue
    rules.push({ permission: 'external_directory', pattern: trimmed, action: 'allow' })
    rules.push({ permission: 'external_directory', pattern: `${trimmed}/**`, action: 'allow' })
  }
  return rules
}

function buildShellPermissionRules(sandbox: boolean): PermissionRule[] {
  return sandbox
    ? [
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'sh',   pattern: '*', action: 'allow' },
      ]
    : [
        { permission: 'sh',   pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'allow' },
      ]
}

/**
 * Builds the permission ruleset for loop sessions.
 *
 * All loops use worktree isolation with a blanket allow-all, plus
 * explicit deny rules for review tools, plan tools, and loop-management tools.
 * External directory access is always denied to prevent unauthorized file system traversal.
 */
export function buildLoopPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const sandbox = options.sandbox ?? true
  const rules: PermissionRule[] = []

  // Blanket allow-all for worktree loops (isolated environment).
  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  // External directory access is always denied so loop work stays confined to
  // the isolated worktree, regardless of whether shell commands run on the host
  // or inside a sandbox container.
  rules.push({
    permission: 'external_directory',
    pattern: '*',
    action: 'deny',
  })

  // Opt-in external directories: allow rules layered after the deny so last-match-wins
  // grants access to configured paths (e.g. an Obsidian vault) while others stay denied.
  rules.push(...buildExternalDirectoryAllowRules(options.allowDirectories))

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

  // Shell routing. Sandbox loops expose sh (container shell) and hide host bash;
  // worktree-only loops expose bash and hide sh because there is no sandbox.
  rules.push(
    ...buildShellPermissionRules(sandbox),
    { permission: 'loop-cancel', pattern: '*', action: 'deny' },
    { permission: 'loop-status', pattern: '*', action: 'deny' },
  )

  return rules
}

/**
 * Builds the permission ruleset for audit sessions.
 *
 * Audit sessions run the auditor agent in an isolated session. The ruleset
 * allows read-only operations (read, grep, glob, codesearch, webfetch,
 * websearch, list, task) and review tools (review-write, review-delete), but
 * denies direct code mutation tools.
 *
 * External directory access is always denied to prevent unauthorized file system traversal.
 */
export function buildAuditSessionPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const sandbox = options.sandbox ?? true
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    // Opt-in external directories: allow rules layered after the deny (last-match-wins).
    ...buildExternalDirectoryAllowRules(options.allowDirectories),
    // Audit sessions must not mutate code.
    { permission: 'edit',        pattern: '*', action: 'deny' },
    { permission: 'write',       pattern: '*', action: 'deny' },
    { permission: 'multiedit',   pattern: '*', action: 'deny' },
    { permission: 'apply_patch', pattern: '*', action: 'deny' },
    ...buildShellPermissionRules(sandbox),
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
