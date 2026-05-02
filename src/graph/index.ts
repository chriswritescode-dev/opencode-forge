// Graph module public exports

import { createGraphService } from './service'

export { createGraphService }
// Public interface — kept even if unused internally
export type GraphService = ReturnType<typeof createGraphService>
export * from './types'
export * from './constants'
export * from './utils'
