import { describe, test, expect } from 'vitest'
import { buildPromptModelSelection } from '../../src/utils/tui-client'

describe('buildPromptModelSelection', () => {
  const MODEL = { providerID: 'openai', modelID: 'gpt-4o' }

  test('model + variant returns both fields', () => {
    const result = buildPromptModelSelection(MODEL, 'reasoning')
    expect(result).toEqual({ model: MODEL, variant: 'reasoning' })
  })

  test('model without variant returns only model', () => {
    const result = buildPromptModelSelection(MODEL)
    expect(result).toEqual({ model: MODEL })
  })

  test('variant without model returns only variant', () => {
    const result = buildPromptModelSelection(undefined, 'fast')
    expect(result).toEqual({ variant: 'fast' })
  })

  test('empty variant is omitted', () => {
    const result = buildPromptModelSelection(MODEL, '')
    expect(result).toEqual({ model: MODEL })
  })

  test('no model/no variant returns empty object', () => {
    const result = buildPromptModelSelection(undefined, undefined)
    expect(result).toEqual({})
  })
})
