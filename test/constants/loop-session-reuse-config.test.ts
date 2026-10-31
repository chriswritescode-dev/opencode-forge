import { describe, test, expect } from 'vitest'
import {
  DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT,
  DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT,
  collectSessionReuseConfigWarnings,
  parseSessionReuseConfig,
  resolveSessionReuseContextPercent,
} from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('parseSessionReuseConfig', () => {
  test('defaults both roles when unset', () => {
    const parsed = parseSessionReuseConfig(undefined)

    expect(parsed.coderContextPercent).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.auditorContextPercent).toBe(DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.warnings).toEqual([])
  })

  test('accepts finite percentages between 0 and 100, including 0', () => {
    const parsed = parseSessionReuseConfig({ coderContextPercent: 0, auditorContextPercent: 100 })

    expect(parsed.coderContextPercent).toBe(0)
    expect(parsed.auditorContextPercent).toBe(100)
    expect(parsed.warnings).toEqual([])
  })

  test('falls back to the default and warns for out-of-range values', () => {
    const parsed = parseSessionReuseConfig({ coderContextPercent: 101, auditorContextPercent: -1 })

    expect(parsed.coderContextPercent).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.auditorContextPercent).toBe(DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.warnings[0]).toContain('loop.sessionReuse.coderContextPercent is ignored')
    expect(parsed.warnings[1]).toContain('loop.sessionReuse.auditorContextPercent is ignored')
  })

  test('falls back to the default and warns for non-finite and non-numeric values', () => {
    const parsed = parseSessionReuseConfig({ coderContextPercent: Number.POSITIVE_INFINITY, auditorContextPercent: '50' })

    expect(parsed.coderContextPercent).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.auditorContextPercent).toBe(DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.warnings).toHaveLength(2)
  })

  test('warns and uses both defaults when the value is not an object', () => {
    const parsed = parseSessionReuseConfig(50)

    expect(parsed.coderContextPercent).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.auditorContextPercent).toBe(DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT)
    expect(parsed.warnings).toEqual([
      'loop.sessionReuse is ignored: expected an object with "coderContextPercent" and "auditorContextPercent"',
    ])
  })

  test('collectSessionReuseConfigWarnings returns the parser warnings', () => {
    const config: PluginConfig = { loop: { sessionReuse: { coderContextPercent: 250 } } }

    expect(collectSessionReuseConfigWarnings(config)).toEqual([
      `loop.sessionReuse.coderContextPercent is ignored: expected a finite number between 0 and 100, using the default ${DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT}`,
    ])
  })

  test('collectSessionReuseConfigWarnings is empty for a valid config', () => {
    const config: PluginConfig = { loop: { sessionReuse: { coderContextPercent: 25, auditorContextPercent: 40 } } }

    expect(collectSessionReuseConfigWarnings(config)).toEqual([])
  })
})

describe('resolveSessionReuseContextPercent', () => {
  test('resolves each role independently', () => {
    const config: PluginConfig = { loop: { sessionReuse: { coderContextPercent: 0, auditorContextPercent: 75 } } }

    expect(resolveSessionReuseContextPercent(config, 'code')).toBe(0)
    expect(resolveSessionReuseContextPercent(config, 'auditor')).toBe(75)
  })

  test('defaults both roles when the loop config is absent', () => {
    expect(resolveSessionReuseContextPercent({}, 'code')).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
    expect(resolveSessionReuseContextPercent(undefined, 'auditor')).toBe(DEFAULT_AUDITOR_SESSION_REUSE_CONTEXT_PERCENT)
  })

  test('falls back to the default for an invalid configured percent', () => {
    const config: PluginConfig = { loop: { sessionReuse: { coderContextPercent: 101 } } }

    expect(resolveSessionReuseContextPercent(config, 'code')).toBe(DEFAULT_CODER_SESSION_REUSE_CONTEXT_PERCENT)
  })
})
