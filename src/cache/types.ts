export interface CacheService {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  del(key: string): Promise<void>
  invalidatePattern(pattern: string): Promise<void>
  destroy(): void
}
