import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  it('default (non-sandbox): rules[0] is *:*:allow; rules[1] is external_directory:*:deny; length 9', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'external_directory', pattern: '/tmp', action: 'allow' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('isSandbox: true: rules[0] is *:*:allow; rules[1] is external_directory:*:deny; length 10', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'external_directory', pattern: '/tmp', action: 'allow' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('ordering assertion: index of *:*:allow is strictly less than index of every deny rule', () => {
    const rules = buildLoopPermissionRuleset()
    const allowIndex = rules.findIndex(r => r.permission === '*' && r.pattern === '*' && r.action === 'allow')
    const denyIndices = rules
      .map((r, i) => (r.action === 'deny' ? i : -1))
      .filter(i => i !== -1)

    expect(allowIndex).toBeGreaterThanOrEqual(0)
    denyIndices.forEach(denyIndex => {
      expect(allowIndex).toBeLessThan(denyIndex)
    })
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  it('includes *:*:allow as first rule', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
  })

  it('isSandbox: true: external_directory is deny', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  it('isSandbox: false: external_directory is deny', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })
})
