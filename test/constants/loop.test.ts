import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  it('no opts (in-place): returns deny-only ruleset (no blanket allow, no external_directory rule)', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-execute', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('isWorktree: false: returns deny-only ruleset (no blanket allow)', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false })
    expect(rules).toEqual([
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-execute', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('isWorktree: true: rules[0] is *:*:allow; rules[1] is external_directory:*:deny; length 9', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true })
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-execute', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('isWorktree: true, isSandbox: true: rules[0] is *:*:allow; rules[1] is external_directory:*:allow; length 9', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true, isSandbox: true })
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-execute', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('isWorktree: false, isSandbox: true: sandbox flag ignored for in-place (still deny-only)', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false, isSandbox: true })
    expect(rules).toEqual([
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-execute', pattern: '*', action: 'deny' },
      { permission: 'loop', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
    ])
  })

  it('ordering assertion: when isWorktree: true, index of *:*:allow is strictly less than index of every deny rule', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true })
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

  it('isSandbox: true: external_directory is allow', () => {
    const rules = buildAuditSessionPermissionRuleset({ isSandbox: true })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'allow' })
  })

  it('isSandbox: false: external_directory is deny', () => {
    const rules = buildAuditSessionPermissionRuleset({ isSandbox: false })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })
})
