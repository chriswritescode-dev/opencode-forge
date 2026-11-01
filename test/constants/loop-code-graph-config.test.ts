import { describe, test, expect } from 'vitest'
import { isLoopCodeGraphEnabled } from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('isLoopCodeGraphEnabled', () => {
  test('defaults to enabled when the config is absent', () => {
    expect(isLoopCodeGraphEnabled(undefined)).toBe(true)
  })

  test('defaults to enabled when loop or codeGraph is omitted', () => {
    expect(isLoopCodeGraphEnabled({ loop: {} } as PluginConfig)).toBe(true)
    expect(isLoopCodeGraphEnabled({ loop: { codeGraph: {} } } as PluginConfig)).toBe(true)
  })

  test('returns false only when explicitly disabled', () => {
    expect(isLoopCodeGraphEnabled({ loop: { codeGraph: { enabled: false } } } as PluginConfig)).toBe(false)
  })
})
