import { describe, it, expect } from 'vitest'
import {
  parseLoopPermissionRules,
  resolveLoopPermissionRules,
  collectLoopPermissionConfigWarnings,
} from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('parseLoopPermissionRules', () => {
  it('returns empty rules and warnings for undefined/null config', () => {
    expect(parseLoopPermissionRules(undefined)).toEqual({ rules: [], warnings: [] })
    expect(parseLoopPermissionRules(null)).toEqual({ rules: [], warnings: [] })
  })

  it('warns and returns empty when raw is not an object', () => {
    for (const bad of ['nope', 42, ['allow']]) {
      const result = parseLoopPermissionRules(bad)
      expect(result.rules).toEqual([])
      expect(result.warnings).toEqual([
        'loop.permissions is ignored: expected an object with "allow" and/or "deny" arrays',
      ])
    }
  })

  it('treats a bare string deny entry as pattern "*"', () => {
    expect(parseLoopPermissionRules({ deny: ['webfetch'] })).toEqual({
      rules: [{ permission: 'webfetch', pattern: '*', action: 'deny' }],
      warnings: [],
    })
  })

  it('preserves the pattern verbatim for object entries', () => {
    expect(parseLoopPermissionRules({ deny: [{ permission: 'bash', pattern: 'git push *' }] })).toEqual({
      rules: [{ permission: 'bash', pattern: 'git push *', action: 'deny' }],
      warnings: [],
    })
  })

  it('defaults a blank or missing pattern to "*"', () => {
    expect(parseLoopPermissionRules({ deny: [{ permission: 'bash' }, { permission: 'read', pattern: '  ' }] })).toEqual({
      rules: [
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'deny' },
      ],
      warnings: [],
    })
  })

  it('places allow rules before deny rules', () => {
    const result = parseLoopPermissionRules({ allow: ['webfetch'], deny: ['bash'] })
    expect(result.rules.map((r) => r.permission)).toEqual(['webfetch', 'bash'])
    expect(result.rules.map((r) => r.action)).toEqual(['allow', 'deny'])
  })

  it('lets a user deny win over a user allow for the same permission', () => {
    const result = parseLoopPermissionRules({ allow: ['bash'], deny: [{ permission: 'bash', pattern: 'git *' }] })
    expect(result.rules).toEqual([
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: 'git *', action: 'deny' },
    ])
  })

  it('drops Forge-managed permissions, each producing exactly one warning', () => {
    const result = parseLoopPermissionRules({
      allow: ['*', 'external_directory', 'question', 'plan-write', 'loop-status', 'edit'],
    })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.allow entry "*" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.allow entry "external_directory" is ignored: Forge manages this permission for every loop and audit session — use loop.allowExternalDirectories instead',
      'loop.permissions.allow entry "question" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.allow entry "plan-write" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.allow entry "loop-status" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.allow entry "edit" is ignored: Forge manages this permission for every loop and audit session',
    ])
  })

  it('drops malformed entries with a warning and never throws', () => {
    const result = parseLoopPermissionRules({
      deny: [42, null, '   ', { pattern: 'x' }, { permission: '  ' }],
    })
    expect(result.rules).toEqual([])
    expect(result.warnings).toHaveLength(5)
    for (const w of result.warnings) {
      expect(w).toMatch(/^loop\.permissions\.deny\[\d+\] is ignored: expected a tool name or \{ permission, pattern \}$/)
    }
  })

  it('drops entries with a present non-string pattern instead of defaulting to "*"', () => {
    const result = parseLoopPermissionRules({
      deny: [
        { permission: 'bash', pattern: 42 },
        { permission: 'read', pattern: { nope: true } },
        { permission: 'write', pattern: ['a', 'b'] },
      ],
    })
    expect(result.rules).toEqual([])
    expect(result.warnings).toHaveLength(3)
    for (const w of result.warnings) {
      expect(w).toMatch(/^loop\.permissions\.deny\[\d+\] is ignored: expected a tool name or \{ permission, pattern \}$/)
    }
  })

  it('does not let a numeric pattern become a blanket rule', () => {
    const result = parseLoopPermissionRules({ deny: [{ permission: 'bash', pattern: 42 }] })
    expect(result.rules).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  it('skips a present-but-non-array allow/deny with a warning naming the key', () => {
    const result = parseLoopPermissionRules({ allow: 'bash', deny: 'read' })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.allow is ignored: expected an array',
      'loop.permissions.deny is ignored: expected an array',
    ])
  })

  it('deduplicates identical permission|pattern|action triples, keeping the first', () => {
    const result = parseLoopPermissionRules({
      allow: ['webfetch', 'webfetch', { permission: 'webfetch' }],
    })
    expect(result.rules).toEqual([{ permission: 'webfetch', pattern: '*', action: 'allow' }])
    expect(result.warnings).toEqual([])
  })
})

describe('resolveLoopPermissionRules / collectLoopPermissionConfigWarnings', () => {
  it('resolve empty rules for an undefined config', () => {
    expect(resolveLoopPermissionRules(undefined)).toEqual([])
    expect(collectLoopPermissionConfigWarnings(undefined)).toEqual([])
  })

  it('delegates to parseLoopPermissionRules from the config', () => {
    const config: PluginConfig = { loop: { permissions: { deny: ['webfetch'] } } }
    expect(resolveLoopPermissionRules(config)).toEqual([
      { permission: 'webfetch', pattern: '*', action: 'deny' },
    ])
    expect(collectLoopPermissionConfigWarnings(config)).toEqual([])
  })
})
