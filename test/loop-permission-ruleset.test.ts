import { describe, test, expect } from 'bun:test'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  test('worktree + sandbox ruleset: allow-all first, external_directory allowed, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true, isSandbox: true })
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'allow' },
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan-execute',       pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('worktree + non-sandbox ruleset: allow-all first, external_directory denied, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false })
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'deny' },
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan-execute',       pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('in-place ruleset: no blanket allow, no external_directory rule, code-agent denies, then operational denies', () => {
    const rules = buildLoopPermissionRuleset({ isWorktree: false })
    expect(rules).toEqual([
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan-execute',       pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('EMITS session-level denies for code-agent tool exclusions (auditor now runs in separate session)', () => {
    // These tools are now denied at the session level because the auditor runs
    // in a separate session. Per-agent `tools` maps still restrict the code agent.
    const required = ['review-write', 'review-delete', 'plan-execute', 'loop']
    for (const isWorktree of [true, false]) {
      for (const isSandbox of [true, false]) {
        const rules = buildLoopPermissionRuleset({ isWorktree, isSandbox })
        for (const tool of required) {
          expect(rules.find((r) => r.permission === tool && r.action === 'deny')).toBeDefined()
        }
      }
    }
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  test('sandbox audit session ruleset: allow-all, external_directory allowed, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset({ isSandbox: true })
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'allow' })
    
    // Mutation denies
    expect(rules.some(r => r.permission === 'edit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'multiedit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'apply_patch' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    
    // Bash mutation denies
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git commit *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git push *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git reset *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git rm *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git mv *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'rm *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'mv *' && r.action === 'deny')).toBe(true)
    
    // Loop/plan denies
    expect(rules.some(r => r.permission === 'loop' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan-execute' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-cancel' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-status' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })

  test('non-sandbox audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset({ isSandbox: false })
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    
    // All the same mutation denies as sandbox mode
    expect(rules.some(r => r.permission === 'edit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'multiedit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'apply_patch' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git commit *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === 'git push *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })
})
