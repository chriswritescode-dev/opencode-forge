import { describe, test, expect } from 'vitest'
import {
  matchPermissionWildcard,
  findLastMatchingRule,
  parseAutoApproveDenyRules,
  resolveAutoApproveDecision,
  type PermissionRuleLike,
} from '../../src/utils/auto-approve-policy'

describe('matchPermissionWildcard', () => {
  test('matches an exact string', () => {
    expect(matchPermissionWildcard('git push', 'git push')).toBe(true)
    expect(matchPermissionWildcard('git pull', 'git push')).toBe(false)
  })

  test('matches any input against a bare star', () => {
    expect(matchPermissionWildcard('anything at all', '*')).toBe(true)
  })

  test('expands ? to a single character', () => {
    expect(matchPermissionWildcard('cat', 'c?t')).toBe(true)
    expect(matchPermissionWildcard('ct', 'c?t')).toBe(false)
  })

  test('treats a trailing " *" as an optional suffix', () => {
    expect(matchPermissionWildcard('git push', 'git push *')).toBe(true)
    expect(matchPermissionWildcard('git push origin main', 'git push *')).toBe(true)
    expect(matchPermissionWildcard('git pushy', 'git push *')).toBe(false)
  })

  test('treats regex metacharacters as literals', () => {
    expect(matchPermissionWildcard('file.name', 'file.name')).toBe(true)
    expect(matchPermissionWildcard('fileXname', 'file.name')).toBe(false)
    expect(matchPermissionWildcard('a+b', 'a+b')).toBe(true)
    expect(matchPermissionWildcard('aab', 'a+b')).toBe(false)
  })

  test('normalizes backslashes on both input and pattern', () => {
    expect(matchPermissionWildcard('C:\\Users\\x', 'C:/Users/*')).toBe(true)
    expect(matchPermissionWildcard('a/b', 'a\\b')).toBe(true)
  })
})

describe('findLastMatchingRule', () => {
  test('returns the last matching rule', () => {
    const rules: PermissionRuleLike[] = [
      { action: 'shell', resource: 'git *', effect: 'ask' },
      { action: 'shell', resource: 'git push *', effect: 'allow' },
    ]
    expect(findLastMatchingRule('shell', 'git push origin main', rules)?.effect).toBe('allow')
  })

  test('returns undefined when nothing matches', () => {
    const rules: PermissionRuleLike[] = [{ action: 'shell', resource: 'git *', effect: 'ask' }]
    expect(findLastMatchingRule('read', 'git push', rules)).toBeUndefined()
    expect(findLastMatchingRule('shell', 'git push', [])).toBeUndefined()
  })
})

describe('parseAutoApproveDenyRules', () => {
  test('returns no rules and no warnings for undefined and null', () => {
    expect(parseAutoApproveDenyRules(undefined)).toEqual({ rules: [], warnings: [] })
    expect(parseAutoApproveDenyRules(null)).toEqual({ rules: [], warnings: [] })
  })

  test('warns and returns no rules when the value is not an array', () => {
    expect(parseAutoApproveDenyRules({ action: 'shell', resource: '*' })).toEqual({
      rules: [],
      warnings: ['autoApprove.deny is ignored: expected an array of { action, resource } rules'],
    })
  })

  test('keeps valid entries and ignores invalid ones with indexed warnings', () => {
    const result = parseAutoApproveDenyRules([
      { action: 'shell', resource: 'rm -rf *' },
      { action: '', resource: '*' },
      { action: 'shell' },
      'not-an-object',
    ])
    expect(result.rules).toEqual([{ action: 'shell', resource: 'rm -rf *' }])
    expect(result.warnings).toEqual([
      'autoApprove.deny entry 1 is ignored: expected non-empty string "action" and "resource"',
      'autoApprove.deny entry 2 is ignored: expected non-empty string "action" and "resource"',
      'autoApprove.deny entry 3 is ignored: expected non-empty string "action" and "resource"',
    ])
  })

  test('points a "pattern" key at "resource"', () => {
    const result = parseAutoApproveDenyRules([{ action: 'shell', pattern: 'rm -rf *' }])
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'autoApprove.deny entry 0 is ignored: expected non-empty string "action" and "resource" (use "resource", not "pattern")',
    ])
  })
})

describe('resolveAutoApproveDecision', () => {
  test('denies when an ask rule is the last match', () => {
    const rules: PermissionRuleLike[] = [
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]
    const decision = resolveAutoApproveDecision({
      action: 'shell',
      resources: ['git push origin main'],
      rules,
      denyRules: [],
    })
    expect(decision.effect).toBe('deny')
    if (decision.effect === 'deny') {
      expect(decision.message).toContain('git push *')
      expect(decision.message).toContain('git push origin main')
      expect(decision.message).toContain('requires manual approval')
    }
  })

  test('allows when a later allow rule overrides an earlier ask', () => {
    const rules: PermissionRuleLike[] = [
      { action: 'shell', resource: 'git *', effect: 'ask' },
      { action: 'shell', resource: 'git push *', effect: 'allow' },
    ]
    expect(
      resolveAutoApproveDecision({
        action: 'shell',
        resources: ['git push origin main'],
        rules,
        denyRules: [],
      }).effect,
    ).toBe('allow')
  })

  test('denies when a later ask rule overrides an earlier allow', () => {
    const rules: PermissionRuleLike[] = [
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]
    expect(
      resolveAutoApproveDecision({
        action: 'shell',
        resources: ['git push origin main'],
        rules,
        denyRules: [],
      }).effect,
    ).toBe('deny')
  })

  test('allows when no rule matches', () => {
    expect(
      resolveAutoApproveDecision({
        action: 'shell',
        resources: ['git status'],
        rules: [{ action: 'shell', resource: 'git push *', effect: 'ask' }],
        denyRules: [],
      }).effect,
    ).toBe('allow')
  })

  test('denies when a configured deny rule matches', () => {
    const decision = resolveAutoApproveDecision({
      action: 'shell',
      resources: ['rm -rf /tmp/build'],
      rules: [],
      denyRules: [{ action: 'shell', resource: 'rm -rf *' }],
    })
    expect(decision.effect).toBe('deny')
    if (decision.effect === 'deny') {
      expect(decision.message).toContain('rm -rf *')
      expect(decision.message).toContain('rm -rf /tmp/build')
    }
  })

  test('denies when any one of several resources hits an ask rule', () => {
    const rules: PermissionRuleLike[] = [
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]
    const decision = resolveAutoApproveDecision({
      action: 'shell',
      resources: ['ls', 'git push origin main'],
      rules,
      denyRules: [],
    })
    expect(decision.effect).toBe('deny')
    if (decision.effect === 'deny') {
      expect(decision.message).toContain('git push origin main')
    }
  })
})
