import { describe, test, expect } from 'vitest'
import {
  matchPermissionWildcard,
  findLastMatchingRule,
  parseAutoApproveDenyRules,
  resolveAutoApproveDecision,
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
    const rules = [
      { action: 'shell', resource: 'git *', effect: 'ask' },
      { action: 'shell', resource: 'git push *', effect: 'allow' },
    ]
    expect(findLastMatchingRule('shell', 'git push origin main', rules)?.effect).toBe('allow')
  })

  test('returns undefined when nothing matches', () => {
    const rules = [{ action: 'shell', resource: 'git *', effect: 'ask' }]
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
  test('allows when no deny rule matches', () => {
    expect(
      resolveAutoApproveDecision({
        action: 'shell',
        resources: ['git push origin main'],
        denyRules: [],
      }).effect,
    ).toBe('allow')
  })

  test('denies when a configured deny rule matches', () => {
    const decision = resolveAutoApproveDecision({
      action: 'shell',
      resources: ['rm -rf /tmp/build'],
      denyRules: [{ action: 'shell', resource: 'rm -rf *' }],
    })
    expect(decision.effect).toBe('deny')
    if (decision.effect === 'deny') {
      expect(decision.message).toContain('rm -rf *')
      expect(decision.message).toContain('rm -rf /tmp/build')
    }
  })

  test('denies when any one of several resources hits a deny rule', () => {
    const decision = resolveAutoApproveDecision({
      action: 'shell',
      resources: ['ls', 'git push origin main'],
      denyRules: [{ action: 'shell', resource: 'git push *' }],
    })
    expect(decision.effect).toBe('deny')
    if (decision.effect === 'deny') {
      expect(decision.message).toContain('git push origin main')
    }
  })
})
