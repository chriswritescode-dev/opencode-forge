import { isRecord } from '../utils/is-record'
import type { PluginConfig, LoopPermissionsConfig } from '../types'

export type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'deny' }

/** Maximum number of plan sections a loop may execute. Shared by the
 *  deterministic decomposer, section bootstrap, the TUI inline-plan preview,
 *  and the plan-adjust cap so all four agree. */
export const MAX_TOTAL_SECTIONS = 24

/**
 * Tools that author the session-scoped plan of record. Architect agents may
 * call them; implementation, audit, splitter, and loop permission rules deny
 * this one list rather than repeating the names.
 */
export const PLAN_AUTHORING_TOOL_NAMES = ['plan-write', 'plan-edit'] as const

/** Structural deny names shared by both loop and audit rulesets, in emit order. */
export const SHARED_STRUCTURAL_DENY_PERMISSIONS = [
  ...PLAN_AUTHORING_TOOL_NAMES,
  'execute-plan',
  'execute-goal',
  'question',
  'loop-cancel',
  'loop-status',
  'launch-group',
  'group-status',
  'group-cancel',
] as const

/** Structural deny names exclusive to loop sessions (review tools). */
export const LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS = ['review-write', 'review-delete'] as const

/** Structural deny names exclusive to audit sessions (code-mutation tools). */
export const AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS = ['edit', 'write'] as const

/** Permissions config may not name: the blanket allow, the external_directory key, and
 *  every structural deny. Loop/audit rulesets are the only legal consumers of these. */
export const FORGE_MANAGED_PERMISSIONS: ReadonlySet<string> = new Set([
  '*',
  'external_directory',
  ...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...SHARED_STRUCTURAL_DENY_PERMISSIONS,
])

/** Loop-protocol and core tools a loop cannot function without. Only a *blanket* deny (pattern `*`)
 *  of one of these is rejected: a loop that cannot read its findings, section plan, or
 *  plan-of-record — or cannot run `bash` or `read` at all — silently burns iterations to
 *  maxIterations with nothing pointing at the config. A scoped deny such as
 *  `{ permission: 'bash', pattern: 'git push *' }` is honoured. */
export const FORGE_REQUIRED_PERMISSIONS: ReadonlySet<string> = new Set([
  'review-read',
  'plan-read',
  'section-read',
  'plan-adjust',
  'bash',
  'read',
])

function denyRulesFor(names: readonly string[]): PermissionRule[] {
  return names.map((permission) => ({ permission, pattern: '*', action: 'deny' as const }))
}

/** Normalizes one configured rule into a typed `PermissionRule`, or `null` if it must be dropped. */
function parseLoopPermissionEntry(index: number, raw: unknown, warnings: string[]): PermissionRule | null {
  const drop = (): null => {
    warnings.push(`loop.permissions.deny[${index}] is ignored: expected a tool name or { permission, pattern }`)
    return null
  }

  if (typeof raw === 'string') {
    const permission = raw.trim()
    if (!permission) return drop()
    return { permission, pattern: '*', action: 'deny' }
  }

  if (isRecord(raw)) {
    const obj = raw as { permission?: unknown; pattern?: unknown }
    if (typeof obj.permission !== 'string') return drop()
    const permission = obj.permission.trim()
    if (!permission) return drop()
    if (obj.pattern !== undefined && typeof obj.pattern !== 'string') return drop()
    const pattern = typeof obj.pattern === 'string' ? obj.pattern.trim() : ''
    return { permission, pattern: pattern || '*', action: 'deny' }
  }

  return drop()
}

/**
 * Parses the user-supplied `loop.permissions` config into typed rules plus warnings for dropped
 * entries. Only `deny` entries are supported; a legacy `allow` array is ignored with a migration
 * warning. Entries naming a Forge-managed permission are dropped, as are blanket (`*`) denies of a
 * Forge-required permission. Returns the same `PermissionRule` shape used by the loop and audit
 * rulesets, so parsed rules layer directly onto them.
 */
export function parseLoopPermissionRules(raw: unknown): { rules: PermissionRule[]; warnings: string[] } {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { rules: [], warnings }

  if (!isRecord(raw)) {
    warnings.push('loop.permissions is ignored: expected an object with a "deny" array')
    return { rules: [], warnings }
  }

  const config = raw as LoopPermissionsConfig
  const rules: PermissionRule[] = []
  const seen = new Set<string>()

  if (raw.allow !== undefined) {
    warnings.push('loop.permissions.allow is ignored: only deny entries are supported')
  }

  if (config.deny !== undefined) {
    if (!Array.isArray(config.deny)) {
      warnings.push('loop.permissions.deny is ignored: expected an array')
    } else {
      for (let i = 0; i < config.deny.length; i++) {
        const rule = parseLoopPermissionEntry(i, config.deny[i], warnings)
        if (!rule) continue
        if (rule.pattern === '*' && FORGE_REQUIRED_PERMISSIONS.has(rule.permission)) {
          warnings.push(
            `loop.permissions.deny entry "${rule.permission}" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead`,
          )
          continue
        }
        if (FORGE_MANAGED_PERMISSIONS.has(rule.permission)) {
          const suffix =
            rule.permission === 'external_directory'
              ? ' — loops allow external directories; sandbox mounts are the boundary (add read-only mounts with loop.allowExternalDirectories)'
              : ''
          warnings.push(
            `loop.permissions.deny entry "${rule.permission}" is ignored: Forge manages this permission for every loop and audit session${suffix}`,
          )
          continue
        }
        const signature = `${rule.permission}|${rule.pattern}|${rule.action}`
        if (seen.has(signature)) continue
        seen.add(signature)
        rules.push(rule)
      }
    }
  }

  return { rules, warnings }
}

/** Resolves the parsed `loop.permissions` rules for a config, or an empty list when unset. */
export function resolveLoopPermissionRules(config: PluginConfig | undefined): PermissionRule[] {
  return parseLoopPermissionRules(config?.loop?.permissions).rules
}

/**
 * Resolves the full ruleset options (configured `loop.permissions` rules) for a config. Single call
 * every ruleset construction site uses so the configured rules can never diverge.
 */
export function resolveLoopPermissionOptions(config: PluginConfig | undefined): LoopPermissionRulesetOptions {
  return {
    extraRules: resolveLoopPermissionRules(config),
  }
}

/** Collects warnings produced while parsing `loop.permissions` (dropped or ignored entries). */
export function collectLoopPermissionConfigWarnings(config: PluginConfig | undefined): string[] {
  return parseLoopPermissionRules(config?.loop?.permissions).warnings
}

/**
 * Resolves the user-configured external directories bind-mounted read-only into loop sandboxes, so
 * host file tools and in-container tools see the same tree.
 */
export function resolveLoopAllowedDirectories(config: PluginConfig | undefined): string[] {
  return config?.loop?.allowExternalDirectories ?? []
}

export interface LoopPermissionRulesetOptions {
  /**
   * User-configured rules (`loop.permissions`) inserted after the blanket allow and before
   * Forge's structural denies, so they can never override a structural deny.
   */
  extraRules?: PermissionRule[]
}

/**
 * Builds the permission ruleset for loop sessions.
 *
 * All loops use worktree isolation with a blanket allow-all, plus explicit deny rules for review
 * tools, plan tools, and loop-management tools. External directories are covered by the blanket
 * allow so an unattended loop never waits on an approval: in a sandboxed loop the sandbox mounts
 * are the boundary (the sandbox tool hook refuses host file tools outside them), and a loop with
 * the sandbox disabled has host access.
 */
export function buildLoopPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const rules: PermissionRule[] = []

  // Blanket allow-all for worktree loops (isolated environment).
  rules.push({ permission: '*', pattern: '*', action: 'allow' })

  // User-configured rules layered before Forge's structural denies so they can never
  // override a structural deny.
  rules.push(...(options.extraRules ?? []))

  // Code agent forbidden tools. Placed after *:allow so findLast picks them up.
  rules.push(...denyRulesFor([...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, ...SHARED_STRUCTURAL_DENY_PERMISSIONS]))

  return rules
}

/**
 * Builds the permission ruleset for audit sessions.
 *
 * Audit sessions run the auditor agent in an isolated session. The ruleset
 * allows read-only operations (read, grep, glob, codesearch, webfetch,
 * websearch, list, task) and review tools (review-write, review-delete), but
 * denies direct code mutation tools. External directories follow the same policy as loop sessions.
 */
export function buildAuditSessionPermissionRuleset(options: LoopPermissionRulesetOptions = {}): PermissionRule[] {
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'allow' },
    // User-configured rules layered before Forge's structural denies.
    ...(options.extraRules ?? []),
    // Audit sessions must not mutate code, must never launch loops or manage other loops.
    // Placed after *:allow so findLast picks them up.
    ...denyRulesFor([...AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS, ...SHARED_STRUCTURAL_DENY_PERMISSIONS]),
  ]
  return rules
}
