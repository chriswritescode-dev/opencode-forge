import { describe, it, expect } from 'vitest'
import {
  parseLoopPermissionRules,
  resolveLoopPermissionRules,
  collectLoopPermissionConfigWarnings,
  FORGE_MANAGED_PERMISSIONS,
  FORGE_REQUIRED_PERMISSIONS,
} from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('parseLoopPermissionRules', () => {
  it('returns empty rules and warnings for undefined/null config', () => {
    expect(parseLoopPermissionRules(undefined)).toEqual({ rules: [], warnings: [] })
    expect(parseLoopPermissionRules(null)).toEqual({ rules: [], warnings: [] })
  })

  it('warns and returns empty when raw is not an object', () => {
    for (const bad of ['nope', 42, ['deny']]) {
      const result = parseLoopPermissionRules(bad)
      expect(result.rules).toEqual([])
      expect(result.warnings).toEqual([
        'loop.permissions is ignored: expected an object with a "deny" array',
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
    expect(parseLoopPermissionRules({ deny: [{ permission: 'webfetch', pattern: 'git push *' }] })).toEqual({
      rules: [{ permission: 'webfetch', pattern: 'git push *', action: 'deny' }],
      warnings: [],
    })
  })

  it('defaults a blank or missing pattern to "*"', () => {
    expect(parseLoopPermissionRules({ deny: [{ permission: 'webfetch' }, { permission: 'task', pattern: '  ' }] })).toEqual({
      rules: [
        { permission: 'webfetch', pattern: '*', action: 'deny' },
        { permission: 'task', pattern: '*', action: 'deny' },
      ],
      warnings: [],
    })
  })

  it('ignores a legacy allow array with a migration warning, producing only deny rules', () => {
    const result = parseLoopPermissionRules({ allow: ['bash'], deny: ['webfetch'] })
    expect(result.rules).toEqual([{ permission: 'webfetch', pattern: '*', action: 'deny' }])
    expect(result.warnings).toEqual([
      'loop.permissions.allow is ignored: only deny entries are supported',
    ])
  })

  it('produces no rules when only a legacy allow array is supplied', () => {
    const result = parseLoopPermissionRules({ allow: ['bash', 'read'] })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.allow is ignored: only deny entries are supported',
    ])
  })

  it('drops Forge-managed permissions, each producing exactly one warning', () => {
    const result = parseLoopPermissionRules({
      deny: ['*', 'external_directory', 'question', 'plan-write', 'loop-status', 'edit'],
    })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.deny entry "*" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.deny entry "external_directory" is ignored: Forge manages this permission for every loop and audit session — use loop.allowExternalDirectories instead',
      'loop.permissions.deny entry "question" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.deny entry "plan-write" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.deny entry "loop-status" is ignored: Forge manages this permission for every loop and audit session',
      'loop.permissions.deny entry "edit" is ignored: Forge manages this permission for every loop and audit session',
    ])
  })

  it('drops blanket denies of Forge-required permissions with a distinct warning', () => {
    const result = parseLoopPermissionRules({
      deny: ['review-read', 'plan-read', 'section-read', 'plan-adjust', 'bash', 'read'],
    })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.deny entry "review-read" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
      'loop.permissions.deny entry "plan-read" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
      'loop.permissions.deny entry "section-read" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
      'loop.permissions.deny entry "plan-adjust" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
      'loop.permissions.deny entry "bash" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
      'loop.permissions.deny entry "read" is ignored: a blanket deny of this tool breaks the loop — scope it with a pattern instead',
    ])
  })

  it('drops an explicit pattern "*" deny of a required permission the same as the bare name', () => {
    const result = parseLoopPermissionRules({ deny: [{ permission: 'bash', pattern: '*' }] })
    expect(result.rules).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  it('honours a scoped deny of a Forge-required permission', () => {
    expect(parseLoopPermissionRules({ deny: [{ permission: 'bash', pattern: 'git push *' }] })).toEqual({
      rules: [{ permission: 'bash', pattern: 'git push *', action: 'deny' }],
      warnings: [],
    })
  })

  it('honours the documented example verbatim so a shipped example can never be dead config', () => {
    const result = parseLoopPermissionRules({
      deny: ['browser_navigate', { permission: 'bash', pattern: 'git push *' }],
    })
    expect(result.rules).toEqual([
      { permission: 'browser_navigate', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
    ])
    expect(result.warnings).toEqual([])
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

  it('warns when allow is present but not an array, and when deny is present but not an array', () => {
    const result = parseLoopPermissionRules({ allow: 'bash', deny: 'read' })
    expect(result.rules).toEqual([])
    expect(result.warnings).toEqual([
      'loop.permissions.allow is ignored: only deny entries are supported',
      'loop.permissions.deny is ignored: expected an array',
    ])
  })

  it('deduplicates identical permission|pattern triples, keeping the first', () => {
    const result = parseLoopPermissionRules({
      deny: ['webfetch', 'webfetch', { permission: 'webfetch' }],
    })
    expect(result.rules).toEqual([{ permission: 'webfetch', pattern: '*', action: 'deny' }])
    expect(result.warnings).toEqual([])
  })
})

describe('FORGE_REQUIRED_PERMISSIONS', () => {
  it('is disjoint from FORGE_MANAGED_PERMISSIONS so the two rejections can never conflict', () => {
    for (const name of FORGE_REQUIRED_PERMISSIONS) {
      expect(FORGE_MANAGED_PERMISSIONS.has(name)).toBe(false)
    }
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
