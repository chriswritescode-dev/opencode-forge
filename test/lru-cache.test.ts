import { describe, test, expect } from 'bun:test'
import { LRUCache } from '../src/utils/lru-cache'

describe('LRUCache', () => {
  test('stores and retrieves values', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
    expect(cache.get('missing')).toBeUndefined()
  })

  test('distinguishes null value from missing key', () => {
    const cache = new LRUCache<string | null>(3)
    cache.set('a', null)
    expect(cache.has('a')).toBe(true)
    expect(cache.get('a')).toBeNull()
    expect(cache.has('missing')).toBe(false)
    expect(cache.get('missing')).toBeUndefined()
  })

  test('evicts oldest entry when capacity exceeded', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
    expect(cache.size).toBe(3)
  })

  test('get() promotes entry to most-recently-used', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    // Touch 'a' to promote it
    cache.get('a')

    // Adding 'd' should now evict 'b' (the oldest untouched)
    cache.set('d', 4)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  test('set() on existing key refreshes recency without growing size', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    // Re-set 'a' with new value; should promote and update
    cache.set('a', 99)
    expect(cache.size).toBe(3)
    expect(cache.get('a')).toBe(99)

    // Adding 'd' should evict 'b' now, not 'a'
    cache.set('d', 4)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  test('delete() removes entry', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    expect(cache.delete('a')).toBe(true)
    expect(cache.has('a')).toBe(false)
    expect(cache.delete('a')).toBe(false)
  })

  test('clear() empties the cache', () => {
    const cache = new LRUCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.has('a')).toBe(false)
  })

  test('rejects non-positive maxSize', () => {
    expect(() => new LRUCache(0)).toThrow()
    expect(() => new LRUCache(-1)).toThrow()
  })

  test('respects capacity under sustained churn', () => {
    const cache = new LRUCache<number>(10)
    for (let i = 0; i < 1000; i++) {
      cache.set(`key-${i}`, i)
    }
    expect(cache.size).toBe(10)
    // Last 10 inserts should be present
    for (let i = 990; i < 1000; i++) {
      expect(cache.get(`key-${i}`)).toBe(i)
    }
    // Earlier keys are gone
    expect(cache.has('key-0')).toBe(false)
    expect(cache.has('key-989')).toBe(false)
  })
})
