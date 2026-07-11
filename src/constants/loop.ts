import { resolveOpencodeToolOutputDir, resolveForgeTempDir } from '../utils/opencode-paths'
import type { PluginConfig } from '../types'

export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/**
 * Resolves the full set of external directories loop/audit sessions may access: the shared temp
 * directory (always, default `/tmp/oc-forge`) plus any user-configured `loop.allowExternalDirectories`.
 * Single source of truth so every permission-ruleset call site grants the same paths regardless of
 * sandbox mode. (opencode's tool-output directory is added separately inside the ruleset builder.)
 */
export function resolveLoopAllowedDirectories(config: PluginConfig | undefined): string[] {
  return [
    resolveForgeTempDir(config?.loop?.tmpDir),
    ...(config?.loop?.allowExternalDirectories ?? []),
  ]
}

export interface LoopPermissionRulesetOptions {
  /**
   * Absolute directory paths to grant access to via `external_directory` allow rules.
   * These are layered AFTER the blanket `external_directory` deny so last-match-wins
   * permission resolution grants access to these paths while keeping all others denied.
   */
  allowDirectories?: string[]
}

/**
 * Builds `external_directory` allow rules. Each directory produces two rules: an exact-path
 * allow and a recursive (`/**`) allow.
 *
 * opencode's tool-output (truncation) directory is always included: opencode spills large tool
 * outputs there and references the saved file by absolute host path, so loop/audit sessions must
 * be able to read it without prompting in the unattended loop. User-configured directories are
 * layered on top. Both are added AFTER the blanket `external_directory` deny so last-match-wins
 * resolution grants access to these paths while all others stay denied.
 */
function buildExternalDirectoryAllowRules(allowDirectories: string[] = []): PermissionRule[] {
  const rules: PermissionRule[] = []
  const dirs = [resolveOpencodeToolOutputDir(), ...allowDirectories]
  for (const dir of dirs) {
    if (typeof dir !== 'string') continue
    const trimmed = dir.trim().replace(/\/+$/, '')
    if (!trimmed) continue
    rules.push({ permission: 'external_directory', pattern: trimmed, action: 'allow' })
    rules.push({ permission: 'external_directory', pattern: `${trimmed}/**`, action: 'allow' })
  }
  return rules
}

/**
 * Builds the permission ruleset for loop sessions.
 *
 * All loops use worktree isolation with a blanket allow-all, plus
 * explicit deny rules for review tools, plan tools, and loop-management tools.
 * External directory access is denied by default; opencode's tool-output directory (and any
 * user-configured directories) are then allowed so spilled tool outputs remain readable.
 */
export function buildLoopPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const rules: PermissionRule[] = []

  // Blanket allow-all for worktree loops (isolated environment).
  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  // External directory access is denied by default so loop work stays confined to
  // the isolated worktree, regardless of whether shell commands run on the host
  // or inside a sandbox container.
  rules.push({
    permission: 'external_directory',
    pattern: '*',
    action: 'deny',
  })

  // Allow rules layered after the deny so last-match-wins grants access: opencode's
  // tool-output directory (always) plus any opt-in configured paths (e.g. an Obsidian vault),
  // while all other external directories stay denied.
  rules.push(...buildExternalDirectoryAllowRules(options.allowDirectories))

  // Code agent forbidden tools. Placed after *:allow so findLast picks them up.
  rules.push(
    { permission: 'review-write',  pattern: '*', action: 'deny' },
    { permission: 'review-delete', pattern: '*', action: 'deny' },
    { permission: 'plan',          pattern: '*', action: 'deny' },
    { permission: 'plan_enter',    pattern: '*', action: 'deny' },
    { permission: 'plan_exit',     pattern: '*', action: 'deny' },
    { permission: 'execute-plan',  pattern: '*', action: 'deny' },
    { permission: 'execute-goal',  pattern: '*', action: 'deny' },
    { permission: 'question',      pattern: '*', action: 'deny' },
  )

  // Shell commands always use opencode's native bash tool (covered by the blanket allow);
  // sandbox loops are routed into their container by the forge shell shim, not by permissions.
  rules.push(
    { permission: 'loop-cancel',   pattern: '*', action: 'deny' },
    { permission: 'loop-status',   pattern: '*', action: 'deny' },
    { permission: 'launch-group',  pattern: '*', action: 'deny' },
    { permission: 'group-status',  pattern: '*', action: 'deny' },
    { permission: 'group-cancel',  pattern: '*', action: 'deny' },
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
 * External directory access is denied by default; opencode's tool-output directory (and any
 * user-configured directories) are then allowed so spilled tool outputs remain readable.
 */
export function buildAuditSessionPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    // Allow rules layered after the deny (last-match-wins): tool-output directory (always)
    // plus any opt-in configured directories.
    ...buildExternalDirectoryAllowRules(options.allowDirectories),
    // Audit sessions must not mutate code.
    { permission: 'edit',        pattern: '*', action: 'deny' },
    { permission: 'write',       pattern: '*', action: 'deny' },
    { permission: 'multiedit',   pattern: '*', action: 'deny' },
    { permission: 'apply_patch', pattern: '*', action: 'deny' },
    // Auditors must never launch loops or manage other loops.
    { permission: 'plan',          pattern: '*', action: 'deny' },
    { permission: 'plan_enter',    pattern: '*', action: 'deny' },
    { permission: 'plan_exit',     pattern: '*', action: 'deny' },
    { permission: 'execute-plan',  pattern: '*', action: 'deny' },
    { permission: 'execute-goal',  pattern: '*', action: 'deny' },
    { permission: 'question',      pattern: '*', action: 'deny' },
    { permission: 'loop-cancel',   pattern: '*', action: 'deny' },
    { permission: 'loop-status',   pattern: '*', action: 'deny' },
    { permission: 'launch-group',  pattern: '*', action: 'deny' },
    { permission: 'group-status',  pattern: '*', action: 'deny' },
    { permission: 'group-cancel',  pattern: '*', action: 'deny' },
  ]
  return rules
}
