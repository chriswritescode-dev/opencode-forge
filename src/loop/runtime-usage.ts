import type { ForgeClient } from '../client/port'
import type { Logger, PluginConfig } from '../types'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopState } from './state'
import { summarizeAssistantUsage, type UsageAttribution, type AssistantMessageInfo } from './token-usage'

export interface UsageCaptureDeps {
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  projectId: string
  loopSessionUsageRepo?: LoopSessionUsageRepo
}

export interface UsageCapture {
  getFallbackModelForSession(state: LoopState, phase: LoopState['phase']): string | undefined
  captureLoopSessionUsage(input: {
    loopName: string
    sessionId: string
    directory: string
    role: 'code' | 'auditor' | 'unknown'
    fallbackModel?: string
  }): Promise<void>
}

export function createUsageCapture(deps: UsageCaptureDeps): UsageCapture {
  const { client, logger, getConfig, projectId, loopSessionUsageRepo } = deps

  /**
   * Determine the fallback model for a session based on phase and loop state.
   * For code sessions: state.executionModel > config.executionModel
   * For audit/final-audit sessions: state.auditorModel > state.executionModel > config.auditorModel > config.executionModel
   */
  function getFallbackModelForSession(state: LoopState, phase: LoopState['phase']): string | undefined {
    const config = getConfig()
    if (phase === 'auditing' || phase === 'final_auditing') {
      return (
        state.auditorModel ??
        state.executionModel ??
        config.auditorModel ??
        config.executionModel
      )
    }
    // Code session
    return (
      state.executionModel ??
      config.executionModel
    )
  }

  /**
   * Capture and persist token usage for a loop session.
   * Non-fatal: logs errors but does not block deletion or termination.
   */
  async function captureLoopSessionUsage(input: {
    loopName: string
    sessionId: string
    directory: string
    role: 'code' | 'auditor' | 'unknown'
    fallbackModel?: string
  }): Promise<void> {
    if (!loopSessionUsageRepo) {
      return
    }

    try {
      const messages = await client.session.messages({
        sessionID: input.sessionId,
        directory: input.directory,
      }) as Array<{ info: AssistantMessageInfo }>

      const attribution: UsageAttribution = {
        role: input.role,
        fallbackModel: input.fallbackModel,
      }

      const usageSummary = summarizeAssistantUsage(messages, attribution)

      if (usageSummary.perModel.length === 0) {
        logger.debug(`Loop: no assistant usage to capture for session ${input.sessionId}`)
        return
      }

      const rows = usageSummary.perModel.map((modelUsage) => ({
        projectId,
        loopName: input.loopName,
        sessionId: input.sessionId,
        role: input.role,
        model: modelUsage.model,
        cost: modelUsage.cost,
        inputTokens: modelUsage.tokens.input,
        outputTokens: modelUsage.tokens.output,
        reasoningTokens: modelUsage.tokens.reasoning,
        cacheReadTokens: modelUsage.tokens.cacheRead,
        cacheWriteTokens: modelUsage.tokens.cacheWrite,
        messageCount: modelUsage.messageCount,
        capturedAt: Date.now(),
      }))

      loopSessionUsageRepo.upsertSessionUsage(rows)
      logger.debug(`Loop: captured usage for session ${input.sessionId} (${input.role})`)
    } catch (err) {
      logger.error(`Loop: failed to capture usage for session ${input.sessionId}`, err)
    }
  }

  return {
    getFallbackModelForSession,
    captureLoopSessionUsage,
  }
}
