import { EXT_TO_LANGUAGE, type Language } from './types'

// Re-export from types.ts for backward compatibility
export const INDEXABLE_EXTENSIONS: Readonly<Record<string, Language>> = EXT_TO_LANGUAGE

export const PAGERANK_ITERATIONS = 20

export const PAGERANK_DAMPING = 0.85

export const GRAPH_SCAN_BATCH_SIZE = 500
