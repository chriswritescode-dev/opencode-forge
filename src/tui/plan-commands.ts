import type { PluginConfig } from '../types'
import type { ExecutionContextCache } from '../utils/tui-execution-context-cache'
import type { ForgeProjectClient } from './project-client'
import { openExecutionDialog } from './execute-plan-panel'
import type { ForgeTuiHost } from './host'

export interface ForgePlanCommandsDeps {
  host: ForgeTuiHost
  pluginConfig: PluginConfig
  currentSessionId(): string | null
  ensureClient(): Promise<ForgeProjectClient | null>
  cache(): ExecutionContextCache | null
}

export interface ForgePlanCommands {
  /**
   * Opens the execution dialog for the current session's stored plan (or an empty plan the user
   * pastes from the dialog). Without a session, only a restart is possible, so it opens the
   * restart dialog instead.
   */
  executePlan(): Promise<void>
  /** Opens the execution dialog in restart mode for the project's restartable loops. */
  restartLoop(options?: { emptyMessage?: string }): Promise<void>
}

export function createForgePlanCommands(deps: ForgePlanCommandsDeps): ForgePlanCommands {
  const { host } = deps

  async function restartLoop(options?: { emptyMessage?: string }): Promise<void> {
    const client = await deps.ensureClient()
    if (!client) return
    const result = await client.loadLoops()
    if ('error' in result) {
      host.toast({ message: `Could not list loops: ${result.error}`, variant: 'warning', duration: 5000 })
      return
    }
    const loops = result.loops
    const restartable = loops.filter((loop) => loop.restartable)
    if (restartable.length === 0) {
      const reason = loops.find((loop) => loop.restartBlockedMessage)?.restartBlockedMessage
      host.toast({ message: options?.emptyMessage ?? reason ?? 'No restartable loops', variant: 'info', duration: 5000 })
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
      initial: {
        loopName: currentLoop.name,
        auditorModel: currentLoop.auditorModel,
        auditorVariant: currentLoop.auditorVariant,
        executionModel: currentLoop.executionModel,
        executionVariant: currentLoop.executionVariant,
      },
      restart: {
        loops,
        async onRestart(request) {
          const auditorModel = request.auditorModel || host.defaultModel()
          if (!auditorModel) throw new Error('Select an auditor model before restarting')
          const executionModel = request.executionModel || host.defaultModel()
          if (!executionModel) throw new Error('Select an execution model before restarting')
          const restarted = await client.restartLoop({ ...request, auditorModel, executionModel })
          await client.selectSession(restarted.sessionId)
        },
      },
    })
  }

  return {
    async executePlan() {
      const sessionId = deps.currentSessionId()
      if (!sessionId) {
        await restartLoop({ emptyMessage: 'Open a session to execute a plan' })
        return
      }
      const client = await deps.ensureClient()
      if (!client) return
      openExecutionDialog({
        host,
        client,
        cache: deps.cache(),
        pluginConfig: deps.pluginConfig,
        planContent: (await client.loadLatestPlan(sessionId)) ?? '',
        sessionId,
        onOpenRestart: () => restartLoop(),
      })
    },
    restartLoop,
  }
}
