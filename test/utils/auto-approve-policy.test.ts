import { describe, test, expect } from 'vitest'
import {
  matchPermissionWildcard,
  findLastMatchingRule,
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
