import { describe, test, expect } from 'vitest'
import {
  createInterjectionStore,
  formatInterjections,
  extractInterjectionText,
  isLoopGeneratedPrompt,
  MAX_QUEUED_INTERJECTIONS,
  type UserInterjection,
} from '../../src/loop/interjections'

describe('createInterjectionStore', () => {
  test('enqueue assigns incrementing ids', () => {
    const store = createInterjectionStore()
    const a = store.enqueue('loop-a', 'first')
    const b = store.enqueue('loop-a', 'second')
    const c = store.enqueue('loop-a', 'third')
    expect(a!.id).toBe(1)
    expect(b!.id).toBe(2)
    expect(c!.id).toBe(3)
  })

  test('enqueue returns null for empty or whitespace-only text', () => {
    const store = createInterjectionStore()
    expect(store.enqueue('loop-a', '')).toBeNull()
    expect(store.enqueue('loop-a', '   ')).toBeNull()
    expect(store.enqueue('loop-a', '\n\t ')).toBeNull()
  })

  test('enqueue strips leading/trailing whitespace', () => {
    const store = createInterjectionStore()
    const entry = store.enqueue('loop-a', '  hello world  ')
    expect(entry!.text).toBe('hello world')
  })

  test('peek returns a snapshot copy that is independent', () => {
    const store = createInterjectionStore()
    store.enqueue('loop-a', 'msg1')
    store.enqueue('loop-a', 'msg2')

    const snapshot = store.peek('loop-a')
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0].text).toBe('msg1')
    expect(snapshot[1].text).toBe('msg2')

    // Mutating the snapshot does not affect the store
    snapshot.pop()
    expect(store.peek('loop-a')).toHaveLength(2)
  })

  test('peek returns empty array for unknown loop', () => {
    const store = createInterjectionStore()
    expect(store.peek('nonexistent')).toEqual([])
  })

  test('remove filters out specific ids, leaving others', () => {
    const store = createInterjectionStore()
    const a = store.enqueue('loop-a', 'keep1')!
    const b = store.enqueue('loop-a', 'remove')!
    const c = store.enqueue('loop-a', 'keep2')!

    store.remove('loop-a', [b.id])
    const remaining = store.peek('loop-a')
    expect(remaining).toHaveLength(2)
    expect(remaining.map(r => r.id)).toEqual([a.id, c.id])
  })

  test('remove with no matching ids leaves queue intact', () => {
    const store = createInterjectionStore()
    store.enqueue('loop-a', 'stay')
    store.remove('loop-a', [999])
    expect(store.peek('loop-a')).toHaveLength(1)
  })

  test('remove deletes the loop key when last item removed', () => {
    const store = createInterjectionStore()
    const a = store.enqueue('loop-a', 'only')!
    store.remove('loop-a', [a.id])
    expect(store.peek('loop-a')).toEqual([])
  })

  test('remove on unknown loop does nothing', () => {
    const store = createInterjectionStore()
    expect(() => store.remove('ghost', [1])).not.toThrow()
  })

  test('capping: queue never exceeds MAX_QUEUED_INTERJECTIONS', () => {
    const store = createInterjectionStore()
    for (let i = 0; i < MAX_QUEUED_INTERJECTIONS + 5; i++) {
      store.enqueue('loop-a', `msg-${i}`)
    }
    const snapshot = store.peek('loop-a')
    expect(snapshot).toHaveLength(MAX_QUEUED_INTERJECTIONS)
    // The oldest 5 entries should have been dropped, newest 20 remain
    expect(snapshot[0].text).toBe(`msg-${5}`)
    expect(snapshot[snapshot.length - 1].text).toBe(`msg-${MAX_QUEUED_INTERJECTIONS + 4}`)
  })

  test('clear removes all entries for a loop', () => {
    const store = createInterjectionStore()
    store.enqueue('loop-a', 'msg1')
    store.enqueue('loop-a', 'msg2')
    store.clear('loop-a')
    expect(store.peek('loop-a')).toEqual([])
  })

  test('clear on unknown loop does nothing', () => {
    const store = createInterjectionStore()
    expect(() => store.clear('ghost')).not.toThrow()
  })

  test('separate loops are isolated', () => {
    const store = createInterjectionStore()
    store.enqueue('loop-a', 'only-a')
    store.enqueue('loop-b', 'only-b')
    expect(store.peek('loop-a')).toHaveLength(1)
    expect(store.peek('loop-a')[0].text).toBe('only-a')
    expect(store.peek('loop-b')).toHaveLength(1)
    expect(store.peek('loop-b')[0].text).toBe('only-b')
  })
})

describe('formatInterjections', () => {
  test('returns empty string for empty array', () => {
    expect(formatInterjections([])).toBe('')
  })

  test('formats single entry with header and numbered item', () => {
    const entries: UserInterjection[] = [
      { id: 1, text: 'Use approach B instead', at: 1000 },
    ]
    const result = formatInterjections(entries)
    expect(result).toContain('User interjection (live)')
    expect(result).toContain('1. Use approach B instead')
    expect(result).toContain('high-priority guidance')
  })

  test('formats multiple entries with correct numbering', () => {
    const entries: UserInterjection[] = [
      { id: 1, text: 'First instruction', at: 1000 },
      { id: 2, text: 'Second instruction', at: 2000 },
    ]
    const result = formatInterjections(entries)
    expect(result).toContain('1. First instruction')
    expect(result).toContain('2. Second instruction')
  })

  test('does not include trailing newline outside the block', () => {
    const entries: UserInterjection[] = [
      { id: 1, text: 'Hello', at: 1000 },
    ]
    const result = formatInterjections(entries)
    // Should start with \n\n---\n
    expect(result).toMatch(/^\n\n---\n/)
  })
})

describe('extractInterjectionText', () => {
  test('joins text parts with newline', () => {
    const parts = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]
    expect(extractInterjectionText(parts)).toBe('hello\nworld')
  })

  test('skips non-text parts', () => {
    const parts = [
      { type: 'tool_use', text: 'ignore' },
      { type: 'text', text: 'keep' },
      { type: 'tool_result', text: 'ignore' },
    ]
    expect(extractInterjectionText(parts)).toBe('keep')
  })

  test('skips text parts with undefined text', () => {
    const parts = [
      { type: 'text' },
      { type: 'text', text: 'valid' },
    ]
    expect(extractInterjectionText(parts)).toBe('valid')
  })

  test('returns empty string for empty or all-non-text parts', () => {
    expect(extractInterjectionText([])).toBe('')
    expect(extractInterjectionText([{ type: 'tool_use' }])).toBe('')
  })
})

describe('isLoopGeneratedPrompt', () => {
  test('returns true for [Loop prefix', () => {
    expect(isLoopGeneratedPrompt('[Loop iteration 1 / 5]')).toBe(true)
    expect(isLoopGeneratedPrompt('[Loop section 2/4]')).toBe(true)
  })

  test('returns true for [Final prefix', () => {
    expect(isLoopGeneratedPrompt('[Final integration audit]')).toBe(true)
  })

  test('returns true for Post-iteration prefix', () => {
    expect(isLoopGeneratedPrompt('Post-iteration 2 code review')).toBe(true)
  })

  test('returns false for user-authored prompts', () => {
    expect(isLoopGeneratedPrompt('please use approach X')).toBe(false)
    expect(isLoopGeneratedPrompt('Can you fix the bug?')).toBe(false)
    expect(isLoopGeneratedPrompt('  leading spaces but not loop')).toBe(false)
  })

  test('is case-sensitive: lowercase prefixes do not match', () => {
    expect(isLoopGeneratedPrompt('[loop something]')).toBe(false)
    expect(isLoopGeneratedPrompt('[final audit]')).toBe(false)
    expect(isLoopGeneratedPrompt('post-iteration 1')).toBe(false)
  })

  test('handles leading whitespace before prefix', () => {
    expect(isLoopGeneratedPrompt('  [Loop iteration 1]')).toBe(true)
  })
})
