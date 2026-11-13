import type { Plugin } from '@opencode/plugin'
import type { V2Event } from '@opencode/client'
import { z } from 'zod'
import type { JsonValue } from '../utils/json-schema'
import { createForgeClientFromV2, type V2ForgeClientOptions } from '../client/v2-adapter'
import { createV2ForgeWorkspaces, type V2ForgeWorkspacesDeps } from '../client/v2-workspaces'
import { unavailableError } from '../client/errors'
import type { ForgeClient } from '../client/port'
import { canonicalizePath } from '../sandbox/path'
import { loadPluginConfig } from '../setup'
import { resolveForgeDataDir } from '../utils/opencode-paths'
import { createForgeCore, type ForgeCore, type ForgeHostInput } from './forge-core'
import { FORGE_EXECUTION_MODES, FORGE_RPC, toForgeRpcJson, type ForgeRpcError, type ForgeToastInput, type ForgeTuiEvent } from './forge-rpc'
import { VERSION } from '../version'
import {
  V2_EVENT_TYPES,
  createV2SessionOwnership,
  normalizeV2Event,
  readV2InboxEvent,
  v2EventDirectory,
  v2EventSessionId,
  v2IdleEvents,
} from './v2-events'
import {
  clearIdleGateForSession,
  clearSuppressedIdle,
  consumeSuppressedIdle,
  hasSuppressedIdle,
  isPromptQueued,
  recordInboxEnqueued,
  recordInboxSettled,
} from '../loop/idle-gate'
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

const sandboxResourcesRpcSchema = z.object({
  memory: z.string().optional(),
  cpus: z.string().optional(),
  dockerDisk: z.string().optional(),
  cacheDisk: z.string().optional(),
})

const sandboxOverridesRpcSchema = z.object({
  resources: sandboxResourcesRpcSchema.optional(),
  allowLan: z.boolean().optional(),
})

const sandboxSettingsRpcSchema = z.object({
  enabled: z.boolean().optional(),
  resources: sandboxResourcesRpcSchema.optional(),
  allowLan: z.boolean().optional(),
})

const executePlanRpcInputSchema = z.object({
  sessionId: z.string(),
  mode: z.enum(FORGE_EXECUTION_MODES),
  title: z.string(),
  plan: z.string().min(1),
  loopName: z.string().optional(),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  executionVariant: z.string().optional(),
  auditorVariant: z.string().optional(),
  maxIterations: z.number().int().min(0).optional(),
  sandbox: sandboxSettingsRpcSchema.optional(),
})

const sessionIdRpcInputSchema = z.object({ sessionId: z.string() })

const autoApproveSetRpcInputSchema = z.object({ sessionId: z.string(), enabled: z.boolean() })

const loopSidebarRpcInputSchema = z.object({ limit: z.number().int().min(1).max(50) })

const sessionPlanRpcInputSchema = z.object({ sessionId: z.string(), projectId: z.string().min(1).optional() })

const loopRestartRpcInputSchema = z.object({
  loopName: z.string().min(1),
  auditorModel: z.string().min(1),
  auditorVariant: z.string(),
  executionModel: z.string().optional(),
  executionVariant: z.string().optional(),
  force: z.boolean().optional(),
  expectedStartedAt: z.string().optional(),
})

const hostSandboxSetRpcInputSchema = z.object({
  sessionId: z.string().min(1),
  enabled: z.boolean().optional(),
  overrides: sandboxOverridesRpcSchema.optional(),
})

const loopRefRpcInputSchema = z.object({ projectId: z.string().min(1), loopName: z.string().min(1) })

const projectRpcInputSchema = z.object({ projectId: z.string().min(1) })

const amendmentDiffRpcInputSchema = z.object({
  projectId: z.string().min(1),
  loopName: z.string().min(1),
  id: z.number().int().min(1),
})

const planDeleteRpcInputSchema = z.object({ projectId: z.string().min(1), sessionId: z.string().min(1) })

function rpcHandler<P, I, O>(schema: z.ZodType<I>, run: (input: I) => O | Promise<O>): (input: P) => Promise<JsonValue> {
  return async (input: P) => toForgeRpcJson(await run(schema.parse(input)))
}

function jsonOutput<O>(run: () => O | Promise<O>): () => Promise<JsonValue> {
  return async () => toForgeRpcJson(await run())
}

const FORGE_STARTING_ERROR = 'Forge is still starting; retry in a moment'

function withCore<T>(core: ForgeCore | null, run: (core: ForgeCore) => T): T | ForgeRpcError {
  return core ? run(core) : { error: FORGE_STARTING_ERROR }
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
  let publishTuiEvent: ((event: ForgeTuiEvent) => void) | undefined
  let disposeRpc: (() => Promise<void>) | null = null
  try {
    const registration = await ctx.rpc.register(FORGE_RPC, {
      executePlan: rpcHandler(executePlanRpcInputSchema, async (input) => withCore(core, (active) =>
        active.executeTuiPlan(input))),
      loopDefaults: jsonOutput(() => withCore(core, (active) => active.loopDefaults())),
      autoApproveState: rpcHandler(sessionIdRpcInputSchema, async (input) => withCore(core, (active) =>
        active.getSessionAutoApproveState(input.sessionId))),
      autoApproveSet: rpcHandler(autoApproveSetRpcInputSchema, async (input) => withCore(core, (active) =>
        active.setSessionAutoApprove(input.sessionId, input.enabled))),
      loops: jsonOutput(() => withCore(core, (active) => active.tui.listLoops())),
      loopSidebar: rpcHandler(loopSidebarRpcInputSchema, async (input) => withCore(core, (active) =>
        active.tui.listLoopSidebar(input.limit))),
      sessionPlan: rpcHandler(sessionPlanRpcInputSchema, async (input) => withCore(core, (active) =>
        active.tui.getSessionPlan(input.sessionId, input.projectId))),
      loopRestart: rpcHandler(loopRestartRpcInputSchema, async (input) => withCore(core, (active) =>
        active.tui.restartLoop(input))),
      hostSandboxState: jsonOutput(() => withCore(core, (active) => active.tui.getHostSandboxState())),
      hostSandboxSet: rpcHandler(hostSandboxSetRpcInputSchema, async (input) => withCore(core, (active) =>
        active.tui.requestHostSandbox(input))),
      worktrees: jsonOutput(() => withCore(core, (active) => active.tui.listWorktrees())),
      version: jsonOutput(() => ({ version: VERSION })),
      dashboardSummary: jsonOutput(() => withCore(core, (active) => active.dashboard.getSummary())),
      loopDetail: rpcHandler(loopRefRpcInputSchema, async (input) => withCore(core, (active) =>
        active.dashboard.getLoopDetail(input.projectId, input.loopName))),
      projectFindings: rpcHandler(projectRpcInputSchema, async (input) => withCore(core, (active) =>
        active.dashboard.getProjectFindings(input.projectId))),
      amendmentDiff: rpcHandler(amendmentDiffRpcInputSchema, async (input) => withCore(core, (active) =>
        active.dashboard.getAmendmentDiff(input.projectId, input.loopName, input.id))),
      planDelete: rpcHandler(planDeleteRpcInputSchema, async (input) => withCore(core, (active) =>
        active.dashboard.deletePlan(input.projectId, input.sessionId))),
    })
    publishToast = (toast) => registration.events.emit('toast', { projectId, ...toast })
    requestSessionDelete = (sessionID) => registration.events.emit('sessionDelete', { sessionID })
    const emitRpcEvent = registration.events.emit.bind(registration.events)
    publishTuiEvent = (event) => {
      const { type, ...data } = event
      try {
        void Promise.resolve(emitRpcEvent(type, data)).catch((cause: unknown) => {
          console.error('[forge] failed to emit TUI event', cause)
        })
      } catch (err) {
        console.error('[forge] failed to emit TUI event', err)
      }
    }
    disposeRpc = registration.dispose
  } catch (err) {
    console.error('[forge] failed to register toast RPC', err)
  }

  const clientOptions: V2ForgeClientOptions = {
    directory,
    workspace: createDeferredForgeWorkspaces({
      getAdapter: () => adapter,
      worktree: ctx.worktree,
      projectId,
      dataDir,
      sessionMove: ctx.session.move,
    }),
  }
  if (publishToast) clientOptions.publishToast = publishToast
  if (requestSessionDelete) clientOptions.requestSessionDelete = requestSessionDelete
  const client = createForgeClientFromV2(ctx, clientOptions)

  const hostInput: ForgeHostInput = {
    directory,
    projectId,
    projectRoot: ctx.location.project.canonical,
    client,
    registerWorkspaceAdapter: (registered) => {
      adapter = registered
    },
  }
  if (publishTuiEvent) hostInput.publishTuiEvent = publishTuiEvent
  core = await createForgeCore(config, hostInput)

  const disposeRpcRegistration = async () => {
    const rpcDispose = disposeRpc
    disposeRpc = null
    await rpcDispose?.()
  }

  let unregisterTools: () => void = () => {}
  try {
    unregisterTools = await registerForgeToolsV2(ctx, core.tools)
    const cfg = await resolveForgeConfigMaps(core.applyConfig, ctx.options)
    await registerForgeAgentsV2(ctx, cfg.agent)
    await registerForgeCommandsV2(ctx, cfg.command)
    await registerForgeHooksV2(ctx, core)
  } catch (err) {
    unregisterTools()
    try {
      await core.cleanup()
    } catch (cleanupErr) {
      console.error('[forge] failed to clean up after a failed V2 setup', cleanupErr)
    }
    try {
      await disposeRpcRegistration()
    } catch (rpcErr) {
      console.error('[forge] failed to dispose the RPC registration after a failed V2 setup', rpcErr)
    }
    throw err
  }

  const canonicalDirectory = canonicalizePath(directory)
  const controller = new AbortController()

  function ownsDirectory(candidate: string): boolean {
    return canonicalizePath(candidate) === canonicalDirectory
  }

  const sessionOwnership = createV2SessionOwnership({
    ownsDirectory,
    getSessionDirectory: async (sessionID) => (await ctx.session.get({ sessionID })).location.directory,
  })

  const replaySuppressedIdle = async (event: V2Event, sessionId: string): Promise<void> => {
    if (!hasSuppressedIdle(sessionId)) return
    if (!(await sessionOwnership.owns(event))) return
    if (!consumeSuppressedIdle(sessionId)) return
    const replayed = v2IdleEvents(sessionId)
    for (const normalized of replayed) client.recordStatusEvent(normalized)
    for (const normalized of replayed) {
      try {
        await core.onEvent({ event: normalized })
      } catch (err) {
        console.error('[forge] V2 event handler failed', err)
      }
    }
  }

  const dispose = async () => {
    controller.abort()
    unregisterTools()
    await core.cleanup()
    await disposeRpcRegistration()
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
        if (event.type === V2_EVENT_TYPES.sessionDeleted) {
          const sessionId = v2EventSessionId(event)
          if (sessionId) clearIdleGateForSession(sessionId)
        }
        const inboxEvent = readV2InboxEvent(event)
        if (inboxEvent) {
          if (inboxEvent.kind === 'enqueued') {
            recordInboxEnqueued(inboxEvent.sessionId, inboxEvent.inboxId)
          } else {
            recordInboxSettled(inboxEvent.sessionId, inboxEvent.inboxId)
            if (!isPromptQueued(inboxEvent.sessionId)) {
              if (inboxEvent.kind === 'delivered') {
                clearSuppressedIdle(inboxEvent.sessionId)
              } else {
                await replaySuppressedIdle(event, inboxEvent.sessionId)
              }
            }
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
