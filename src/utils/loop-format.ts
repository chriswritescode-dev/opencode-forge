import { formatTokens, truncate } from './format'
import type { LoopSessionOutput } from '../loop'
import type { LoopUsageSummary, TokenBreakdown } from '../loop/token-usage'
import type { LoopUsageAggregate, LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { SectionDigestEntry } from '../loop/prompts'
import { mergeUsageSummaries } from '../loop/token-usage'

export { formatTokens } from './format'
export type { LoopUsageSummary } from '../loop/token-usage'
export type { SectionDigestEntry } from '../loop/prompts'

export interface FormatSectionSummariesOptions {
  sectionHeadingLevel?: number
  labelStyle?: 'bold' | 'heading'
  labelHeadingLevel?: number
}

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
export function buildCumulativeUsage(
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
    tokens: {
      input: data.inputTokens,
      output: data.outputTokens,
      reasoning: data.reasoningTokens,
      cacheRead: data.cacheReadTokens,
      cacheWrite: data.cacheWriteTokens,
    },
    messageCount: data.messageCount,
  })).sort((a, b) => a.model.localeCompare(b.model))

  return {
    totalCost: aggregate.totalCost,
    totalTokens,
    perModel,
  }
}

function hasSectionSummaryContent(section: SectionDigestEntry): boolean {
  return Boolean(section.summaryDone?.trim() || section.summaryDeviations?.trim() || section.summaryFollowUps?.trim())
}

function formatHeading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`
}

function pushSectionSummaryField(lines: string[], label: string, value: string | null, options: Required<FormatSectionSummariesOptions>): void {
  const trimmed = value?.trim()
  if (!trimmed) return

  lines.push(options.labelStyle === 'heading'
    ? formatHeading(options.labelHeadingLevel, label)
    : `**${label}:**`)
  lines.push(trimmed)
}

/** Format completed-section digest entries into deterministic markdown lines. */
export function formatSectionSummaries(sections: SectionDigestEntry[], options: FormatSectionSummariesOptions = {}): string[] {
  const resolvedOptions: Required<FormatSectionSummariesOptions> = {
    sectionHeadingLevel: options.sectionHeadingLevel ?? 4,
    labelStyle: options.labelStyle ?? 'bold',
    labelHeadingLevel: options.labelHeadingLevel ?? 3,
  }
  const lines: string[] = []
  sections.filter(hasSectionSummaryContent).forEach((s, i) => {
    if (i > 0) lines.push('')
    lines.push(formatHeading(resolvedOptions.sectionHeadingLevel, `Section ${s.index + 1}: ${s.title}`))
    pushSectionSummaryField(lines, 'Done', s.summaryDone, resolvedOptions)
    pushSectionSummaryField(lines, 'Deviations', s.summaryDeviations, resolvedOptions)
    pushSectionSummaryField(lines, 'Follow-ups', s.summaryFollowUps, resolvedOptions)
  })
  return lines
}

/** Format a LoopUsageSummary into deterministic total and per-model output */
export function formatUsageSummary(summary: LoopUsageSummary): string[] {
  const lines: string[] = []

  const costStr = `$${summary.totalCost.toFixed(4)}`
  const t = summary.totalTokens
  const tokensStr = `${formatTokens(t.input)} in / ${formatTokens(t.output)} out / ${formatTokens(t.reasoning)} reasoning / ${formatTokens(t.cacheRead)} cache read / ${formatTokens(t.cacheWrite)} cache write`
  lines.push(`Total Cost: ${costStr} | Tokens: ${tokensStr}`)

  if (summary.perModel.length > 0) {
    lines.push('Per-model usage:')
    for (const modelUsage of summary.perModel) {
      const modelCost = `$${modelUsage.cost.toFixed(4)}`
      const mt = modelUsage.tokens
      const modelTokensStr = `${formatTokens(mt.input)} in / ${formatTokens(mt.output)} out / ${formatTokens(mt.reasoning)} reasoning / ${formatTokens(mt.cacheRead)} cache read / ${formatTokens(mt.cacheWrite)} cache write`
      lines.push(`  ${modelUsage.model}: ${modelCost} | ${modelTokensStr}`)
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
    const costStr = `$${sessionOutput.totalCost.toFixed(4)}`
    const t = sessionOutput.totalTokens
    const tokensStr = `${formatTokens(t.input)} in / ${formatTokens(t.output)} out / ${formatTokens(t.reasoning)} reasoning / ${formatTokens(t.cacheRead)} cache read / ${formatTokens(t.cacheWrite)} cache write`
    lines.push(`  Cost: ${costStr} | Tokens: ${tokensStr}`)
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
