import { describe, test, expect } from 'vitest'
import {
  buildAuditSessionPermissionRuleset,
  buildLoopPermissionRuleset,
  buildPostActionPermissionRuleset,
  CODE_GRAPH_MCP_PERMISSION,
  isCodeGraphEnabled,
  resolveLoopPermissionOptions,
} from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('isCodeGraphEnabled', () => {
  test('defaults to enabled when the config is absent', () => {
    expect(isCodeGraphEnabled(undefined)).toBe(true)
  })

  test('defaults to enabled when codeGraph or enabled is omitted', () => {
    expect(isCodeGraphEnabled({} as PluginConfig)).toBe(true)
    expect(isCodeGraphEnabled({ codeGraph: { install: true } })).toBe(true)
  })

  test('returns false only when explicitly disabled', () => {
    expect(isCodeGraphEnabled({ codeGraph: { enabled: false } })).toBe(false)
    expect(isCodeGraphEnabled({ codeGraph: { enabled: true } })).toBe(true)
  })
})

describe('codegraph MCP deny in loop rulesets', () => {
  const builders = {
    loop: buildLoopPermissionRuleset,
    postAction: buildPostActionPermissionRuleset,
    audit: buildAuditSessionPermissionRuleset,
  }

  for (const [name, build] of Object.entries(builders)) {
    test(`${name} ruleset ends with the codegraph_* deny when code graph is enabled`, () => {
      const rules = build(resolveLoopPermissionOptions(undefined))
      expect(rules.at(-1)).toEqual({ permission: CODE_GRAPH_MCP_PERMISSION, pattern: '*', action: 'deny' })
    })

    test(`${name} ruleset has no codegraph_* rule when code graph is disabled`, () => {
      const rules = build(resolveLoopPermissionOptions({ codeGraph: { enabled: false } }))
      expect(rules.some((rule) => rule.permission === CODE_GRAPH_MCP_PERMISSION)).toBe(false)
    })
  }

  test('the last rule matching a codegraph MCP tool is the deny, after the blanket allow', () => {
    const rules = buildLoopPermissionRuleset(resolveLoopPermissionOptions(undefined))
    const lastMatch = rules.findLast((rule) => new RegExp(`^${rule.permission.replace(/\*/g, '.*')}$`).test('codegraph_codegraph_explore'))
    expect(lastMatch?.action).toBe('deny')
  })
})
