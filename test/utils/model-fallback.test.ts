import { describe, test, expect } from 'bun:test'
import { parseModelString, resolveDecomposerModel } from '../../src/utils/model-fallback'

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

describe('resolveDecomposerModel', () => {
  test('all three sources unset returns undefined', () => {
    const result = resolveDecomposerModel({
      decomposerModel: undefined,
      auditorModel: undefined,
      executionModel: undefined,
    })
    expect(result).toBeUndefined()
  })

  test('only executionModel set returns execution model', () => {
    const result = resolveDecomposerModel({
      decomposerModel: undefined,
      auditorModel: undefined,
      executionModel: 'anthropic/claude-3-5-sonnet',
    })
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' })
  })

  test('only auditorModel set returns auditor model', () => {
    const result = resolveDecomposerModel({
      decomposerModel: undefined,
      auditorModel: 'openai/gpt-4o',
      executionModel: undefined,
    })
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
  })

  test('only decomposerModel set returns decomposer model', () => {
    const result = resolveDecomposerModel({
      decomposerModel: 'google/gemini-pro',
      auditorModel: undefined,
      executionModel: undefined,
    })
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-pro' })
  })

  test('decomposerModel wins when all three are set', () => {
    const result = resolveDecomposerModel({
      decomposerModel: 'a/x',
      auditorModel: 'b/y',
      executionModel: 'c/z',
    })
    expect(result).toEqual({ providerID: 'a', modelID: 'x' })
  })

  test('auditorModel wins over executionModel when decomposerModel is absent', () => {
    const result = resolveDecomposerModel({
      decomposerModel: undefined,
      auditorModel: 'b/y',
      executionModel: 'c/z',
    })
    expect(result).toEqual({ providerID: 'b', modelID: 'y' })
  })

  test('empty strings treated as unset', () => {
    const result = resolveDecomposerModel({
      decomposerModel: '',
      auditorModel: '',
      executionModel: '',
    })
    expect(result).toBeUndefined()
  })

  test('empty strings skip to next source', () => {
    const result = resolveDecomposerModel({
      decomposerModel: '',
      auditorModel: 'b/y',
      executionModel: 'c/z',
    })
    expect(result).toEqual({ providerID: 'b', modelID: 'y' })
  })

  test('invalid model strings are treated as unset', () => {
    const result = resolveDecomposerModel({
      decomposerModel: 'bad',
      auditorModel: 'also-bad',
      executionModel: 'valid/model',
    })
    expect(result).toEqual({ providerID: 'valid', modelID: 'model' })
  })
})
