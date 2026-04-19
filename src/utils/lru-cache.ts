/**
 * Generic bounded LRU cache keyed by string.
 * Relies on Map's insertion-order iteration: a get() re-inserts the key to mark it
 * as most-recently-used; on overflow the oldest key is evicted.
 *
 * Intentionally minimal: no TTL, no weak refs. Use for small hot-path caches
 * where unbounded growth is the concern.
 */
export class LRUCache<V> {
  private entries = new Map<string, V>()
  private readonly maxSize: number

  constructor(maxSize = 500) {
    if (maxSize <= 0) throw new Error('LRUCache maxSize must be > 0')
    this.maxSize = maxSize
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined && !this.entries.has(key)) return undefined
    // Re-insert to mark as most recently used
    this.entries.delete(key)
    this.entries.set(key, value as V)
    return value
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    } else if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) {
        this.entries.delete(oldest.value)
      }
    }
    this.entries.set(key, value)
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
