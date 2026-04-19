// Graph module public exports

import { createGraphService } from './service'

export { createGraphService }
// Public interface — kept even if unused internally
export type GraphService = ReturnType<typeof createGraphService>
export { GraphClient } from './client'
export { initializeGraphDatabase, closeGraphDatabase, ensureGraphDirectory } from './database'
export { RpcClient, RpcServer } from './rpc'
export { RepoMap } from './repo-map'
export { TreeSitterBackend } from './tree-sitter'
export { FileCache } from './cache'
export { tokenize, computeMinHash, computeFragmentHashes, jaccardSimilarity } from './clone-detection'
export type { FragmentHash } from './clone-detection'
export * from './types'
export * from './constants'
export * from './utils'
