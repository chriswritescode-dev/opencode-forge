import { describe, it, expect } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset, resolveLoopAllowedDirectories } from '../../src/constants/loop'
import { resolveOpencodeToolOutputDir, DEFAULT_FORGE_TMP_DIR } from '../../src/utils/opencode-paths'

const TOOL_OUTPUT_DIR = resolveOpencodeToolOutputDir()
const TOOL_OUTPUT_ALLOW_RULES = [
  { permission: 'external_directory', pattern: TOOL_OUTPUT_DIR, action: 'allow' as const },
  { permission: 'external_directory', pattern: `${TOOL_OUTPUT_DIR}/**`, action: 'allow' as const },
]

describe('buildLoopPermissionRuleset', () => {
  it('emits the full loop ruleset in order (no shell-specific rules)', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      ...TOOL_OUTPUT_ALLOW_RULES,
      { permission: 'review-write', pattern: '*', action: 'deny' },
      { permission: 'review-delete', pattern: '*', action: 'deny' },
      { permission: 'plan', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'execute-plan', pattern: '*', action: 'deny' },
      { permission: 'execute-goal', pattern: '*', action: 'deny' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'loop-cancel', pattern: '*', action: 'deny' },
      { permission: 'loop-status', pattern: '*', action: 'deny' },
      { permission: 'launch-group', pattern: '*', action: 'deny' },
      { permission: 'group-status', pattern: '*', action: 'deny' },
      { permission: 'group-cancel', pattern: '*', action: 'deny' },
    ])
  })

  it('denies execute-goal in both loop and audit rulesets so active sessions cannot recurse', () => {
    const loopRules = buildLoopPermissionRuleset()
    const auditRules = buildAuditSessionPermissionRuleset()
    expect(loopRules).toContainEqual({ permission: 'execute-goal', pattern: '*', action: 'deny' })
    expect(auditRules).toContainEqual({ permission: 'execute-goal', pattern: '*', action: 'deny' })
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
})

describe('buildAuditSessionPermissionRuleset', () => {
  it('includes *:*:allow as first rule', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
  })

  it('external_directory is deny', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  it('emits no sh or bash permission rules', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules.some(r => r.permission === 'sh' || r.permission === 'bash')).toBe(false)
  })
})

describe('external directory allowlist', () => {
  const VAULT = '/Users/chris/Documents/Obsidian/GFPRO'

  it('loop ruleset allows only the tool-output directory when allowDirectories is omitted', () => {
    const rules = buildLoopPermissionRuleset()
    const allowPatterns = rules
      .filter(r => r.permission === 'external_directory' && r.action === 'allow')
      .map(r => r.pattern)
    expect(allowPatterns).toEqual([TOOL_OUTPUT_DIR, `${TOOL_OUTPUT_DIR}/**`])
  })

  it('loop ruleset adds exact + recursive allow rules for each configured directory', () => {
    const rules = buildLoopPermissionRuleset({ allowDirectories: [VAULT] })
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: VAULT, action: 'allow' })
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: `${VAULT}/**`, action: 'allow' })
  })

  it('loop ruleset places external_directory allow rules AFTER the deny (last-match-wins)', () => {
    const rules = buildLoopPermissionRuleset({ allowDirectories: [VAULT] })
    const denyIdx = rules.findIndex(r => r.permission === 'external_directory' && r.pattern === '*' && r.action === 'deny')
    const allowIdx = rules.findIndex(r => r.permission === 'external_directory' && r.pattern === VAULT && r.action === 'allow')
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    expect(allowIdx).toBeGreaterThan(denyIdx)
  })

  it('audit ruleset adds allow rules after the deny too', () => {
    const rules = buildAuditSessionPermissionRuleset({ allowDirectories: [VAULT] })
    const denyIdx = rules.findIndex(r => r.permission === 'external_directory' && r.pattern === '*' && r.action === 'deny')
    const allowIdx = rules.findIndex(r => r.permission === 'external_directory' && r.pattern === `${VAULT}/**` && r.action === 'allow')
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    expect(allowIdx).toBeGreaterThan(denyIdx)
  })

  it('trims trailing slashes and ignores empty/blank entries', () => {
    const rules = buildLoopPermissionRuleset({ allowDirectories: [`${VAULT}/`, '', '   '] })
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: VAULT, action: 'allow' })
    const allowRules = rules.filter(r => r.permission === 'external_directory' && r.action === 'allow')
    // Always-on tool-output dir (exact + recursive) + the one valid configured directory
    // (exact + recursive) = 4 rules; blank/invalid entries are ignored.
    expect(allowRules).toHaveLength(4)
  })
})

describe('resolveLoopAllowedDirectories', () => {
  it('always includes the default temp dir, even with no config', () => {
    expect(resolveLoopAllowedDirectories(undefined)).toEqual([DEFAULT_FORGE_TMP_DIR])
    expect(resolveLoopAllowedDirectories({})).toEqual([DEFAULT_FORGE_TMP_DIR])
  })

  it('layers configured external directories after the temp dir', () => {
    const config = { loop: { allowExternalDirectories: ['/vault', '/notes'] } }
    expect(resolveLoopAllowedDirectories(config)).toEqual([DEFAULT_FORGE_TMP_DIR, '/vault', '/notes'])
  })

  it('honors a configured tmpDir override', () => {
    const config = { loop: { tmpDir: '/scratch/forge', allowExternalDirectories: ['/vault'] } }
    expect(resolveLoopAllowedDirectories(config)).toEqual(['/scratch/forge', '/vault'])
  })

  it('grants the temp dir in the loop ruleset', () => {
    const rules = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(undefined) })
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: DEFAULT_FORGE_TMP_DIR, action: 'allow' })
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: `${DEFAULT_FORGE_TMP_DIR}/**`, action: 'allow' })
  })
})
