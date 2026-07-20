import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import type { LoopEventsRepo, LoopEventType, LoopEventRole, LoopEventVerdict } from '../storage/repos/loop-events-repo'
import type { LoopRunsRepo } from '../storage/repos/loop-runs-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopState } from './state'
import { fetchSessionUsage, type SessionUsageInput } from './runtime-usage'
import { type LoopUsageSummary, type TokenBreakdown, emptyTokenBreakdown } from './token-usage'

interface LoopMetricsDeps {
  client: ForgeClient
  logger: Logger
  projectId: string
  loopEventsRepo?: LoopEventsRepo
  loopRunsRepo?: LoopRunsRepo
  loopSessionUsageRepo?: LoopSessionUsageRepo
  refreshSessionUsage?: (input: SessionUsageInput) => Promise<import('./token-usage').LoopUsageSummary>
}

interface PhaseEventInput {
  state: LoopState
  eventType: 'coding_done' | 'audit_done' | 'final_audit_done' | 'post_action_done'
  outcome: string
  verdict?: 'clean' | 'dirty'
  sessionId: string
  directory: string
  role: 'code' | 'auditor'
  findingsTotal?: number
  findingsBugs?: number
  fallbackModel?: string
}

interface TerminationInput {
  status: string
  reason: string
  completedAt: number
}

interface LoopMetricsRecorder {
  recordPhaseEvent(input: PhaseEventInput): Promise<void>
  recordTermination(state: LoopState, input: TerminationInput): void
}

export function createLoopMetricsRecorder(deps: LoopMetricsDeps): LoopMetricsRecorder {
  const { client, logger, projectId, loopEventsRepo, loopRunsRepo, loopSessionUsageRepo } = deps
  const refreshSessionUsage = deps.refreshSessionUsage ?? ((input: SessionUsageInput) => fetchSessionUsage(client, input))

  /**
   * Convert a LoopState.startedAt (ISO string) to the millisecond epoch value
   * the metrics tables store as run_started_at / started_at.
   */
  function startedAtMs(state: LoopState): number {
    return new Date(state.startedAt).getTime()
  }

  /**
   * Reduce a usage summary to the dominant-model label and total message
   * count. Total cost and total tokens are the canonical fields already
   * computed by `summarizeAssistantUsage` (see token-usage.ts), so we
   * read them directly instead of re-accumulating perModel — keeping one
   * source of truth for token/cost aggregation.
   */
  function reduceUsage(summary: LoopUsageSummary): {
    model: string | null
    cost: number
    tokens: TokenBreakdown
    messageCount: number
  } {
    let messageCount = 0
    let dominantModel: string | null = null
    let dominantCost = -1
    for (const entry of summary.perModel) {
      messageCount += entry.messageCount
      // Strictly-greater comparison keeps the first-seen model on a tie.
      // summarizeAssistantUsage returns perModel sorted alphabetically, so a
      // tie resolves deterministically to the alphabetically-first model.
      if (entry.cost > dominantCost) {
        dominantCost = entry.cost
        dominantModel = entry.model
      }
    }
    return {
      model: dominantModel,
      cost: summary.totalCost,
      tokens: summary.totalTokens,
      messageCount,
    }
  }

  /**
   * Record a single phase event (coding/audit/final-audit/post-action) into
   * loop_events with token usage summed across all assistant messages in the
   * session. Non-fatal: any failure (including client fetch errors) is logged
   * at debug level and a zeroed-usage event row is still written, because phase
   * events matter more than token counts.
   */
  async function recordPhaseEvent(input: PhaseEventInput): Promise<void> {
    if (!loopEventsRepo) {
      return
    }

    const runStartedAt = startedAtMs(input.state)
    const iteration = input.state.iteration ?? 0
    const sectionIndex = input.state.totalSections > 0 ? input.state.currentSectionIndex : null

    let usage = {
      model: null as string | null,
      cost: 0,
      tokens: emptyTokenBreakdown(),
      messageCount: 0,
    }

    try {
      const summary = await refreshSessionUsage({
        sessionId: input.sessionId,
        directory: input.directory,
        role: input.role,
        fallbackModel: input.fallbackModel,
      })
      usage = reduceUsage(summary)
    } catch (err) {
      logger.debug(
        `Loop: failed to summarize usage for phase event ${input.eventType} (session ${input.sessionId}); recording zeroed usage`,
        err,
      )
    }

    try {
      loopEventsRepo.insert({
        projectId,
        loopName: input.state.loopName,
        runStartedAt,
        eventType: input.eventType as LoopEventType,
        outcome: input.outcome,
        verdict: (input.verdict ?? null) as LoopEventVerdict,
        iteration,
        sectionIndex,
        sessionId: input.sessionId,
        role: input.role as LoopEventRole,
        model: usage.model,
        cost: usage.cost,
        inputTokens: usage.tokens.input,
        outputTokens: usage.tokens.output,
        reasoningTokens: usage.tokens.reasoning,
        cacheReadTokens: usage.tokens.cacheRead,
        cacheWriteTokens: usage.tokens.cacheWrite,
        messageCount: usage.messageCount,
        findingsTotal: input.findingsTotal ?? null,
        findingsBugs: input.findingsBugs ?? null,
        detail: null,
        createdAt: Date.now(),
      })
    } catch (err) {
      // Non-fatal: metrics must never break the loop state machine.
      logger.debug(`Loop: failed to record phase event ${input.eventType} for loop ${input.state.loopName}`, err)
    }
  }

  /**
   * Record a loop's termination: append a loop_terminated phase event and
   * upsert (replace) the loop_runs summary row. Non-fatal: every error is
   * swallowed so termination can never fail because of metrics.
   */
  function recordTermination(state: LoopState, input: TerminationInput): void {
    try {
      const runStartedAt = startedAtMs(state)

      if (loopEventsRepo) {
        try {
          loopEventsRepo.insert({
            projectId,
            loopName: state.loopName,
            runStartedAt,
            eventType: 'loop_terminated',
            outcome: input.reason,
            verdict: null,
            iteration: state.iteration,
            sectionIndex: state.totalSections > 0 ? state.currentSectionIndex : null,
            sessionId: state.sessionId,
            role: null,
            model: null,
            cost: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            messageCount: 0,
            findingsTotal: null,
            findingsBugs: null,
            detail: JSON.stringify({ status: input.status }),
            createdAt: Date.now(),
          })
        } catch (err) {
          logger.debug(`Loop: failed to record termination event for loop ${state.loopName}`, err)
        }
      }

      if (loopRunsRepo) {
        try {
          const audits = loopEventsRepo
            ? loopEventsRepo.auditCountsForRun(projectId, state.loopName, runStartedAt)
            : { cleanAudits: 0, dirtyAudits: 0, sectionRetries: 0 }

          let aggregateCost = 0
          let aggregateInputTokens = 0
          let aggregateOutputTokens = 0
          let aggregateReasoningTokens = 0
          let aggregateCacheReadTokens = 0
          let aggregateCacheWriteTokens = 0
          let aggregateMessageCount = 0
          if (loopSessionUsageRepo) {
            // Run-scoped aggregate: usage rows stamp run_started_at at capture
            // time, and a restarted run gets a new started_at, so equality
            // filtering isolates only this run — even when a prior run captured
            // usage in the same millisecond as this run's startedAt.
            const aggregate = loopSessionUsageRepo.getAggregateForRun(projectId, state.loopName, runStartedAt)
            if (aggregate) {
              aggregateCost = aggregate.totalCost
              aggregateInputTokens = aggregate.totalInputTokens
              aggregateOutputTokens = aggregate.totalOutputTokens
              aggregateReasoningTokens = aggregate.totalReasoningTokens
              aggregateCacheReadTokens = aggregate.totalCacheReadTokens
              aggregateCacheWriteTokens = aggregate.totalCacheWriteTokens
              aggregateMessageCount = aggregate.totalMessageCount
            }
          }

          loopRunsRepo.upsert({
            projectId,
            loopName: state.loopName,
            startedAt: runStartedAt,
            completedAt: input.completedAt,
            status: input.status,
            terminationReason: input.reason,
            loopKind: state.kind ?? 'plan',
            executionModel: state.executionModel ?? null,
            auditorModel: state.auditorModel ?? null,
            executionVariant: state.executionVariant ?? null,
            auditorVariant: state.auditorVariant ?? null,
            iterations: state.iteration,
            auditCount: state.auditCount,
            errorCount: state.errorCount,
            totalSections: state.totalSections,
            sectionRetries: audits.sectionRetries,
            cleanAudits: audits.cleanAudits,
            dirtyAudits: audits.dirtyAudits,
            cost: aggregateCost,
            inputTokens: aggregateInputTokens,
            outputTokens: aggregateOutputTokens,
            reasoningTokens: aggregateReasoningTokens,
            cacheReadTokens: aggregateCacheReadTokens,
            cacheWriteTokens: aggregateCacheWriteTokens,
            messageCount: aggregateMessageCount,
            durationMs: input.completedAt - runStartedAt,
            createdAt: Date.now(),
          })
        } catch (err) {
          logger.debug(`Loop: failed to record termination row for loop ${state.loopName}`, err)
        }
      }
    } catch (err) {
      // Outer guard: terminate must never throw from metrics.
      logger.debug(`Loop: termination metrics recording failed for loop ${state.loopName}`, err)
    }
  }

  return {
    recordPhaseEvent,
    recordTermination,
  }
}
