import { describe, test, expect } from 'bun:test'
import { buildLoopPermissionRuleset } from '../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  test('worktree + sandbox ruleset: allow-all first, external_directory allowed, operational denies last', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true, isSandbox: true })
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'allow' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('worktree + non-sandbox ruleset: allow-all first, external_directory denied, operational denies last', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false })
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('in-place ruleset: no blanket allow, no external_directory rule, only operational denies', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false })
    expect(rules).toEqual([
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('does NOT emit session-level denies for code-agent tool exclusions', () => {
    // These tools must remain callable at the session level so the auditor subtask
    // can use them. Per-agent `tools` maps still restrict the code agent itself.
    const forbidden = ['review-write', 'review-delete', 'plan-execute', 'plan-write', 'plan-edit', 'loop']
    for (const isWorktree of [true, false]) {
      for (const isSandbox of [true, false]) {
        const rules = buildLoopPermissionRuleset({ isWorktree, isSandbox })
        for (const tool of forbidden) {
          expect(rules.find((r) => r.permission === tool)).toBeUndefined()
        }
      }
    }
  })
})
