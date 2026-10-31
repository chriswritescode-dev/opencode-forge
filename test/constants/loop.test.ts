import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset, buildPostActionPermissionRuleset, resolveLoopAllowedDirectories, resolveLoopPermissionOptions, MAX_TOTAL_SECTIONS, PLAN_AUTHORING_TOOL_NAMES, FORGE_MANAGED_PERMISSIONS, AUTONOMOUS_ARCHITECT_STRUCTURAL_DENY_PERMISSIONS, LOOP_HANDOFF_TOOL_NAME, LOOP_COMPLETE_TOOL_NAME } from '../../src/constants/loop'

describe('MAX_TOTAL_SECTIONS', () => {
  it('is the single canonical section cap', () => {
    expect(MAX_TOTAL_SECTIONS).toBe(24)
  })
})

describe('PLAN_AUTHORING_TOOL_NAMES', () => {
  it('is the single list of plan-authoring tools every deny path derives from', () => {
    expect(PLAN_AUTHORING_TOOL_NAMES).toEqual(['plan-write', 'plan-edit', 'goal-write'])
  })
})

describe('AUTONOMOUS_ARCHITECT_STRUCTURAL_DENY_PERMISSIONS', () => {
  it('is every shared structural deny except the plan-of-record tools the autonomous architect keeps', () => {
    expect([...AUTONOMOUS_ARCHITECT_STRUCTURAL_DENY_PERMISSIONS].sort()).toEqual(
      ['execute-plan', 'goal-cancel', 'goal-status', 'goal-write', 'loop-cancel', 'loop-status', 'question'],
    )
  })
})

describe('FORGE_MANAGED_PERMISSIONS', () => {
  it('contains the blanket allow, external_directory, and every structural deny name', () => {
    for (const permission of ['*', 'external_directory', ...PLAN_AUTHORING_TOOL_NAMES, 'question', 'review-write', 'edit', LOOP_HANDOFF_TOOL_NAME, LOOP_COMPLETE_TOOL_NAME]) {
      expect(FORGE_MANAGED_PERMISSIONS.has(permission)).toBe(true)
    }
  })
})

describe('buildLoopPermissionRuleset', () => {
  it('emits the full loop ruleset in order (no shell-specific rules)', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan-write', pattern: '*', action: 'deny' },
      { permission: 'plan-edit', pattern: '*', action: 'deny' },
      { permission: 'goal-write', pattern: '*', action: 'deny' },
      { permission: 'execute-plan', pattern: '*', action: 'deny' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
      { permission: 'goal-cancel', pattern: '*', action: 'deny' },
      { permission: 'goal-status', pattern: '*', action: 'deny' },
      { permission: 'loop-complete', pattern: '*', action: 'deny' },
    ])
  })

  it('emits no sh or bash permission rules (native bash is covered by the blanket allow)', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules.some(r => r.permission === 'sh' || r.permission === 'bash')).toBe(false)
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

  it('denies the goal management tools', () => {
    const rules = buildLoopPermissionRuleset()
    for (const tool of ['goal-status', 'goal-cancel']) {
      expect(rules.some(r => r.permission === tool && r.pattern === '*' && r.action === 'deny')).toBe(true)
    }
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  it('includes *:*:allow as first rule', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
  })

  it('emits no external_directory rules, so external directories fall under the blanket allow', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules.some(r => r.permission === 'external_directory')).toBe(false)
  })

  it('emits no sh or bash permission rules', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules.some(r => r.permission === 'sh' || r.permission === 'bash')).toBe(false)
  })

  it('denies goal-write, so the auditor can never author a goal', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules.some(r => r.permission === 'goal-write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })

  it('denies the goal management tools, so the auditor can never manage goals', () => {
    const rules = buildAuditSessionPermissionRuleset()
    for (const tool of ['goal-status', 'goal-cancel']) {
      expect(rules.some(r => r.permission === tool && r.pattern === '*' && r.action === 'deny')).toBe(true)
    }
  })

  it('denies loop-complete but keeps loop-handoff for the auditor', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules).toContainEqual({ permission: LOOP_COMPLETE_TOOL_NAME, pattern: '*', action: 'deny' })
    expect(rules.some(r => r.permission === LOOP_HANDOFF_TOOL_NAME && r.action === 'deny')).toBe(false)
  })
})

describe('buildPostActionPermissionRuleset', () => {
  it('emits the loop ruleset with loop-handoff denied instead of loop-complete', () => {
    const postAction = buildPostActionPermissionRuleset()
    const rules = buildLoopPermissionRuleset()
    expect(postAction).toEqual([
      ...rules.filter(r => r.permission !== LOOP_COMPLETE_TOOL_NAME),
      { permission: LOOP_HANDOFF_TOOL_NAME, pattern: '*', action: 'deny' },
    ])
    expect(postAction.some(r => r.permission === LOOP_COMPLETE_TOOL_NAME && r.action === 'deny')).toBe(false)
    expect(postAction.some(r => r.permission === LOOP_HANDOFF_TOOL_NAME && r.action === 'deny')).toBe(true)
  })

  it('layers configured rules before the structural denies', () => {
    const configured = { permission: 'webfetch', pattern: '*', action: 'deny' as const }
    const rules = buildPostActionPermissionRuleset({ extraRules: [configured] })
    const configuredIdx = rules.findIndex(r => r.permission === 'webfetch')
    const firstStructuralIdx = rules.findIndex(r => r.action === 'deny' && FORGE_MANAGED_PERMISSIONS.has(r.permission))
    expect(configuredIdx).toBeGreaterThan(0)
    expect(configuredIdx).toBeLessThan(firstStructuralIdx)
  })
})

describe('external directories', () => {
  it('neither ruleset emits external_directory rules, so an unattended loop never waits on an approval', () => {
    for (const rules of [buildLoopPermissionRuleset(), buildAuditSessionPermissionRuleset()]) {
      expect(rules.some(r => r.permission === 'external_directory')).toBe(false)
      expect(rules.some(r => r.action !== 'allow' && r.action !== 'deny')).toBe(false)
    }
  })
})

describe('resolveLoopAllowedDirectories', () => {
  it('returns no directories when no config is given', () => {
    expect(resolveLoopAllowedDirectories(undefined)).toEqual([])
    expect(resolveLoopAllowedDirectories({})).toEqual([])
  })

  it('returns only the configured external directories', () => {
    const config = { loop: { allowExternalDirectories: ['/vault', '/notes'] } }
    expect(resolveLoopAllowedDirectories(config)).toEqual(['/vault', '/notes'])
  })
})

describe('configured extraRules', () => {
  const CONFIGURED_DENY = { permission: 'webfetch', pattern: '*', action: 'deny' as const }

  it('omitted extraRules leaves both rulesets unchanged (backward compatibility)', () => {
    expect(buildLoopPermissionRuleset()).toEqual(buildLoopPermissionRuleset({ extraRules: [] }))
    expect(buildAuditSessionPermissionRuleset()).toEqual(buildAuditSessionPermissionRuleset({ extraRules: [] }))
  })

  it('inserts a configured rule after the blanket allow and before the first structural deny, in both rulesets', () => {
    for (const rules of [
      buildLoopPermissionRuleset({ extraRules: [CONFIGURED_DENY] }),
      buildAuditSessionPermissionRuleset({ extraRules: [CONFIGURED_DENY] }),
    ]) {
      expect(rules).toContainEqual(CONFIGURED_DENY)
      const occurrences = rules.filter(r => r.permission === CONFIGURED_DENY.permission && r.action === 'deny').length
      expect(occurrences).toBe(1)

      const configuredIdx = rules.findIndex(r => r.permission === 'webfetch' && r.action === 'deny')
      const firstStructuralDenyIdx = rules.findIndex(r => r.action === 'deny' && FORGE_MANAGED_PERMISSIONS.has(r.permission))
      expect(configuredIdx).toBeGreaterThan(0)
      expect(configuredIdx).toBeLessThan(firstStructuralDenyIdx)
    }
  })
})

describe('resolveLoopPermissionOptions', () => {
  it('resolves the parsed rule from config and leaves external directories to the sandbox mounts', () => {
    const config = { loop: { permissions: { deny: ['webfetch'] }, allowExternalDirectories: ['/vault'] } }
    expect(resolveLoopPermissionOptions(config)).toEqual({
      extraRules: [{ permission: 'webfetch', pattern: '*', action: 'deny' }],
    })
  })

  it('yields empty options when config is undefined', () => {
    expect(resolveLoopPermissionOptions(undefined)).toEqual({ extraRules: [] })
  })
})

describe('config -> resolveLoopPermissionOptions -> ruleset composition', () => {
  const structuralDeniesOf = (rules: ReturnType<typeof buildLoopPermissionRuleset>) =>
    rules.filter((r) => r.action === 'deny' && r.permission !== 'external_directory').map((r) => r.permission)

  for (const build of [buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset]) {
    it(`${build.name} keeps structural denies last when built from a real config`, () => {
      const config = { loop: { permissions: { deny: ['webfetch', { permission: 'bash', pattern: 'git push *' }] } } }
      const rules = build(resolveLoopPermissionOptions(config))

      const configuredIdx = rules.findIndex((r) => r.permission === 'webfetch')
      const scopedIdx = rules.findIndex((r) => r.permission === 'bash' && r.pattern === 'git push *')
      expect(configuredIdx).toBeGreaterThan(-1)
      expect(scopedIdx).toBeGreaterThan(-1)

      // Every structural deny must resolve after the configured rules, so
      // last-match-wins can never let config override one.
      const firstStructuralIdx = rules.findIndex(
        (r) => r.action === 'deny' && FORGE_MANAGED_PERMISSIONS.has(r.permission) && r.permission !== 'external_directory',
      )
      expect(firstStructuralIdx).toBeGreaterThan(configuredIdx)
      expect(firstStructuralIdx).toBeGreaterThan(scopedIdx)
    })

    it(`${build.name} drops a config that tries to undo a structural deny`, () => {
      const before = structuralDeniesOf(build(resolveLoopPermissionOptions(undefined)))
      const after = structuralDeniesOf(
        build(resolveLoopPermissionOptions({ loop: { permissions: { deny: ['question', 'external_directory'] } } })),
      )
      expect(after).toEqual(before)
    })

    it(`${build.name} ignores a blanket deny of a Forge-required tool end to end`, () => {
      const rules = build(resolveLoopPermissionOptions({ loop: { permissions: { deny: ['bash', 'review-read'] } } }))
      expect(rules.some((r) => r.permission === 'bash')).toBe(false)
      expect(rules.some((r) => r.permission === 'review-read')).toBe(false)
    })
  }
})
