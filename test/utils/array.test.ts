import { describe, test, expect } from 'vitest'
import { findLastIndex } from '../../src/utils/array'

describe('findLastIndex', () => {
  test('returns the index of the last matching item', () => {
    expect(findLastIndex([1, 2, 3, 2], (item) => item === 2)).toBe(3)
  })

  test('returns -1 when no item matches', () => {
    expect(findLastIndex([1, 2, 3], (item) => item === 4)).toBe(-1)
  })

  test('returns -1 for an empty list', () => {
    expect(findLastIndex([], () => true)).toBe(-1)
  })
})
