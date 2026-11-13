import { findLastIndex } from './array'
import { z } from 'zod'
import type { AutoApproveDenyRule } from '../types'

export type { AutoApproveDenyRule }

const autoApproveDenyEntrySchema = z.looseObject({
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  pattern: z.unknown().optional(),
})

export type PermissionEffectLike = 'allow' | 'ask' | 'deny'

export type AutoApproveDecision = { effect: 'allow' } | { effect: 'deny'; message: string }

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

export function findLastMatchingRule<T extends { action: string; resource: string }>(
  action: string,
  resource: string,
  rules: readonly T[],
): T | undefined {
  const index = findLastIndex(rules, (rule) => matchesRule(action, resource, rule))
  return index === -1 ? undefined : rules[index]
}

export interface ParsedAutoApproveDenyRules {
  rules: AutoApproveDenyRule[]
  warnings: string[]
}

export function parseAutoApproveDenyRules(
  raw: readonly AutoApproveDenyRule[] | null | undefined,
): ParsedAutoApproveDenyRules {
  if (raw === undefined || raw === null) return { rules: [], warnings: [] }
  const entries = z.array(z.unknown()).safeParse(raw)
  if (!entries.success) {
    return { rules: [], warnings: ['autoApprove.deny is ignored: expected an array of { action, resource } rules'] }
  }

  const rules: AutoApproveDenyRule[] = []
  const warnings: string[] = []
  entries.data.forEach((entry, i) => {
    const candidate = autoApproveDenyEntrySchema.safeParse(entry)
    if (!candidate.success || candidate.data.action === undefined || candidate.data.resource === undefined) {
      const patternHint =
        candidate.success && Object.hasOwn(candidate.data, 'pattern') ? ' (use "resource", not "pattern")' : ''
      warnings.push(`autoApprove.deny entry ${i} is ignored: expected non-empty string "action" and "resource"${patternHint}`)
      return
    }
    rules.push({ action: candidate.data.action, resource: candidate.data.resource })
  })
  return { rules, warnings }
}

export function resolveAutoApproveDecision(input: {
  action: string
  resources: readonly string[]
  denyRules: readonly AutoApproveDenyRule[]
}): AutoApproveDecision {
  const { action, resources, denyRules } = input

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
