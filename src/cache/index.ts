import type { CacheService } from './types'
import { InMemoryCacheService } from './memory-cache'

export type { CacheService } from './types'

export function createCacheService(ttlSeconds?: number): CacheService {
  return new InMemoryCacheService(ttlSeconds)
}
