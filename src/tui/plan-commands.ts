import type { PluginConfig } from '../types'
import type { ExecutionContextCache } from '../utils/tui-execution-context-cache'
import type { ForgeProjectClient } from './project-client'
import { fetchLoopsList } from '../utils/tui-loop-store'
import { normalizePastedPlanText } from '../utils/marked-plan-parser'
import { openExecutionDialog } from './execute-plan-panel'
import type { ForgeTuiHost } from './host'

export interface ForgePlanCommandsDeps {
  host: ForgeTuiHost
  pluginConfig: PluginConfig
  dbPath: string
  currentSessionId(): string | null
  ensureClient(): Promise<ForgeProjectClient | null>
  cache(): ExecutionContextCache | null
}

export interface ForgePlanCommands {
  executePlan(): Promise<void>
  executePastedPlan(): Promise<void>
  restartLoop(): Promise<void>
}

export function createForgePlanCommands(deps: ForgePlanCommandsDeps): ForgePlanCommands {
  const { host } = deps

  const requireSessionId = (): string | null => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) host.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
    return sessionId
  }

  const openPlanDialog = (client: ForgeProjectClient, sessionId: string, planContent: string) => {
    openExecutionDialog({
      host,
      client,
      cache: deps.cache(),
      pluginConfig: deps.pluginConfig,
      planContent,
      sessionId,
    })
  }

  const openPastePlanDialog = async (client: ForgeProjectClient, sessionId: string): Promise<void> => {
    const pasted = await host.prompt({ title: 'Paste plan', placeholder: 'Paste a marked or unmarked implementation plan', value: '' })
    if (pasted === undefined) return
    const normalized = normalizePastedPlanText(pasted)
    if (!normalized.ok) {
      host.toast({
        message: normalized.reason === 'empty' ? 'Paste a plan before executing' : `Invalid plan markers: ${normalized.reason}`,
        variant: 'error',
        duration: 4000,
      })
      await openPastePlanDialog(client, sessionId)
      return
    }
    openPlanDialog(client, sessionId, normalized.planText)
  }

  return {
    async executePlan() {
      const sessionId = requireSessionId()
      if (!sessionId) return
      const client = await deps.ensureClient()
      if (!client) return

      const planText = await client.loadLatestPlan(sessionId)
      if (!planText) {
        host.toast({ message: 'No plan in current session — paste one to execute', variant: 'info', duration: 4000 })
        await openPastePlanDialog(client, sessionId)
        return
      }
      openPlanDialog(client, sessionId, planText)
    },

    async executePastedPlan() {
      const sessionId = requireSessionId()
      if (!sessionId) return
      const client = await deps.ensureClient()
      if (client) await openPastePlanDialog(client, sessionId)
    },

    async restartLoop() {
      const client = await deps.ensureClient()
      if (!client?.projectId) return
      const loops = fetchLoopsList(client.projectId, deps.dbPath)
      const restartable = loops.filter((loop) => loop.restartable)
      if (restartable.length === 0) {
        const reason = loops.find((loop) => loop.restartBlockedMessage)?.restartBlockedMessage
        host.toast({ message: reason ?? 'No restartable loops', variant: 'info', duration: 5000 })
        return
      }

      const currentSessionId = deps.currentSessionId()
      const currentLoop = restartable.find((loop) => loop.sessionId === currentSessionId) ?? restartable[0]
      openExecutionDialog({
        host,
        client,
        cache: deps.cache(),
        pluginConfig: deps.pluginConfig,
        planContent: '',
        sessionId: currentSessionId ?? '',
          initialLoopName: currentLoop.name,
        initialAuditorModel: currentLoop.auditorModel,
        initialAuditorVariant: currentLoop.auditorVariant,
        initialExecutionModel: currentLoop.executionModel,
        initialExecutionVariant: currentLoop.executionVariant,
        restart: {
          loops,
          async onRestart(request) {
            const auditorModel = request.auditorModel || host.defaultModel()
            if (!auditorModel) throw new Error('Select an auditor model before restarting')
            const executionModel = request.executionModel || host.defaultModel()
            if (!executionModel) throw new Error('Select an execution model before restarting')
            const result = await client.restartLoop({ ...request, auditorModel, executionModel })
            await client.selectSession(result.sessionId)
          },
        },
      })
    },
  }
}
