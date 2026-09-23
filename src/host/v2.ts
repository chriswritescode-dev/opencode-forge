import type { Plugin } from '@opencode/plugin'
import type { WorkspaceAdapter } from '@opencode-ai/plugin'
import { createForgeClientFromV2 } from '../client/v2-adapter'
import { createV2ForgeWorkspaces, type V2ForgeWorkspacesDeps } from '../client/v2-workspaces'
import { unavailableError } from '../client/errors'
import type { ForgeClient } from '../client/port'
import { loadPluginConfig } from '../setup'
import { resolveForgeDataDir } from '../utils/opencode-paths'
import { createForgeCore } from './forge-core'
import { normalizeV2Event } from './v2-events'
import { registerForgeAgentsV2, registerForgeCommandsV2, resolveForgeConfigMaps } from './v2-config'
import { registerForgeHooksV2 } from './v2-hooks'
import { registerForgeToolsV2 } from './v2-tools'

type DeferredForgeWorkspacesDeps = Omit<V2ForgeWorkspacesDeps, 'adapter'> & {
  getAdapter: () => WorkspaceAdapter | null
}

function createDeferredForgeWorkspaces(deps: DeferredForgeWorkspacesDeps): ForgeClient['workspace'] {
  let workspaces: ForgeClient['workspace'] | null = null

  function resolve(): ForgeClient['workspace'] {
    const adapter = deps.getAdapter()
    if (!adapter) {
      throw unavailableError('workspace', 'forge workspace adapter is not registered yet')
    }
    workspaces ??= createV2ForgeWorkspaces({
      adapter,
      worktree: deps.worktree,
      projectId: deps.projectId,
      dataDir: deps.dataDir,
      sessionMove: deps.sessionMove,
    })
    return workspaces
  }

  return {
    create: async (params) => resolve().create(params),
    list: async (params) => resolve().list(params),
    status: async (params) => resolve().status(params),
    syncList: async (params) => resolve().syncList(params),
    remove: async (params) => resolve().remove(params),
    warp: async (params) => resolve().warp(params),
  }
}

export async function setupForgeV2(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const config = loadPluginConfig()
  const directory = ctx.location.directory
  const projectId = ctx.location.project.id
  const dataDir = resolveForgeDataDir(config.dataDir)

  let adapter: WorkspaceAdapter | null = null

  const client = createForgeClientFromV2(ctx, {
    directory,
    workspace: createDeferredForgeWorkspaces({
      getAdapter: () => adapter,
      worktree: ctx.worktree,
      projectId,
      dataDir,
      sessionMove: ctx.session.move,
    }),
  })

  const core = await createForgeCore(config, {
    directory,
    projectId,
    projectRoot: ctx.location.project.canonical,
    client,
    registerWorkspaceAdapter: (_type, registered) => {
      adapter = registered
    },
  })

  await registerForgeToolsV2(ctx, core.tools)
  const cfg = await resolveForgeConfigMaps(core.applyConfig, ctx.options)
  await registerForgeAgentsV2(ctx, cfg.agent)
  await registerForgeCommandsV2(ctx, cfg.command)
  await registerForgeHooksV2(ctx, core)

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        for (const normalized of normalizeV2Event(event)) {
          try {
            client.recordStatusEvent(normalized)
            await core.onEvent({ event: normalized })
          } catch (err) {
            console.error('[forge] V2 event handler failed', err)
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('[forge] V2 event subscription failed', err)
      }
    }
  })()

  return async () => {
    controller.abort()
    await core.cleanup()
  }
}
