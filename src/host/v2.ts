import type { Plugin } from '@opencode/plugin'
import type { V2Event } from '@opencode/client'
import { z } from 'zod'
import type { JsonValue } from '../utils/json-schema'
import { createForgeClientFromV2, type V2ForgeClientOptions } from '../client/v2-adapter'
import { createV2ForgeWorkspaces, type V2ForgeWorkspacesDeps } from '../client/v2-workspaces'
import { unavailableError } from '../client/errors'
import type { ForgeClient } from '../client/port'
import { canonicalizePath } from '../sandbox/path'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { errorMessage } from '../utils/error-message'
import { loadPluginConfig } from '../setup'
import { resolveForgeDataDir } from '../utils/opencode-paths'
import { createForgeAgentConfig, createForgeCore, type ForgeCore, type ForgeHostInput } from './forge-core'
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
import type { ToolDefinition } from '../tools/tool'

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

const sandboxSecretRpcSchema = z.object({
  env: z.string(),
  hosts: z.array(z.string()),
  substitution: z.object({
    headers: z.boolean().optional(),
    headerFields: z.array(z.string()).optional(),
    query: z.boolean().optional(),
    body: z.boolean().optional(),
  }).optional(),
  passthrough: z.array(z.string()).optional(),
  violationAction: z.enum(['block', 'block-and-log', 'block-and-terminate']).optional(),
  requireTlsIdentity: z.boolean().optional(),
})

const sandboxSettingsRpcSchema = z.object({
  enabled: z.boolean().optional(),
  resources: sandboxResourcesRpcSchema.optional(),
  allowLan: z.boolean().optional(),
  secrets: z.array(sandboxSecretRpcSchema).optional(),
  secretProvider: z.string().min(1).optional(),
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
  sandbox: z.object({
    secrets: z.array(sandboxSecretRpcSchema),
    secretProvider: z.string().min(1).optional(),
  }).optional(),
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

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function logStartupToastFailure(cause: unknown): void {
  console.error('[forge] failed to publish the core startup failure toast', cause)
}

function coreStartError(cause: unknown): ForgeRpcError {
  return { error: `Forge failed to start: ${errorMessage(cause)}` }
}

export async function setupForgeV2(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const config = loadPluginConfig()
  const directory = ctx.location.directory
  const projectId = ctx.location.project.id
  const dataDir = resolveForgeDataDir(config.dataDir)
  const { applyConfig } = createForgeAgentConfig(config)

  let adapter: ForgeWorkspaceAdapter | null = null

  const coreReady = createDeferred<ForgeCore>()
  void coreReady.promise.catch(() => {})
  const availableCore: Promise<ForgeCore | null> = coreReady.promise.catch(() => null)
  const coreTools: Promise<Record<string, ToolDefinition>> = coreReady.promise.then((active) => active.tools)
  void coreTools.catch(() => {})

  function withCore<T>(run: (active: ForgeCore) => T | Promise<T>): Promise<T | ForgeRpcError> {
    return coreReady.promise.then(run, coreStartError)
  }

  const registrationPromise = (async () => {
    try {
      return await ctx.rpc.register(FORGE_RPC, {
        executePlan: rpcHandler(executePlanRpcInputSchema, async (input) => withCore((active) =>
          active.executeTuiPlan(input))),
        loopDefaults: jsonOutput(() => withCore((active) => active.loopDefaults())),
        autoApproveState: rpcHandler(sessionIdRpcInputSchema, async (input) => withCore((active) =>
          active.getSessionAutoApproveState(input.sessionId))),
        autoApproveSet: rpcHandler(autoApproveSetRpcInputSchema, async (input) => withCore((active) =>
          active.setSessionAutoApprove(input.sessionId, input.enabled))),
        loops: jsonOutput(() => withCore((active) => active.tui.listLoops())),
        loopSidebar: rpcHandler(loopSidebarRpcInputSchema, async (input) => withCore((active) =>
          active.tui.listLoopSidebar(input.limit))),
        sessionPlan: rpcHandler(sessionPlanRpcInputSchema, async (input) => withCore((active) =>
          active.tui.getSessionPlan(input.sessionId, input.projectId))),
        loopRestart: rpcHandler(loopRestartRpcInputSchema, async (input) => withCore((active) =>
          active.tui.restartLoop(input))),
        hostSandboxState: jsonOutput(() => withCore((active) => active.tui.getHostSandboxState())),
        hostSandboxSet: rpcHandler(hostSandboxSetRpcInputSchema, async (input) => withCore((active) =>
          active.tui.requestHostSandbox(input))),
        worktrees: jsonOutput(() => withCore((active) => active.tui.listWorktrees())),
        version: jsonOutput(() => ({ version: VERSION })),
        dashboardSummary: jsonOutput(() => withCore((active) => active.dashboard.getSummary())),
        loopDetail: rpcHandler(loopRefRpcInputSchema, async (input) => withCore((active) =>
          active.dashboard.getLoopDetail(input.projectId, input.loopName))),
        projectFindings: rpcHandler(projectRpcInputSchema, async (input) => withCore((active) =>
          active.dashboard.getProjectFindings(input.projectId))),
        amendmentDiff: rpcHandler(amendmentDiffRpcInputSchema, async (input) => withCore((active) =>
          active.dashboard.getAmendmentDiff(input.projectId, input.loopName, input.id))),
        planDelete: rpcHandler(planDeleteRpcInputSchema, async (input) => withCore((active) =>
          active.dashboard.deletePlan(input.projectId, input.sessionId))),
      })
    } catch (err) {
      console.error('[forge] failed to register toast RPC', err)
      return null
    }
  })()

  const publishToast = async (toast: ForgeToastInput): Promise<void> => {
    const registration = await registrationPromise
    if (!registration) return
    await registration.events.emit('toast', { projectId, ...toast })
  }

  const requestSessionDelete = async (sessionID: string): Promise<void> => {
    const registration = await registrationPromise
    if (!registration) {
      throw unavailableError('session.delete', 'session.delete is not available on this host')
    }
    await registration.events.emit('sessionDelete', { sessionID })
  }

  const publishTuiEvent = (event: ForgeTuiEvent): void => {
    void registrationPromise.then((registration) => {
      if (!registration) return
      const { type, ...data } = event
      try {
        void Promise.resolve(registration.events.emit(type, data)).catch((cause: unknown) => {
          console.error('[forge] failed to emit TUI event', cause)
        })
      } catch (err) {
        console.error('[forge] failed to emit TUI event', err)
      }
    }).catch((cause: unknown) => {
      console.error('[forge] failed to emit TUI event', cause)
    })
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
    publishToast,
    requestSessionDelete,
  }
  const client = createForgeClientFromV2(ctx, clientOptions)

  const hostInput: ForgeHostInput = {
    directory,
    projectId,
    projectRoot: ctx.location.project.canonical,
    client,
    registerWorkspaceAdapter: (registered) => {
      adapter = registered
    },
    publishTuiEvent,
  }

  let disposed = false
  let coreStartBegan = false
  let rpcDisposed = false

  const disposeRpcRegistration = async () => {
    if (rpcDisposed) return
    rpcDisposed = true
    const registration = await registrationPromise
    await registration?.dispose()
  }

  const startCore = (): void => {
    if (disposed) return
    coreStartBegan = true
    void createForgeCore(config, hostInput).then(
      (created) => coreReady.resolve(created),
      (cause: unknown) => {
        console.error('[forge] core failed to start', cause)
        coreReady.reject(cause)
        void publishToast({ title: 'Forge failed to start', message: errorMessage(cause), variant: 'error' })
          .catch(logStartupToastFailure)
      },
    )
  }

  let unregisterTools: () => void = () => {}
  try {
    unregisterTools = await registerForgeToolsV2(ctx, coreTools)
    const cfg = await resolveForgeConfigMaps(applyConfig, ctx.options)
    await registerForgeAgentsV2(ctx, cfg.agent)
    await registerForgeCommandsV2(ctx, cfg.command)
    await registerForgeHooksV2(ctx, () => availableCore, { sandboxRequired: isSandboxConfigEnabled(config) })
  } catch (err) {
    unregisterTools()
    disposed = true
    coreReady.reject(new Error('Forge setup failed before its core started'))
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
    const activeCore = await availableCore
    if (!activeCore) return
    for (const normalized of replayed) {
      try {
        await activeCore.onEvent({ event: normalized })
      } catch (err) {
        console.error('[forge] V2 event handler failed', err)
      }
    }
  }

  let disposePromise: Promise<void> | null = null
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      disposed = true
      controller.abort()
      unregisterTools()
      if (coreStartBegan) {
        await coreReady.promise.then((created) => created.cleanup(), () => {})
      } else {
        coreReady.reject(new Error('Forge was disposed before its core started'))
      }
      await disposeRpcRegistration()
    })()
    return disposePromise
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
        const activeCore = await availableCore
        if (!activeCore) continue
        for (const normalized of normalizedEvents) {
          try {
            await activeCore.onEvent({ event: normalized })
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

  setImmediate(startCore)

  return dispose
}
