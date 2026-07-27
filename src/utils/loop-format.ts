import { formatTokens, truncate } from './format'
import type { LoopSessionOutput } from '../loop'
import type { LoopUsageSummary, RoleUsage, TokenBreakdown } from '../loop/token-usage'
import { USAGE_ROLE_ORDER, mergeUsageSummaries } from '../loop/token-usage'
import type { LoopUsageAggregate, LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'

export { formatTokens } from './format'
export type { LoopUsageSummary } from '../loop/token-usage'

/**
 * Build cumulative usage for a loop by merging persisted aggregate with live session output.
 * Prevents double-counting by checking if the current session is already persisted.
 *
 * @param loopSessionUsageRepo - Repository to check persistence status and fetch aggregate
 * @param projectId - Project identifier
 * @param loopName - Loop name
 * @param currentSessionId - Current session ID to check for persistence
 * @param sessionOutput - Live session output (may be null if worktree unavailable)
 */
function buildCumulativeUsage(
  loopSessionUsageRepo: LoopSessionUsageRepo | undefined,
  projectId: string,
  loopName: string,
  currentSessionId: string,
  sessionOutput: LoopSessionOutput | null,
): LoopUsageSummary | null {
  if (!loopSessionUsageRepo) {
    // No repo available, return live usage only if present
    return sessionOutput?.usageSummary ?? null
  }

  const persistedAggregate = loopSessionUsageRepo.getAggregate(projectId, loopName)
  const sessionIsPersisted = loopSessionUsageRepo.hasSession(projectId, loopName, currentSessionId)

  const persistedSummary = persistedAggregate ? aggregateToUsageSummary(persistedAggregate) : null
  const liveSummary = sessionOutput?.usageSummary ?? null

  if (sessionIsPersisted) {
    // Current session already persisted - use persisted only to avoid double-counting
    return persistedSummary
  }

  // Merge persisted + live (live session not yet persisted)
  if (persistedSummary && liveSummary) {
    return mergeUsageSummaries(persistedSummary, liveSummary)
  }

  // Return whichever one exists
  return persistedSummary ?? liveSummary
}

/**
 * The single render path for a loop's cumulative usage block. Returns [] when
 * there is nothing to report so callers can spread unconditionally.
 */
export function formatCumulativeUsage(
  loopSessionUsageRepo: LoopSessionUsageRepo | undefined,
  projectId: string,
  loopName: string,
  currentSessionId: string,
  sessionOutput: LoopSessionOutput | null,
): string[] {
  const summary = buildCumulativeUsage(loopSessionUsageRepo, projectId, loopName, currentSessionId, sessionOutput)
  if (!summary) return []
  return ['', 'Cumulative Usage:', ...formatUsageSummary(summary).map(l => `  ${l}`)]
}

/** Project a persisted per-model or per-role usage bucket onto a TokenBreakdown. */
function tokensFromAggregate(data: LoopUsageAggregate['byModel'][string]): TokenBreakdown {
  return {
    input: data.inputTokens,
    output: data.outputTokens,
    reasoning: data.reasoningTokens,
    cacheRead: data.cacheReadTokens,
    cacheWrite: data.cacheWriteTokens,
  }
}

/** Convert LoopUsageAggregate from database to LoopUsageSummary */
export function aggregateToUsageSummary(aggregate: LoopUsageAggregate): LoopUsageSummary {
  const totalTokens: TokenBreakdown = {
    input: aggregate.totalInputTokens,
    output: aggregate.totalOutputTokens,
    reasoning: aggregate.totalReasoningTokens,
    cacheRead: aggregate.totalCacheReadTokens,
    cacheWrite: aggregate.totalCacheWriteTokens,
  }

  const perModel = Object.entries(aggregate.byModel).map(([model, data]) => ({
    model,
    cost: data.cost,
    tokens: tokensFromAggregate(data),
    messageCount: data.messageCount,
  })).sort((a, b) => a.model.localeCompare(b.model))

  const perRole: RoleUsage[] = USAGE_ROLE_ORDER
    .filter(role => aggregate.byRole[role] !== undefined)
    .map(role => {
      const data = aggregate.byRole[role]!
      return {
        role,
        cost: data.cost,
        tokens: tokensFromAggregate(data),
        messageCount: data.messageCount,
      }
    })

  return {
    totalCost: aggregate.totalCost,
    totalTokens,
    perModel,
    perRole,
  }
}

/** The single token-line rendering: `<in> in / <out> out / ... cache write`. */
function formatTokenBreakdown(tokens: TokenBreakdown): string {
  return `${formatTokens(tokens.input)} in / ${formatTokens(tokens.output)} out / ${formatTokens(tokens.reasoning)} reasoning / ${formatTokens(tokens.cacheRead)} cache read / ${formatTokens(tokens.cacheWrite)} cache write`
}

/** The single cost rendering: fixed 4-decimal dollars. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`
}

/** Format a LoopUsageSummary into deterministic total and per-model output */
export function formatUsageSummary(summary: LoopUsageSummary): string[] {
  const lines: string[] = []

  lines.push(`Total Cost: ${formatCost(summary.totalCost)} | Tokens: ${formatTokenBreakdown(summary.totalTokens)}`)

  if (summary.perModel.length > 0) {
    lines.push('Per-model usage:')
    for (const modelUsage of summary.perModel) {
      lines.push(`  ${modelUsage.model}: ${formatCost(modelUsage.cost)} | ${formatTokenBreakdown(modelUsage.tokens)}`)
    }
  }

  const perRole = summary.perRole ?? []
  if (perRole.length > 0) {
    lines.push('Per-role usage:')
    for (const roleUsage of perRole) {
      lines.push(`  ${roleUsage.role}: ${formatCost(roleUsage.cost)} | ${formatTokenBreakdown(roleUsage.tokens)}`)
    }
  }

  return lines
}

export function formatSessionOutput(
  sessionOutput: LoopSessionOutput,
): string[] {
  const lines: string[] = []

  if (sessionOutput.messages.length > 0) {
    lines.push('Recent Activity:')
    for (const msg of sessionOutput.messages) {
      const preview = truncate(msg.text.replace(/\n/g, ' ').trim(), 1000)
      lines.push(`  [assistant] ${preview}`)
    }
    lines.push('')
  }

  // Use formatUsageSummary if usageSummary is available, otherwise format inline
  if (sessionOutput.usageSummary) {
    const usageLines = formatUsageSummary(sessionOutput.usageSummary)
    for (const line of usageLines) {
      lines.push(`  ${line}`)
    }
  } else {
    // Fallback to inline formatting for backward compatibility
    lines.push(`  Cost: ${formatCost(sessionOutput.totalCost)} | Tokens: ${formatTokenBreakdown(sessionOutput.totalTokens)}`)
  }

  if (sessionOutput.fileChanges) {
    const fc = sessionOutput.fileChanges
    lines.push(`  Files changed: ${fc.files} (+${fc.additions}/-${fc.deletions} lines)`)
  }

  return lines
}

export function formatAuditResult(auditResult: string): string[] {
  const auditPreview = truncate(auditResult, 300)
  return ['', 'Last Audit:', `  ${auditPreview}`]
}

export function formatCompletionSummary(summary: string): string[] {
  const preview = truncate(summary, 1000)
  return ['', 'Completion Summary (post-action):', `  ${preview}`]
}

/** Full, untruncated transcript of the post-action run (e.g. pr-review output). */
export function formatPostActionReport(report: string): string[] {
  return ['', 'Post-Action Report:', report]
}
