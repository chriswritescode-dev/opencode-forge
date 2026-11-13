import type { Plugin } from '@opencode/plugin/tui'
import { z } from 'zod'
import { toProviderListFromV2 } from '../client/v2-adapter'
import {
  FORGE_RPC,
  readForgeExecutePlanOutput,
  readForgeLoopDefaults,
  readForgeLoopRestartOutput,
  readForgeLoops,
  readForgeSessionPlan,
  type ForgeExecutePlanInput,
  type ForgeLoopRestartInput,
} from '../host/forge-rpc'
import type { ExecutionContext, ForgeProjectClient } from './project-client'
import { deriveExecutionPreferencesFromWorkspaces } from '../utils/tui-execution-preferences'
import { providersFromProviderList, type LoopInfo, type WorkspaceForRecents } from '../utils/tui-models'
import { jsonValueSchema, type JsonValue } from '../utils/json-schema'

export interface V2ForgeProjectClientOptions {
  projectId: string
  directory: string
}

export function loopsToWorkspacesForRecents(projectId: string, loops: ReadonlyArray<LoopInfo>): WorkspaceForRecents[] {
  return loops.map((loop) => ({
    type: 'forge',
    projectID: projectId,
    timeUsed: loop.startedAt ? Date.parse(loop.startedAt) : 0,
    extra: {
      forgeLoop: {
        executionModel: loop.executionModel,
        auditorModel: loop.auditorModel,
        executionVariant: loop.executionVariant,
        auditorVariant: loop.auditorVariant,
      },
    },
  }))
}

type ForgeRpcClient = ReturnType<typeof forgeRpcClient>

const forgeRpcClient = (context: Plugin.Context) => context.client.rpc(FORGE_RPC)

export type ForgeRpcInvoke = (
  rpc: ForgeRpcClient,
  options: { location: { directory: string } },
) => Promise<JsonValue>

export type ForgeRpcCall = <T>(
  invoke: ForgeRpcInvoke,
  read: (value: JsonValue) => T | { error: string },
) => Promise<T | { error: string }>

const rpcErrorSchema = z.looseObject({
  type: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
})

export function describeRpcError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const error = rpcErrorSchema.safeParse(cause)
  if (error.success) {
    const type = error.data.type
    const message = error.data.message
    if (message) return type ? `${message} (${type})` : message
    if (type) return type
  }
  return String(cause)
}

export function createForgeRpcCaller(
  context: Plugin.Context,
  resolveDirectory: () => string | null,
): ForgeRpcCall {
  return async (invoke, read) => {
    const directory = resolveDirectory()
    if (!directory) return { error: 'no Forge location for this TUI' }
    try {
      return read(await invoke(forgeRpcClient(context), { location: { directory } }))
    } catch (err) {
      return { error: describeRpcError(err) }
    }
  }
}

export const RPC_EVENT_RESUBSCRIBE_DELAY_MS = 1000

export interface FollowRpcEventOptions {
  signal: AbortSignal
  onResubscribed?: () => void
  resubscribeDelayMs?: number
}

export function followRpcEvent<E>(
  subscribe: (signal: AbortSignal) => AsyncIterable<E>,
  handler: (event: E) => void,
  options: FollowRpcEventOptions,
): void {
  const { signal, onResubscribed } = options
  const delayMs = options.resubscribeDelayMs ?? RPC_EVENT_RESUBSCRIBE_DELAY_MS
  void (async () => {
    let resubscribed = false
    while (!signal.aborted) {
      try {
        const events = subscribe(signal)
        if (resubscribed && onResubscribed) queueMicrotask(onResubscribed)
        for await (const event of events) {
          if (signal.aborted) return
          try {
            handler(event)
          } catch (err) {
            console.error('[forge] RPC event handler failed', err)
          }
        }
      } catch (err) {
        if (!signal.aborted) console.error('[forge] RPC event stream failed', err)
      }
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, delayMs)
        function done(): void {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
      })
      resubscribed = true
    }
  })()
}

async function loadModels(context: Plugin.Context, directory: string): Promise<ExecutionContext['models'] & { defaultModel: string }> {
  const location = { directory }
  try {
    const [providers, models, defaultModel] = await Promise.all([
      context.client.provider.list({ location }),
      context.client.model.list({ location }),
      context.client.model.default({ location }).catch(() => null),
    ])
    const { providers: connected, connectedProviderIds } = providersFromProviderList(toProviderListFromV2(providers.data, models.data))
    const fallback = defaultModel?.data
    return {
      providers: connected,
      connectedProviderIds,
      configuredProviderIds: [],
      defaultModel: fallback ? `${fallback.providerID}/${fallback.id}` : '',
    }
  } catch (err) {
    return {
      providers: [],
      connectedProviderIds: [],
      configuredProviderIds: [],
      error: err instanceof Error ? err.message : 'Failed to fetch providers',
      defaultModel: '',
    }
  }
}

export function createV2ForgeProjectClient(context: Plugin.Context, options: V2ForgeProjectClientOptions): ForgeProjectClient {
  const { projectId, directory } = options
  const call = createForgeRpcCaller(context, () => directory)

  return {
    projectId,
    plan: {
      async execute(sessionId, req) {
        const input: ForgeExecutePlanInput = {
          sessionId,
          mode: req.mode,
          title: req.title,
          plan: req.plan,
        }
        if (req.loopName) input.loopName = req.loopName
        if (req.executionModel) input.executionModel = req.executionModel
        if (req.auditorModel) input.auditorModel = req.auditorModel
        if (req.executionVariant) input.executionVariant = req.executionVariant
        if (req.auditorVariant) input.auditorVariant = req.auditorVariant
        if (req.maxIterations !== undefined) input.maxIterations = req.maxIterations
        if (req.sandbox) input.sandbox = req.sandbox
        return call(
          async (rpc, location) => {
            try {
              return jsonValueSchema.parse(await rpc.executePlan(input, location))
            } catch (err) {
              throw new Error(`Plan execution failed: ${describeRpcError(err)}`, { cause: err })
            }
          },
          readForgeExecutePlanOutput,
        )
      },
    },
    async selectSession(sessionId) {
      context.ui.router.navigate({ type: 'session', sessionID: sessionId })
    },
    async loadLatestPlan(sessionId) {
      const result = await call(
        async (rpc, location) => jsonValueSchema.parse(await rpc.sessionPlan({ sessionId }, location)),
        readForgeSessionPlan,
      )
      return 'error' in result ? null : result.plan
    },
    async loadLoops() {
      return call(async (rpc, location) => jsonValueSchema.parse(await rpc.loops({}, location)), readForgeLoops)
    },
    async loadExecutionContext() {
      const { defaultModel, ...models } = await loadModels(context, directory)
      const [loopsResult, loopDefaults] = await Promise.all([
        call(async (rpc, location) => jsonValueSchema.parse(await rpc.loops({}, location)), readForgeLoops),
        call(async (rpc, location) => jsonValueSchema.parse(await rpc.loopDefaults({}, location)), readForgeLoopDefaults),
      ])
      const loops = 'error' in loopsResult ? [] : loopsResult.loops
      const workspaces = loopsToWorkspacesForRecents(projectId, loops)
      const executionContext: ExecutionContext = {
        preferences: deriveExecutionPreferencesFromWorkspaces(projectId, workspaces),
        models,
        sessions: context.data.session.list(),
        workspaces,
        openCodeFavorites: [],
        openCodeDefault: defaultModel || undefined,
      }
      if (!('error' in loopDefaults)) executionContext.loopDefaults = loopDefaults
      return executionContext
    },
    async restartLoop(request) {
      const { executionModel, executionVariant, force, expectedStartedAt, ...required } = request
      const input: ForgeLoopRestartInput = { ...required }
      if (executionModel) input.executionModel = executionModel
      if (executionVariant) input.executionVariant = executionVariant
      if (force !== undefined) input.force = force
      if (expectedStartedAt) input.expectedStartedAt = expectedStartedAt
      const result = await call(
        async (rpc, location) => jsonValueSchema.parse(await rpc.loopRestart(input, location)),
        readForgeLoopRestartOutput,
      )
      if ('error' in result) throw new Error(result.error)
      return { sessionId: result.sessionId }
    },
  }
}
