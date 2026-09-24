import { define } from '@opencode/plugin/promise/plugin'
import { setupForgeV2 } from './host/v2'
import { FORGE_PLUGIN_ID } from './constants/plugin'

export { createParentSessionLookup, createSessionDirectoryLookup } from './host/forge-core'
export type { CreateParentSessionLookupOptions, CreateSessionDirectoryLookupOptions } from './host/forge-core'
export { setupForgeV2 } from './host/v2'

export default define({ id: FORGE_PLUGIN_ID, setup: setupForgeV2 })
export type { PluginConfig, CompactionConfig, DashboardConfig } from './types'
export { VERSION } from './version'
