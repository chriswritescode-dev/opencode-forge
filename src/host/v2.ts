import type { Plugin } from '@opencode/plugin'
import { createForgeClientFromV2 } from '../client/v2-adapter'
import { createV2ForgeWorkspaces, type V2ForgeWorkspacesDeps } from '../client/v2-workspaces'
import { unavailableError } from '../client/errors'
import type { ForgeClient } from '../client/port'
import { canonicalizePath } from '../sandbox/path'
import { loadPluginConfig } from '../setup'
import { resolveForgeDataDir } from '../utils/opencode-paths'
import { createForgeCore, type ForgeCore } from './forge-core'
import { FORGE_RPC, toForgeRpcJson, writeForgeHostSandboxState, writeForgeSessionPlan, type ForgeExecutePlanInput, type ForgeLoopRestartInput, type ForgeToastInput } from './forge-rpc'
import {
  V2_EVENT_TYPES,
  createV2SessionOwnership,
  normalizeV2Event,
  readV2InboxEvent,
  v2EventDirectory,
} from './v2-events'
import { recordInboxEnqueued, recordInboxSettled } from '../loop/idle-gate'
import { registerForgeAgentsV2, registerForgeCommandsV2, resolveForgeConfigMaps } from './v2-config'
import { registerForgeHooksV2 } from './v2-hooks'
import { registerForgeToolsV2 } from './v2-tools'
import type { ForgeWorkspaceAdapter } from '../workspace/forge-adapter'

type DeferredForgeWorkspacesDeps = Omit<V2ForgeWorkspacesDeps, 'adapter'> & {
  getAdapter: () => ForgeWorkspaceAdapter | null
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
    remove: async (params) => resolve().remove(params),
    warp: async (params) => resolve().warp(params),
  }
}

/** Passes every RPC handler result through {@link toForgeRpcJson} so no handler can emit `undefined`. */
function withJsonOutput<H extends Record<string, (input: unknown) => Promise<unknown>>>(handlers: H): H {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, async (input: unknown) => toForgeRpcJson(await handler(input))]),
  ) as H
}

export async function setupForgeV2(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const config = loadPluginConfig()
  const directory = ctx.location.directory
  const projectId = ctx.location.project.id
  const dataDir = resolveForgeDataDir(config.dataDir)

  let adapter: ForgeWorkspaceAdapter | null = null

  let core: ForgeCore | null = null
  let publishToast: ((toast: ForgeToastInput) => Promise<void>) | undefined
  let requestSessionDelete: ((sessionID: string) => Promise<void>) | undefined
  let disposeRpc: (() => Promise<void>) | null = null
  try {
    const registration = await ctx.rpc.register(FORGE_RPC, withJsonOutput({
      executePlan: async (input) => core
        ? core.executeTuiPlan(input as ForgeExecutePlanInput)
        : { error: 'Forge is still starting; retry in a moment' },
      autoApproveState: async (input) => core
        ? core.getSessionAutoApproveState((input as { sessionId: string }).sessionId)
        : { error: 'Forge is still starting; retry in a moment' },
      autoApproveSet: async (input) => {
        const { sessionId, enabled } = input as { sessionId: string; enabled: boolean }
        return core ? core.setSessionAutoApprove(sessionId, enabled) : { error: 'Forge is still starting; retry in a moment' }
      },
      loops: async () => core
        ? core.tui.listLoops()
        : { error: 'Forge is still starting; retry in a moment' },
      loopSidebar: async (input) => core
        ? core.tui.listLoopSidebar((input as { limit: number }).limit)
        : { error: 'Forge is still starting; retry in a moment' },
      sessionPlan: async (input) => {
        if (!core) return { error: 'Forge is still starting; retry in a moment' }
        const result = core.tui.getSessionPlan((input as { sessionId: string }).sessionId)
        return 'error' in result ? result : writeForgeSessionPlan(result.plan)
      },
      loopRestart: async (input) => core
        ? core.tui.restartLoop(input as ForgeLoopRestartInput)
        : { error: 'Forge is still starting; retry in a moment' },
      hostSandboxState: async () => {
        if (!core) return { error: 'Forge is still starting; retry in a moment' }
        const state = core.tui.getHostSandboxState()
        return 'error' in state ? state : writeForgeHostSandboxState(state)
      },
      hostSandboxSet: async (input) => {
        const { sessionId, enabled } = input as { sessionId: string; enabled: boolean }
        return core ? core.tui.requestHostSandbox(sessionId, enabled) : { error: 'Forge is still starting; retry in a moment' }
      },
      worktrees: async () => core
        ? core.tui.listWorktrees()
        : { error: 'Forge is still starting; retry in a moment' },
    }))
    publishToast = (toast) => registration.events.emit('toast', { projectId, ...toast })
    requestSessionDelete = (sessionID) => registration.events.emit('sessionDelete', { sessionID })
    disposeRpc = registration.dispose
  } catch (err) {
    console.error('[forge] failed to register toast RPC', err)
  }

  const client = createForgeClientFromV2(ctx, {
    directory,
    workspace: createDeferredForgeWorkspaces({
      getAdapter: () => adapter,
      worktree: ctx.worktree,
      projectId,
      dataDir,
      sessionMove: ctx.session.move,
    }),
    ...(publishToast ? { publishToast } : {}),
    ...(requestSessionDelete ? { requestSessionDelete } : {}),
  })

  core = await createForgeCore(config, {
    directory,
    projectId,
    projectRoot: ctx.location.project.canonical,
    client,
    registerWorkspaceAdapter: (registered) => {
      adapter = registered
    },
  })

  await registerForgeToolsV2(ctx, core.tools)
  const cfg = await resolveForgeConfigMaps(core.applyConfig, ctx.options)
  await registerForgeAgentsV2(ctx, cfg.agent)
  await registerForgeCommandsV2(ctx, cfg.command)
  await registerForgeHooksV2(ctx, core)

  const canonicalDirectory = canonicalizePath(directory)
  const controller = new AbortController()

  function ownsDirectory(candidate: string): boolean {
    return canonicalizePath(candidate) === canonicalDirectory
  }

  const sessionOwnership = createV2SessionOwnership({
    ownsDirectory,
    getSessionDirectory: async (sessionID) => (await ctx.session.get({ sessionID })).location.directory,
  })

  const dispose = async () => {
    controller.abort()
    await core.cleanup()
    const rpcDispose = disposeRpc
    disposeRpc = null
    await rpcDispose?.()
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === V2_EVENT_TYPES.locationShutdown) {
          const eventDirectory = v2EventDirectory(event)
          if (eventDirectory === undefined || !ownsDirectory(eventDirectory)) continue
          await dispose()
          return
        }
        const inboxEvent = readV2InboxEvent(event)
        if (inboxEvent) {
          if (inboxEvent.kind === 'enqueued') {
            recordInboxEnqueued(inboxEvent.sessionId, inboxEvent.inboxId)
          } else {
            recordInboxSettled(inboxEvent.sessionId, inboxEvent.inboxId)
          }
          continue
        }
        const normalizedEvents = normalizeV2Event(event)
        for (const normalized of normalizedEvents) client.recordStatusEvent(normalized)
        if (normalizedEvents.length === 0 || !(await sessionOwnership.owns(event))) continue
        for (const normalized of normalizedEvents) {
          try {
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

  return dispose
}
