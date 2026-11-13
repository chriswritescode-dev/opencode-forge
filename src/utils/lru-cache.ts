export class LRUCache<V> {
  private entries = new Map<string, { readonly value: V }>()
  private readonly maxSize: number

  constructor(maxSize = 500) {
    if (maxSize <= 0) throw new Error('LRUCache maxSize must be > 0')
    this.maxSize = maxSize
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
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
    this.entries.set(key, { value })
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  snapshot(): Array<[string, V]> {
    return Array.from(this.entries, ([key, entry]) => [key, entry.value])
  }

  get size(): number {
    return this.entries.size
  }
}
