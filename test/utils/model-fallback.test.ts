import { describe, test, expect } from 'vitest'
import { parseModelString } from '../../src/utils/model-fallback'

describe('parseModelString', () => {
  test('parses valid model string with provider and model', () => {
    const result = parseModelString('anthropic/claude-3-5-sonnet')
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' })
  })

  test('returns undefined for undefined input', () => {
    expect(parseModelString(undefined)).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(parseModelString('')).toBeUndefined()
  })

  test('returns undefined for string without slash', () => {
    expect(parseModelString('anthropic')).toBeUndefined()
  })

  test('returns undefined for string with trailing slash', () => {
    expect(parseModelString('anthropic/')).toBeUndefined()
  })

  test('returns undefined for string with leading slash', () => {
    expect(parseModelString('/claude-3-5-sonnet')).toBeUndefined()
  })
})
