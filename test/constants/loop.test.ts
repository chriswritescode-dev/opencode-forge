import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  it('no opts (in-place): returns undefined so opencode falls back to global config', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toBeUndefined()
  })

  it('isWorktree: false: returns undefined', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false })
    expect(rules).toBeUndefined()
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

  it('isWorktree: false, isSandbox: true: still undefined (sandbox flag ignored for in-place)', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false, isSandbox: true })
    expect(rules).toBeUndefined()
  })

  it('ordering assertion: when isWorktree: true, index of *:*:allow is strictly less than index of every deny rule', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true })
    expect(rules).toBeDefined()
    const allowIndex = rules!.findIndex(r => r.permission === '*' && r.pattern === '*' && r.action === 'allow')
    const denyIndices = rules!
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
