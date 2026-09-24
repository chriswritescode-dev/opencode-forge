import type { Plugin } from '@opencode/plugin/tui'
import { toProviderListFromV2 } from '../client/v2-adapter'
import { FORGE_RPC, readForgeExecutePlanOutput, type ForgeExecutePlanInput } from '../host/forge-rpc'
import type { ExecutionContext, ForgeProjectClient } from '../utils/tui-client'
import { deriveExecutionPreferencesFromWorkspaces } from '../utils/tui-execution-preferences'
import { fetchLoopsList, fetchStoredSessionPlan, requestTuiLoopRestart } from '../utils/tui-loop-store'
import { providersFromProviderList, type LoopInfo, type WorkspaceForRecents } from '../utils/tui-models'

export interface V2ForgeProjectClientOptions {
  projectId: string
  directory: string
  dbPath: string
  signal: AbortSignal
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
      defaultModel: fallback ? `${fallback.providerID}/${fallback.modelID}` : '',
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
  const { projectId, directory, dbPath, signal } = options

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
        }
        try {
          return readForgeExecutePlanOutput(await context.client.rpc(FORGE_RPC).executePlan(input, { location: { directory } }))
        } catch (err) {
          return { error: `Plan execution failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    },
    workspaces: {
      list: async () => [],
      status: async () => ({}),
    },
    async selectSession(sessionId) {
      context.ui.router.navigate({ type: 'session', sessionID: sessionId })
    },
    async loadLatestPlan(sessionId) {
      return fetchStoredSessionPlan(projectId, sessionId, dbPath)
    },
    async loadExecutionContext() {
      const { defaultModel, ...models } = await loadModels(context, directory)
      options.onDefaultModel(defaultModel)
      const workspaces = loopsToWorkspacesForRecents(projectId, fetchLoopsList(projectId, dbPath))
      return {
        preferences: deriveExecutionPreferencesFromWorkspaces(projectId, workspaces),
        models,
        sessions: context.data.session.list(),
        workspaces,
        openCodeFavorites: [],
        openCodeDefault: defaultModel || undefined,
      }
    },
    async restartLoop(request) {
      const applied = await requestTuiLoopRestart(projectId, request, { dbPath, signal })
      if (!applied.sessionId) throw new Error('Loop restart completed without a session')
      return { sessionId: applied.sessionId }
    },
  }
}
