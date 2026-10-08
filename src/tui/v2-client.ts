import type { Plugin } from '@opencode/plugin/tui'
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
import { isRecord } from '../utils/is-record'
import { deriveExecutionPreferencesFromWorkspaces } from '../utils/tui-execution-preferences'
import { providersFromProviderList, type LoopInfo, type WorkspaceForRecents } from '../utils/tui-models'

export interface V2ForgeProjectClientOptions {
  projectId: string
  directory: string
  onDefaultModel(model: string): void
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
) => Promise<unknown>

export type ForgeRpcCall = <T>(
  invoke: ForgeRpcInvoke,
  read: (value: unknown) => T | { error: string },
) => Promise<T | { error: string }>

/**
 * Message for a failed Forge RPC. The OpenCode client rejects an RPC with a plain
 * `{ type, message, data? }` object rather than an `Error`, so `String(err)` would
 * render it as "[object Object]".
 */
export function describeRpcError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (isRecord(err)) {
    const type = typeof err.type === 'string' ? err.type : undefined
    if (typeof err.message === 'string' && err.message) return type ? `${err.message} (${type})` : err.message
    if (type) return type
  }
  return String(err)
}

/**
 * The single caller every TUI Forge RPC goes through: it resolves the current
 * location, invokes the method there, and maps both a missing location and any
 * thrown transport error to the shared `{ error }` result shape.
 */
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

/** Pause before resubscribing to an ended RPC event stream, so a down server is not hammered. */
export const RPC_EVENT_RESUBSCRIBE_DELAY_MS = 1000

export interface FollowRpcEventOptions {
  signal: AbortSignal
  /** Re-reads state whose events may have been missed while the stream was down. */
  onResubscribed?: () => void
  resubscribeDelayMs?: number
}

/**
 * Delivers every event of one Forge RPC event stream for the lifetime of `signal`.
 * The OpenCode client ends an RPC subscription for good when its shared event
 * connection closes or the subscriber overflows, so the stream is resubscribed
 * after a short pause and `onResubscribed` re-reads whatever the gap may have hidden.
 * It runs once the new subscription has started connecting, so no event between the
 * re-read and the subscription is lost.
 */
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
          ...(req.loopName ? { loopName: req.loopName } : {}),
          ...(req.executionModel ? { executionModel: req.executionModel } : {}),
          ...(req.auditorModel ? { auditorModel: req.auditorModel } : {}),
          ...(req.executionVariant ? { executionVariant: req.executionVariant } : {}),
          ...(req.auditorVariant ? { auditorVariant: req.auditorVariant } : {}),
          ...(req.maxIterations !== undefined ? { maxIterations: req.maxIterations } : {}),
          ...(req.sandbox ? { sandbox: req.sandbox } : {}),
        }
        return call(
          async (rpc, location) => {
            try {
              return await rpc.executePlan(input, location)
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
      const result = await call((rpc, location) => rpc.sessionPlan({ sessionId }, location), readForgeSessionPlan)
      return 'error' in result ? null : result.plan
    },
    async loadLoops() {
      return call((rpc, location) => rpc.loops({}, location), readForgeLoops)
    },
    async loadExecutionContext() {
      const { defaultModel, ...models } = await loadModels(context, directory)
      options.onDefaultModel(defaultModel)
      const [loopsResult, loopDefaults] = await Promise.all([
        call((rpc, location) => rpc.loops({}, location), readForgeLoops),
        call((rpc, location) => rpc.loopDefaults({}, location), readForgeLoopDefaults),
      ])
      const loops = 'error' in loopsResult ? [] : loopsResult.loops
      const workspaces = loopsToWorkspacesForRecents(projectId, loops)
      return {
        preferences: deriveExecutionPreferencesFromWorkspaces(projectId, workspaces),
        models,
        sessions: context.data.session.list(),
        workspaces,
        openCodeFavorites: [],
        openCodeDefault: defaultModel || undefined,
        ...('error' in loopDefaults ? {} : { loopDefaults }),
      }
    },
    async restartLoop(request) {
      const { executionModel, executionVariant, force, expectedStartedAt, ...required } = request
      const input: ForgeLoopRestartInput = {
        ...required,
        ...(executionModel ? { executionModel } : {}),
        ...(executionVariant ? { executionVariant } : {}),
        ...(force !== undefined ? { force } : {}),
        ...(expectedStartedAt ? { expectedStartedAt } : {}),
      }
      const result = await call((rpc, location) => rpc.loopRestart(input, location), readForgeLoopRestartOutput)
      if ('error' in result) throw new Error(result.error)
      return { sessionId: result.sessionId }
    },
  }
}
