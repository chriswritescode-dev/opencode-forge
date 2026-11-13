import { formatTokens, truncate } from './format'
import type { LoopSessionOutput } from '../loop'
import type { LoopUsageSummary, RoleUsage, TokenBreakdown } from '../loop/token-usage'
import { USAGE_ROLE_ORDER, mergeUsageSummaries } from '../loop/token-usage'
import type { LoopUsageAggregate, LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'

export { formatTokens } from './format'
export type { LoopUsageSummary } from '../loop/token-usage'

function buildCumulativeUsage(
  loopSessionUsageRepo: LoopSessionUsageRepo | undefined,
  projectId: string,
  loopName: string,
  currentSessionId: string,
  sessionOutput: LoopSessionOutput | null,
): LoopUsageSummary | null {
  if (!loopSessionUsageRepo) {
    return sessionOutput?.usageSummary ?? null
  }

  const persistedAggregate = loopSessionUsageRepo.getAggregate(projectId, loopName)
  const sessionIsPersisted = loopSessionUsageRepo.hasSession(projectId, loopName, currentSessionId)

  const persistedSummary = persistedAggregate ? aggregateToUsageSummary(persistedAggregate) : null
  const liveSummary = sessionOutput?.usageSummary ?? null

  if (sessionIsPersisted) {
    return persistedSummary
  }

  if (persistedSummary && liveSummary) {
    return mergeUsageSummaries(persistedSummary, liveSummary)
  }

  return persistedSummary ?? liveSummary
}

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

function tokensFromAggregate(data: LoopUsageAggregate['byModel'][string]): TokenBreakdown {
  return {
    input: data.inputTokens,
    output: data.outputTokens,
    reasoning: data.reasoningTokens,
    cacheRead: data.cacheReadTokens,
    cacheWrite: data.cacheWriteTokens,
  }
}

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

function formatTokenBreakdown(tokens: TokenBreakdown): string {
  return `${formatTokens(tokens.input)} in / ${formatTokens(tokens.output)} out / ${formatTokens(tokens.reasoning)} reasoning / ${formatTokens(tokens.cacheRead)} cache read / ${formatTokens(tokens.cacheWrite)} cache write`
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`
}

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

  if (sessionOutput.usageSummary) {
    const usageLines = formatUsageSummary(sessionOutput.usageSummary)
    for (const line of usageLines) {
      lines.push(`  ${line}`)
    }
  } else {
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

export function formatPostActionReportLines(report: string): string[] {
  return ['', 'Post-Action Report:', report]
}
