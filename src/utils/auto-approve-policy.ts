import { findLastIndex } from './array'

/** Permission effect as OpenCode models it. */
export type PermissionEffectLike = 'allow' | 'ask' | 'deny'

/** An OpenCode permission rule with a wildcard action and resource. */
export interface PermissionRuleLike {
  action: string
  resource: string
  effect: PermissionEffectLike
}

/** An extra deny rule applied only while auto-approve is on. */
export interface AutoApproveDenyRule {
  action: string
  resource: string
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

function findLastMatching<T extends { action: string; resource: string }>(
  action: string,
  resource: string,
  rules: readonly T[],
): T | undefined {
  const index = findLastIndex(rules, (rule) => matchesRule(action, resource, rule))
  return index === -1 ? undefined : rules[index]
}

/** Returns the last rule whose action and resource both match, or undefined when none match. */
export function findLastMatchingRule(
  action: string,
  resource: string,
  rules: readonly PermissionRuleLike[],
): PermissionRuleLike | undefined {
  return findLastMatching(action, resource, rules)
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
    const denyRule = findLastMatching(action, resource, denyRules)
    if (denyRule) {
      return {
        effect: 'deny',
        message: `Blocked in auto-approve mode: \`${action} ${resource}\` matches the auto-approve deny rule \`${denyRule.action}: ${denyRule.resource}\`. Continue without it and report what was skipped.`,
      }
    }
  }

  return { effect: 'allow' }
}
