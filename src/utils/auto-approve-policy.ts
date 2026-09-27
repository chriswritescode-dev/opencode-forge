import { findLastIndex } from './array'
import { isRecord } from './is-record'
import type { AutoApproveDenyRule } from '../types'

export type { AutoApproveDenyRule }

/** Permission effect as OpenCode models it. */
export type PermissionEffectLike = 'allow' | 'ask' | 'deny'

/** An OpenCode permission rule with a wildcard action and resource. */
export interface PermissionRuleLike {
  action: string
  resource: string
  effect: PermissionEffectLike
}

/** The outcome of auto-approving a request: always allow or deny, never a prompt. */
export type AutoApproveDecision = { effect: 'allow' } | { effect: 'deny'; message: string }

/**
 * Matches an input against an OpenCode permission wildcard pattern. Exact port of
 * OpenCode's matcher so `*`, `?`, regex metacharacters, backslash normalization,
 * and the trailing `" *"` optional-suffix behavior are identical.
 */
export function matchPermissionWildcard(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(normalized)
}

function matchesRule(
  action: string,
  resource: string,
  rule: { action: string; resource: string },
): boolean {
  return matchPermissionWildcard(action, rule.action) && matchPermissionWildcard(resource, rule.resource)
}

/** Returns the last rule whose action and resource both match, or undefined when none match. */
export function findLastMatchingRule<T extends { action: string; resource: string }>(
  action: string,
  resource: string,
  rules: readonly T[],
): T | undefined {
  const index = findLastIndex(rules, (rule) => matchesRule(action, resource, rule))
  return index === -1 ? undefined : rules[index]
}

/**
 * Parses the `autoApprove.deny` config value into usable rules. Every entry that is not a record
 * with a non-empty string `action` and `resource` is dropped and reported as a warning rather than
 * throwing, so a malformed config never blocks plugin startup.
 */
export function parseAutoApproveDenyRules(raw: unknown): { rules: AutoApproveDenyRule[]; warnings: string[] } {
  if (raw === undefined || raw === null) return { rules: [], warnings: [] }
  if (!Array.isArray(raw)) {
    return { rules: [], warnings: ['autoApprove.deny is ignored: expected an array of { action, resource } rules'] }
  }

  const rules: AutoApproveDenyRule[] = []
  const warnings: string[] = []
  raw.forEach((entry, i) => {
    const valid =
      isRecord(entry) &&
      typeof entry.action === 'string' &&
      entry.action.length > 0 &&
      typeof entry.resource === 'string' &&
      entry.resource.length > 0
    if (!valid) {
      const patternHint = isRecord(entry) && 'pattern' in entry ? ' (use "resource", not "pattern")' : ''
      warnings.push(`autoApprove.deny entry ${i} is ignored: expected non-empty string "action" and "resource"${patternHint}`)
      return
    }
    rules.push({ action: entry.action as string, resource: entry.resource as string })
  })
  return { rules, warnings }
}

/**
 * Resolves an auto-approved request to allow or deny. A resource whose last matching
 * OpenCode rule is `ask`, or that matches a configured deny rule, denies the whole
 * request; requests no rule matched fall back to allow.
 */
export function resolveAutoApproveDecision(input: {
  action: string
  resources: readonly string[]
  rules: readonly PermissionRuleLike[]
  denyRules: readonly AutoApproveDenyRule[]
}): AutoApproveDecision {
  const { action, resources, rules, denyRules } = input

  for (const resource of resources) {
    const rule = findLastMatchingRule(action, resource, rules)
    if (rule?.effect === 'ask') {
      return {
        effect: 'deny',
        message: `Blocked in auto-approve mode: \`${action} ${resource}\` matches the ask rule \`${rule.action}: ${rule.resource}\`, which requires manual approval. Continue without it and report what was skipped.`,
      }
    }
  }

  for (const resource of resources) {
    const denyRule = findLastMatchingRule(action, resource, denyRules)
    if (denyRule) {
      return {
        effect: 'deny',
        message: `Blocked in auto-approve mode: \`${action} ${resource}\` matches the auto-approve deny rule \`${denyRule.action}: ${denyRule.resource}\`. Continue without it and report what was skipped.`,
      }
    }
  }

  return { effect: 'allow' }
}
