import { describe, it, expect } from 'bun:test'
import { isSandboxEnabled } from '../src/sandbox/context'
import type { PluginConfig } from '../src/types'

describe('isSandboxEnabled', () => {
  it('returns false when mode is off', () => {
    const config = { sandbox: { mode: 'off' as const } } as PluginConfig
    expect(isSandboxEnabled(config, {})).toBe(false)
  })

  it('returns false when sandboxManager is null', () => {
    const config = { sandbox: { mode: 'docker' as const } } as PluginConfig
    expect(isSandboxEnabled(config, null)).toBe(false)
  })

  it('returns true when mode is docker and manager exists', () => {
    const config = { sandbox: { mode: 'docker' as const } } as PluginConfig
    expect(isSandboxEnabled(config, {})).toBe(true)
  })
})
