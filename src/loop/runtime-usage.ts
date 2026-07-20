import type { ForgeClient } from '../client/port'
import type { Logger, PluginConfig } from '../types'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopState } from './state'
import { summarizeAssistantUsage, type AssistantMessageInfo, type LoopUsageSummary } from './token-usage'

export interface SessionUsageInput {
  sessionId: string
  directory: string
  role: 'code' | 'auditor' | 'unknown'
  fallbackModel?: string
}

export async function fetchSessionUsage(client: ForgeClient, input: SessionUsageInput): Promise<LoopUsageSummary> {
  const messages = await client.session.messages({
    sessionID: input.sessionId,
    directory: input.directory,
  }) as Array<{ info: AssistantMessageInfo }>
  return summarizeAssistantUsage(messages, {
    role: input.role,
    fallbackModel: input.fallbackModel,
  })
}

export interface UsageCaptureDeps {
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  projectId: string
  loopSessionUsageRepo?: LoopSessionUsageRepo
}

export interface UsageCapture {
  getFallbackModelForSession(state: LoopState, phase: LoopState['phase']): string | undefined
  refreshSessionUsage(input: SessionUsageInput): Promise<LoopUsageSummary>
  captureLoopSessionUsage(input: {
    loopName: string
    sessionId: string
    directory: string
    role: 'code' | 'auditor' | 'unknown'
    fallbackModel?: string
    /**
     * Ms-epoch of the loop's started_at. Stamped on every persisted usage row
     * so per-run aggregation can filter by exact equality instead of the
     * ambiguous captured_at lower bound. Required when usage is persisted.
     */
    runStartedAt: number
  }): Promise<void>
}

export function createUsageCapture(deps: UsageCaptureDeps): UsageCapture {
  const { client, logger, getConfig, projectId, loopSessionUsageRepo } = deps
  const refreshedUsage = new Map<string, LoopUsageSummary>()

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

  async function refreshSessionUsage(input: SessionUsageInput): Promise<LoopUsageSummary> {
    const summary = await fetchSessionUsage(client, input)
    refreshedUsage.set(input.sessionId, summary)
    return summary
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
    runStartedAt: number
  }): Promise<void> {
    if (!loopSessionUsageRepo) {
      return
    }

    try {
      const usageSummary = refreshedUsage.get(input.sessionId)
        ?? await fetchSessionUsage(client, input)
      refreshedUsage.delete(input.sessionId)

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
        runStartedAt: input.runStartedAt,
      }))

      loopSessionUsageRepo.upsertSessionUsage(rows)
      logger.debug(`Loop: captured usage for session ${input.sessionId} (${input.role})`)
    } catch (err) {
      logger.error(`Loop: failed to capture usage for session ${input.sessionId}`, err)
    }
  }

  return {
    getFallbackModelForSession,
    refreshSessionUsage,
    captureLoopSessionUsage,
  }
}
