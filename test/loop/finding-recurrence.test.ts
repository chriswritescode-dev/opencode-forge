import { describe, test, expect } from 'vitest'
import {
  RECURRENCE_ESCALATION_THRESHOLD,
  findingRecurrenceKey,
  bumpRecurrence,
} from '../../src/loop/finding-recurrence'

describe('finding-recurrence', () => {
  describe('RECURRENCE_ESCALATION_THRESHOLD', () => {
    test('is 3', () => {
      expect(RECURRENCE_ESCALATION_THRESHOLD).toBe(3)
    })
  })

  describe('findingRecurrenceKey', () => {
    test('generates key with section index', () => {
      const key = findingRecurrenceKey({ file: 'src/foo.ts', line: 10, sectionIndex: 2 })
      expect(key).toBe('2:src/foo.ts:10')
    })

    test('generates key with null section index', () => {
      const key = findingRecurrenceKey({ file: 'src/bar.ts', line: 42, sectionIndex: null })
      expect(key).toBe('x:src/bar.ts:42')
    })
  })

  describe('bumpRecurrence', () => {
    test('first appearance returns count of 1', () => {
      const prev = new Map<string, number>()
      const result = bumpRecurrence(prev, ['a:file:1'])
      expect(result.get('a:file:1')).toBe(1)
      expect(result.size).toBe(1)
    })

    test('consecutive appearance increments count', () => {
      const prev = new Map<string, number>([['a:file:1', 2]])
      const result = bumpRecurrence(prev, ['a:file:1'])
      expect(result.get('a:file:1')).toBe(3)
      expect(result.size).toBe(1)
    })

    test('disappearing key is absent from result (reset)', () => {
      const prev = new Map<string, number>([['a:file:1', 3]])
      const result = bumpRecurrence(prev, [])
      expect(result.has('a:file:1')).toBe(false)
      expect(result.size).toBe(0)
    })

    test('mixed set: some increment, some new, some reset', () => {
      const prev = new Map<string, number>([
        ['a:file:1', 2],
        ['a:file:gone', 1],
      ])
      const result = bumpRecurrence(prev, ['a:file:1', 'b:new:2'])
      expect(result.get('a:file:1')).toBe(3)    // incremented
      expect(result.get('b:new:2')).toBe(1)      // new
      expect(result.has('a:file:gone')).toBe(false) // reset (absent from current)
      expect(result.size).toBe(2)
    })

    test('does not mutate the previous map', () => {
      const prev = new Map<string, number>([['a:file:1', 1]])
      const result = bumpRecurrence(prev, ['a:file:1'])
      expect(prev.get('a:file:1')).toBe(1)  // unchanged
      expect(result.get('a:file:1')).toBe(2) // incremented
    })
  })
})
