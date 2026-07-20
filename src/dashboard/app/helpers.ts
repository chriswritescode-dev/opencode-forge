import type { DashboardPayload, DashboardProject, DashboardLoop, DashboardLoopSummary } from './types'
import type { LoopEventRow, LoopRunRow, SectionPlanRow } from '../../storage'
import { formatDuration, computeElapsedSeconds } from '../../utils/duration'

export function parseLoopHash(hash: string): { projectId: string | null; loopName: string | null } {
  const out = { projectId: null as string | null, loopName: null as string | null }
  const raw = (hash || '').replace(/^#/, '')
  if (!raw) return out
  const slash = raw.indexOf('/')
  if (slash === -1) {
    out.projectId = decodeURIComponent(raw)
    return out
  }
  out.projectId = decodeURIComponent(raw.slice(0, slash))
  const lp = raw.slice(slash + 1)
  out.loopName = lp ? decodeURIComponent(lp) : null
  return out
}

export type DashboardRoute =
  | { kind: 'metrics' }
  | { kind: 'loop'; projectId: string; loopName: string | null }
  | { kind: 'list' }

/**
 * Top-level dashboard route classifier. `#metrics` is reserved for the
 * cross-run comparison view; everything else delegates to `parseLoopHash`,
 * yielding a `loop` route with an optional loop name or a `list` route when
 * the hash is empty.
 */
export function parseRoute(hash: string): DashboardRoute {
  const raw = (hash || '').replace(/^#/, '')
  if (raw === 'metrics') return { kind: 'metrics' }
  const parsed = parseLoopHash(hash)
  if (!parsed.projectId) return { kind: 'list' }
  return { kind: 'loop', projectId: parsed.projectId, loopName: parsed.loopName }
}

export function buildLoopHash(projectId: string | null, loopName: string | null): string {
  if (!projectId) return ''
  let h = '#' + encodeURIComponent(projectId)
  if (loopName) h += '/' + encodeURIComponent(loopName)
  return h
}

/**
 * Set `location.hash` to `nextHash` only if it differs from the current value,
 * suppressing the hashchange event via `suppressRef`.
 * Normalisation (strips/re-adds `#`) matches the existing behaviour exactly.
 */
export function syncHash(nextHash: string, suppressRef: { current: boolean }): void {
  const current = location.hash || ''
  const currentNorm = '#' + current.replace(/^#/, '')
  const nextNorm = '#' + nextHash.replace(/^#/, '')
  if (currentNorm !== nextNorm) {
    suppressRef.current = true
    location.hash = nextHash
  }
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts || ts === 0) return ''
  const d = new Date(ts)
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  const month = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const year = d.getFullYear()
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12
  if (hours === 0) hours = 12
  return month + '-' + day + '-' + year + ' ' + hours + ':' + pad(d.getMinutes()) + ' ' + ampm
}

export function statusClass(status: string): string {
  return 'status-badge status-' + status
}

export function sectionStatusClass(s: string): string {
  return 'section-status section-' + s
}

export function loopMatchesFilters(
  loop: DashboardLoopSummary['loop'],
  project: DashboardProject,
  activeStatuses: Set<string>,
  searchText: string,
): boolean {
  const statusOk = activeStatuses.size === 0 || activeStatuses.has(loop.status)
  if (!statusOk) return false
  if (!searchText) return true
  const hay = ((loop.loopName || '') + ' ' + (project.projectDir || project.projectId || '')).toLowerCase()
  return hay.indexOf(searchText) !== -1
}

export function dataHash(data: DashboardPayload): string {
  return JSON.stringify(data, (_k: string, v: unknown) => {
    if (_k === 'generatedAt') return undefined
    return v
  })
}

export function deriveSidebarLabel(rawPath: string): string {
  const rawSegments = rawPath.split('/').filter(Boolean)
  return rawSegments.length ? rawSegments[rawSegments.length - 1] : rawPath
}

export function splitFindings(
  findings: DashboardLoop['findings'],
): { bugs: DashboardLoop['findings']; warnings: DashboardLoop['findings'] } {
  const bugs: DashboardLoop['findings'] = []
  const warnings: DashboardLoop['findings'] = []
  for (const finding of findings) {
    if (finding.severity === 'bug') bugs.push(finding)
    else warnings.push(finding)
  }
  return { bugs, warnings }
}

/** Classifies split findings into the severity tier used for badge styling. */
export function findingsLevel(split: {
  bugs: DashboardLoop['findings']
  warnings: DashboardLoop['findings']
}): 'bug' | 'warn' | 'clean' {
  if (split.bugs.length > 0) return 'bug'
  if (split.warnings.length > 0) return 'warn'
  return 'clean'
}

/** Pluralizes a finding count, e.g. (1, 'bug') -> '1 bug', (2, 'bug') -> '2 bugs'. */
export function formatFindingCount(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's')
}

/** Clamps current/total to a 0–100 fill percentage, guarding non-positive totals. */
export function clampPercent(current: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, (current / total) * 100))
}

export function formatFinding(f: DashboardLoop['findings'][number]): string {
  let text = f.file + ':' + f.line + ' — ' + f.description
  if (f.scenario) {
    text += ' (' + f.scenario + ')'
  }
  return text
}

export function formatModelUsage(
  model: string,
  m: NonNullable<DashboardLoop['usage']>['byModel'][string],
): string {
  return (
    '  ' +
    model +
    ': $' +
    m.cost.toFixed(6) +
    ', ' +
    m.inputTokens +
    ' in / ' +
    m.outputTokens +
    ' out (reasoning: ' +
    m.reasoningTokens +
    ', cache R: ' +
    m.cacheReadTokens +
    ' W: ' +
    m.cacheWriteTokens +
    '), messages: ' +
    m.messageCount
  )
}

/** Compact token count: 12,345 → "12.3k", 3,400,000 → "3.4M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

/** Cost label: small values keep more precision ($0.1234), larger round to cents ($12.34). */
export function formatUsageCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0'
  return '$' + (cost >= 1 ? cost.toFixed(2) : cost.toFixed(4))
}

export interface UsageSegment {
  label: string
  value: number
  color: string
  pct: number
}

/**
 * Token-type breakdown for the stacked composition bar. Percentages are of the
 * summed positive token counts; an all-zero usage yields zero-width segments.
 */
export function tokenBreakdownSegments(u: NonNullable<DashboardLoop['usage']>): UsageSegment[] {
  const raw: Omit<UsageSegment, 'pct'>[] = [
    { label: 'Input', value: u.totalInputTokens, color: '#1f6feb' },
    { label: 'Output', value: u.totalOutputTokens, color: '#3fb950' },
    { label: 'Reasoning', value: u.totalReasoningTokens, color: '#a371f7' },
    { label: 'Cache R', value: u.totalCacheReadTokens, color: '#d29922' },
    { label: 'Cache W', value: u.totalCacheWriteTokens, color: '#db61a2' },
  ]
  const total = raw.reduce((sum, seg) => sum + Math.max(0, seg.value), 0)
  return raw.map(seg => ({
    ...seg,
    pct: total > 0 ? (Math.max(0, seg.value) / total) * 100 : 0,
  }))
}

export interface ModelUsageBar {
  model: string
  cost: number
  inputTokens: number
  outputTokens: number
  messageCount: number
  pct: number
}

/**
 * Per-model bars sorted by cost desc. `pct` is each model's cost relative to the
 * most expensive model so the widest bar always fills the track.
 */
export function modelUsageBars(u: NonNullable<DashboardLoop['usage']>): ModelUsageBar[] {
  const entries = Object.keys(u.byModel).map(model => ({ model, ...u.byModel[model] }))
  const maxCost = entries.reduce((max, e) => Math.max(max, e.cost), 0)
  return entries
    .sort((a, b) => b.cost - a.cost)
    .map(e => ({
      model: e.model,
      cost: e.cost,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      messageCount: e.messageCount,
      pct: maxCost > 0 ? (e.cost / maxCost) * 100 : 0,
    }))
}

/**
 * Section duration label ("14m 58s"). Uses live elapsed time for an in-progress
 * section (started, not yet completed) and empty string for pending sections.
 */
export function formatSectionDuration(
  startedAt: number | null | undefined,
  completedAt: number | null | undefined,
): string {
  if (!startedAt) return ''
  const seconds = computeElapsedSeconds(startedAt, completedAt ?? undefined)
  return seconds > 0 ? formatDuration(seconds) : ''
}

const markdownCache = new Map<string, string>()
const MD_CACHE_MAX = 200

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const cached = markdownCache.get(src)
  if (cached !== undefined) return cached
  const m = (globalThis as { marked?: { parse(s: string): string } }).marked
  if (!m) return ''
  const result = m.parse(src)
  if (result) {
    // Evict oldest entry if at capacity (insertion-order eviction)
    if (markdownCache.size >= MD_CACHE_MAX) {
      const firstKey = markdownCache.keys().next().value
      if (firstKey !== undefined) markdownCache.delete(firstKey)
    }
    markdownCache.set(src, result)
  }
  return result
}

// ---------------------------------------------------------------------------
// Loop metric chart helpers (pure, no DOM)
// ---------------------------------------------------------------------------

export interface IterationUsagePoint {
  iteration: number
  codeInput: number
  codeOutput: number
  auditInput: number
  auditOutput: number
  cost: number
}

/**
 * Aggregates per-iteration token usage from loop events. Events without an
 * iteration or of type `loop_terminated` are skipped; `coding_done` events
 * feed the code buckets, `audit_done`/`final_audit_done` feed the audit
 * buckets, and `cost` accumulates across both. Sorted ascending by iteration.
 */
export function iterationUsagePoints(events: LoopEventRow[]): IterationUsagePoint[] {
  const byIter = new Map<number, IterationUsagePoint>()
  for (const e of events) {
    if (e.iteration === null) continue
    if (
      e.eventType !== 'coding_done' &&
      e.eventType !== 'audit_done' &&
      e.eventType !== 'final_audit_done'
    ) {
      continue
    }
    let p = byIter.get(e.iteration)
    if (!p) {
      p = {
        iteration: e.iteration,
        codeInput: 0,
        codeOutput: 0,
        auditInput: 0,
        auditOutput: 0,
        cost: 0,
      }
      byIter.set(e.iteration, p)
    }
    if (e.eventType === 'coding_done') {
      p.codeInput += e.inputTokens
      p.codeOutput += e.outputTokens
    } else {
      p.auditInput += e.inputTokens
      p.auditOutput += e.outputTokens
    }
    p.cost += e.cost
  }
  return Array.from(byIter.values()).sort((a, b) => a.iteration - b.iteration)
}

export interface SectionRetryCount {
  sectionIndex: number
  title: string | null
  retries: number
}

/**
 * Counts `section_retry` outcomes per section index (from loop events), joined
 * with section titles. Sections with zero retries are included so charts can
 * render consistent rows. Returns sections in their plan order.
 */
export function sectionRetryCounts(
  events: LoopEventRow[],
  sections: SectionPlanRow[],
): SectionRetryCount[] {
  const counts = new Map<number, number>()
  for (const e of events) {
    if (e.outcome === 'section_retry' && e.sectionIndex !== null) {
      counts.set(e.sectionIndex, (counts.get(e.sectionIndex) ?? 0) + 1)
    }
  }
  return sections.map(s => ({
    sectionIndex: s.sectionIndex,
    title: s.title,
    retries: counts.get(s.sectionIndex) ?? 0,
  }))
}

export interface AuditOutcomePoint {
  iteration: number | null
  verdict: 'clean' | 'dirty' | null
  outcome: string | null
}

/**
 * Returns audit/final-audit event rows in id order (the order they arrive in
 * from the events repo), preserving iteration, verdict, and outcome for chart
 * plotting.
 */
export function auditOutcomePoints(events: LoopEventRow[]): AuditOutcomePoint[] {
  const out: AuditOutcomePoint[] = []
  for (const e of events) {
    if (e.eventType !== 'audit_done' && e.eventType !== 'final_audit_done') continue
    out.push({ iteration: e.iteration, verdict: e.verdict, outcome: e.outcome })
  }
  return out
}

export type RunComparisonRow = LoopRunRow & { tokensTotal: number; costPerIteration: number }

/**
 * Derives comparison fields for each run: `tokensTotal = inputTokens +
 * outputTokens`, and `costPerIteration = cost / iterations` (cost unchanged
 * when iterations is 0 to avoid division by zero). Sorted by `startedAt`
 * descending so the most recent run appears first.
 */
export function runComparisonRows(runs: LoopRunRow[]): RunComparisonRow[] {
  return [...runs]
    .map(r => ({
      ...r,
      tokensTotal: r.inputTokens + r.outputTokens,
      costPerIteration: r.iterations > 0 ? r.cost / r.iterations : r.cost,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Returns the maximum of the supplied values with a floor of 1, so chart
 * scale division never divides by zero. Empty input returns 1.
 */
export function chartMax(values: number[]): number {
  return Math.max(1, ...values)
}
