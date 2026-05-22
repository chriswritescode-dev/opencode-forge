import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  it('default sandbox rules expose sh and hide host bash', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'sh', pattern: '*', action: 'allow' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('sandbox true exposes sh and hides host bash', () => {
    const rules = buildLoopPermissionRuleset({ sandbox: true })
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'sh', pattern: '*', action: 'allow' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('sandbox false exposes host bash and hides sh', () => {
    const rules = buildLoopPermissionRuleset({ sandbox: false })
    expect(rules).toContainEqual({ permission: 'sh', pattern: '*', action: 'deny' })
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' })
    const shDenyIndex = rules.findIndex(r => r.permission === 'sh' && r.action === 'deny')
    const bashAllowIndex = rules.findIndex(r => r.permission === 'bash' && r.action === 'allow')
    expect(bashAllowIndex).toBeGreaterThan(shDenyIndex)
  })

  it('explicitly allows sh after bash is denied', () => {
    const rules = buildLoopPermissionRuleset()
    const bashDenyIndex = rules.findIndex(r => r.permission === 'bash' && r.action === 'deny')
    const shAllowIndex = rules.findIndex(r => r.permission === 'sh' && r.action === 'allow')
    expect(bashDenyIndex).toBeGreaterThanOrEqual(0)
    expect(shAllowIndex).toBeGreaterThan(bashDenyIndex)
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
    const rules = buildAuditSessionPermissionRuleset({ sandbox: false })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  it('audit sandbox false exposes bash and hides sh', () => {
    const rules = buildAuditSessionPermissionRuleset({ sandbox: false })
    expect(rules).toContainEqual({ permission: 'sh', pattern: '*', action: 'deny' })
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' })
  })
})
