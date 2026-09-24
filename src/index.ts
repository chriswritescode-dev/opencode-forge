import type { Plugin as V1Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { define } from '@opencode/plugin/promise/plugin'
import { createForgeCore } from './host/forge-core'
import { setupForgeV2 } from './host/v2'
import { createForgeClientFromPluginInput } from './client/sdk-adapter'
import { loadPluginConfig } from './setup'
import { FORGE_PLUGIN_ID } from './constants/plugin'
import type { PluginConfig } from './types'

export { createParentSessionLookup, createSessionDirectoryLookup } from './host/forge-core'
export type { CreateParentSessionLookupOptions, CreateSessionDirectoryLookupOptions } from './host/forge-core'
export { setupForgeV2 } from './host/v2'

/**
 * Creates an OpenCode plugin instance with loop management and sandboxing.
 * 
 * @param config - Plugin configuration including loop, sandbox, and logging settings
 * @returns OpenCode Plugin instance with hooks for tools, events, and session management
 */
export function createForgePlugin(config: PluginConfig): V1Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const core = await createForgeCore(config, {
      directory: input.directory,
      projectId: input.project.id,
      projectRoot: input.project.worktree ?? input.directory,
      client: createForgeClientFromPluginInput(input),
      registerWorkspaceAdapter: input.experimental_workspace?.register
        ? (type, adapter) => input.experimental_workspace.register(type, adapter)
        : undefined,
    })

    return {
      getCleanup: core.cleanup,
      tool: core.tools,
      config: core.applyConfig,
      'shell.env': core.shellEnv,
      'chat.message': core.chatMessage,
      'experimental.chat.system.transform': core.systemTransform,
      event: core.onEvent,
      'tool.execute.before': core.toolBefore,
      'tool.execute.after': core.toolAfter,
      'experimental.session.compacting': core.compacting,
      'experimental.chat.messages.transform': core.messagesTransform,
    } as Hooks & { getCleanup: () => Promise<void> }
  }
}

const plugin: V1Plugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadPluginConfig()

  const factory = createForgePlugin(config)
  const hooks = await factory(input)

  return hooks
}

const pluginModule = {
  ...define({ id: FORGE_PLUGIN_ID, setup: setupForgeV2 }),
  server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig, DashboardConfig } from './types'
export { VERSION } from './version'
