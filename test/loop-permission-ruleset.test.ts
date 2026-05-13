import { describe, test, expect } from 'bun:test'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../src/constants/loop'

describe('buildLoopPermissionRuleset', () => {
  test('worktree + sandbox ruleset: allow-all first, external_directory denied, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'deny' },
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan_exit',          pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('worktree + non-sandbox ruleset: allow-all first, external_directory denied, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'deny' },
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan_exit',          pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('EMITS session-level denies for code-agent tool exclusions (auditor now runs in separate session)', () => {
    const required = ['review-write', 'review-delete', 'loop']
    for (const isSandbox of [true, false]) {
      const rules = buildLoopPermissionRuleset()
      for (const tool of required) {
        expect(rules.find((r) => r.permission === tool && r.action === 'deny')).toBeDefined()
      }
    }
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  test('sandbox audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    
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
    expect(rules.some(r => r.permission === 'loop-cancel' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-status' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })

  test('non-sandbox audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset()
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
