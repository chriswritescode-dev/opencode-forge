export { initializeDatabase, closeDatabase, resolveDataDir, resolveLogPath } from './database'
export { createKvQuery } from './kv-queries'
export type { KvRow } from './kv-queries'

export type {
  CompactionConfig,
} from '../types'
