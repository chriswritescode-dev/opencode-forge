import { describe, test, expect } from 'vitest'
import { computeFenceMask } from '../src/utils/markdown-fences'

describe('computeFenceMask', () => {
  test('returns empty array for empty input', () => {
    expect(computeFenceMask([])).toEqual([])
  })

  test('returns all false when no fences present', () => {
    expect(computeFenceMask(['intro', 'plain', 'text'])).toEqual([false, false, false])
  })

  test('balanced fence: opening line and inner lines true, closing line and following lines false', () => {
    const lines = ['intro', '```', 'inside', 'code', '```', 'after']
    expect(computeFenceMask(lines)).toEqual([false, true, true, true, false, false])
  })

  test('language-tagged opener toggles fence state', () => {
    const lines = ['```ts', 'const x = 1', '```', 'after']
    expect(computeFenceMask(lines)).toEqual([true, true, false, false])
  })

  test('unbalanced opener leaves the tail true', () => {
    const lines = ['intro', '```', 'more', 'stuff']
    expect(computeFenceMask(lines)).toEqual([false, true, true, true])
  })
})
