import type { CacheService } from './types'

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export class InMemoryCacheService implements CacheService {
  private cache = new Map<string, CacheEntry<unknown>>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private readonly ttlSeconds: number

  constructor(ttlSeconds: number = DEFAULT_TTL_SECONDS, cleanupIntervalMs: number = 60000) {
    this.ttlSeconds = ttlSeconds
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs)
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key)
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined
    if (!entry) return null

    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key)
      return null
    }

    return entry.value
  }

  async set<T>(key: string, value: T): Promise<void> {
    const expiresAt = Date.now() + this.ttlSeconds * 1000
    this.cache.set(key, { value, expiresAt })
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key)
  }

  async invalidatePattern(pattern: string): Promise<void> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'))
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.cache.clear()
  }
}
