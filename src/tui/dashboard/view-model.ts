import type {
  ForgeDashboardLoopSummary,
  ForgeDashboardProjectSummary,
  ForgeDashboardSummary,
  ForgeLoopTransition,
  ForgeLoopUsage,
  ForgePlanAmendment,
  ForgeReviewFinding,
} from '../../host/forge-rpc'
import { computeElapsedSeconds, formatDuration } from '../../utils/duration'
import { phaseLabel } from '../../utils/phase-label'
import type { JsonObject, JsonValue } from '../../utils/json-schema'

export type LoopTab = 'overview' | 'timeline' | 'sections' | 'findings' | 'plan' | 'usage'

export const MAX_RENDERED_LOOP_ROWS = 200
export const MAX_RENDERED_FINDING_ROWS = 300

export interface CappedList<T> {
  rows: T[]
  total: number
  capped: boolean
}

export function capList<T>(items: T[], max: number, showAll: boolean): CappedList<T> {
  if (showAll || items.length <= max) return { rows: items, total: items.length, capped: false }
  return { rows: items.slice(0, max), total: items.length, capped: true }
}

function isArrayValue<T>(value: T): value is T & unknown[] {
  return Array.isArray(value)
}

function isObjectValue<T>(value: T): value is T & JsonObject {
  if (!(value instanceof Object)) return false
  if (Array.isArray(value)) return false
  return !(value instanceof Function)
}

export function shareUnchanged<T>(previous: T | null | undefined, next: T): T {
  return shareValue(previous, next)
}

function shareValue<T>(previous: T | null | undefined, next: T): T {
  if (previous !== null && previous !== undefined && Object.is(previous, next)) return previous
  if (isArrayValue(next)) return shareArray(previous, next)
  if (isObjectValue(next)) return shareRecord(previous, next)
  return next
}

function shareArray<T>(previous: T | null | undefined, next: T & unknown[]): T {
  if (!Array.isArray(previous)) return next
  const previousArray: unknown[] = previous
  const shared = Object.assign([], next)
  let unchanged = previousArray.length === next.length
  for (let index = 0; index < next.length; index++) {
    const child = shareValue(previousArray[index], next[index])
    if (!Object.is(child, previousArray[index])) unchanged = false
    Object.assign(shared, { [index]: child })
  }
  return unchanged ? previous : shared
}

function shareRecord<T>(previous: T | null | undefined, next: T & JsonObject): T {
  if (!isObjectValue(previous)) return next
  const keys = Object.keys(next)
  const shared = { ...next }
  let unchanged = keys.length === Object.keys(previous).length
  for (const key of keys) {
    const known = Object.hasOwn(previous, key)
    const child: JsonValue = shareValue(known ? previous[key] : undefined, next[key])
    if (!known || !Object.is(child, previous[key])) unchanged = false
    Object.assign(shared, { [key]: child })
  }
  return unchanged ? previous : shared
}

export function repoRawPath(proj: ForgeDashboardProjectSummary): string {
  return proj.projectDir || proj.projectId
}

export function repoLabel(labels: Map<string, string>, proj: ForgeDashboardProjectSummary): string {
  const rawPath = repoRawPath(proj)
  return labels.get(rawPath) ?? rawPath
}

export function buildRepoLabels(paths: string[]): Map<string, string> {
  const segsByPath = new Map<string, string[]>()
  for (const p of paths) {
    if (p === '') {
      segsByPath.set(p, [])
      continue
    }
    const segs = p.split('/')
    let end = segs.length
    while (end > 0 && segs[end - 1] === '') end--
    segsByPath.set(p, end > 0 ? segs.slice(0, end) : [p])
  }

  const result = new Map<string, string>()
  for (const p of paths) {
    const segs = segsByPath.get(p)!
    result.set(p, segs.length ? segs[segs.length - 1] : p)
  }

  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const label = result.get(p)!
    const bucket = groups.get(label)
    if (bucket) bucket.push(p)
    else groups.set(label, [p])
  }

  for (const [, group] of groups) {
    const unique = [...new Set(group)]
    if (unique.length < 2) continue

    let depth = 1
    while (depth < 1024) {
      const seen = new Set<string>()
      let allDistinct = true
      let allExhausted = true
      for (const p of unique) {
        const segs = segsByPath.get(p)!
        const start = Math.max(0, segs.length - depth)
        const label = segs.slice(start).join('/')
        if (seen.has(label)) allDistinct = false
        else seen.add(label)
        if (start > 0) allExhausted = false
      }
      if (allDistinct || allExhausted) break
      depth++
    }

    for (const p of unique) {
      const segs = segsByPath.get(p)!
      const start = Math.max(0, segs.length - depth)
      result.set(p, segs.slice(start).join('/'))
    }
  }

  return result
}

export const SORT_MODES = ['recent', 'cost', 'duration', 'findings'] as const

export type SortMode = (typeof SORT_MODES)[number]

export function nextSortMode(current: SortMode): SortMode {
  const index = SORT_MODES.indexOf(current)
  return SORT_MODES[(index + 1) % SORT_MODES.length]
}

export function sortLoops(loops: ForgeDashboardLoopSummary[], mode: SortMode): ForgeDashboardLoopSummary[] {
  if (mode === 'recent') return [...loops]
  const sorted = [...loops]
  if (mode === 'cost') {
    sorted.sort((a, b) => {
      const ac = a.totalCost ?? null
      const bc = b.totalCost ?? null
      if (ac === null && bc === null) return 0
      if (ac === null) return 1
      if (bc === null) return -1
      return bc - ac
    })
  } else if (mode === 'duration') {
    sorted.sort((a, b) => {
      const ad = computeElapsedSeconds(a.startedAt, a.completedAt)
      const bd = computeElapsedSeconds(b.startedAt, b.completedAt)
      return bd - ad
    })
  } else {
    sorted.sort((a, b) => b.bugCount - a.bugCount)
  }
  return sorted
}

export const LOOP_STATUS_FILTERS = ['all', 'running', 'completed', 'cancelled', 'errored', 'stalled'] as const

export type LoopStatusFilter = (typeof LOOP_STATUS_FILTERS)[number]

export function nextStatusFilter(current: LoopStatusFilter): LoopStatusFilter {
  const index = LOOP_STATUS_FILTERS.indexOf(current)
  return LOOP_STATUS_FILTERS[(index + 1) % LOOP_STATUS_FILTERS.length]
}

export function filterLoopsByStatus(
  loops: ForgeDashboardLoopSummary[],
  filter: LoopStatusFilter,
): ForgeDashboardLoopSummary[] {
  if (filter === 'all') return loops
  return loops.filter((loop) => loop.status === filter)
}

export interface LoopStatusCounts {
  all: number
  running: number
  completed: number
  cancelled: number
  errored: number
  stalled: number
}

export function statusCounts(loops: ForgeDashboardLoopSummary[]): LoopStatusCounts {
  const counts: LoopStatusCounts = {
    all: loops.length,
    running: 0,
    completed: 0,
    cancelled: 0,
    errored: 0,
    stalled: 0,
  }
  for (const loop of loops) counts[loop.status] += 1
  return counts
}

function matchesQuery(value: string | undefined, needle: string): boolean {
  return value !== undefined && value.toLowerCase().includes(needle)
}

function filterRows<T>(rows: T[], keep: (row: T) => boolean): T[] {
  const kept: T[] = []
  for (const row of rows) if (keep(row)) kept.push(row)
  return kept.length === rows.length ? rows : kept
}

export function filterDashboardProjects(summary: ForgeDashboardSummary, query: string): ForgeDashboardSummary {
  if (query === '') return summary
  const needle = query.toLowerCase()
  const labels = buildRepoLabels(summary.projects.map(repoRawPath))
  const projects: ForgeDashboardProjectSummary[] = []
  let changed = false
  for (const project of summary.projects) {
    const label = repoLabel(labels, project)
    const projectMatches = matchesQuery(project.projectDir, needle) || matchesQuery(label, needle)
    const loops = filterRows(
      project.loops,
      (loop) => projectMatches || matchesQuery(loop.loopName, needle) || matchesQuery(loop.branch, needle),
    )
    const unexecutedPlans = filterRows(
      project.unexecutedPlans,
      (plan) => projectMatches || matchesQuery(plan.title, needle),
    )
    if (!projectMatches && loops.length === 0 && unexecutedPlans.length === 0) {
      changed = true
      continue
    }
    if (loops === project.loops && unexecutedPlans === project.unexecutedPlans) {
      projects.push(project)
      continue
    }
    changed = true
    projects.push({ ...project, loops, unexecutedPlans })
  }
  return changed ? { ...summary, projects } : summary
}

export function textBar(fraction: number, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return ''
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.min(width, Math.max(0, Math.round(clamped * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export interface SplitFindings {
  bugs: ForgeReviewFinding[]
  warnings: ForgeReviewFinding[]
}

export function splitFindings(findings: ForgeReviewFinding[]): SplitFindings {
  const bugs: ForgeReviewFinding[] = []
  const warnings: ForgeReviewFinding[] = []
  for (const finding of findings) {
    if (finding.severity === 'bug') bugs.push(finding)
    else warnings.push(finding)
  }
  return { bugs, warnings }
}

export function findingsLevel(split: SplitFindings): 'bug' | 'warn' | 'clean' {
  if (split.bugs.length > 0) return 'bug'
  if (split.warnings.length > 0) return 'warn'
  return 'clean'
}

export function formatCount(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's')
}

export function formatSectionNumber(index: number): string {
  return String(index + 1)
}

export interface SectionProgress {
  current: number
  total: number
}

export function sectionProgress(index: number, total: number): SectionProgress {
  if (total <= 0) return { current: 0, total: 0 }
  return { current: Math.max(0, Math.min(index + 1, total)), total }
}

export function formatFinding(f: ForgeReviewFinding): string {
  let text = f.file + ':' + f.line + ' — ' + f.description
  if (f.scenario) {
    text += ' (' + f.scenario + ')'
  }
  return text
}

export interface FindingSectionGroup {
  key: number | null
  label: string
  rows: ForgeReviewFinding[]
}

export function groupFindingsBySection(findings: ForgeReviewFinding[]): FindingSectionGroup[] {
  const order: (number | null)[] = []
  const map = new Map<number | null, ForgeReviewFinding[]>()
  for (const f of findings) {
    const k = f.sectionIndex ?? null
    if (!map.has(k)) {
      map.set(k, [])
      order.push(k)
    }
    map.get(k)!.push(f)
  }
  order.sort((a, b) => {
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return a - b
  })
  return order.map((k) => ({
    key: k,
    label: k === null ? 'cross-section' : 'sect ' + formatSectionNumber(k),
    rows: map.get(k)!,
  }))
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

export function formatUsageCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0'
  return '$' + (cost >= 1 ? cost.toFixed(2) : cost.toFixed(4))
}

export interface UsageSegment {
  label: string
  value: number
  pct: number
}

export function tokenBreakdownSegments(u: ForgeLoopUsage): UsageSegment[] {
  const raw: Omit<UsageSegment, 'pct'>[] = [
    { label: 'Input', value: u.totalInputTokens },
    { label: 'Output', value: u.totalOutputTokens },
    { label: 'Reasoning', value: u.totalReasoningTokens },
    { label: 'Cache R', value: u.totalCacheReadTokens },
    { label: 'Cache W', value: u.totalCacheWriteTokens },
  ]
  const total = raw.reduce((sum, seg) => sum + Math.max(0, seg.value), 0)
  return raw.map((seg) => ({
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

export interface RoleUsageBar {
  role: 'execution' | 'auditor' | 'other'
  cost: number
  messageCount: number
  tokens: number
  pct: number
}

type UsageRole = keyof ForgeLoopUsage['byRole']

const USAGE_ROLE_ORDER: readonly UsageRole[] = ['code', 'auditor', 'unknown']

const ROLE_BAR_LABELS = {
  code: 'execution',
  auditor: 'auditor',
  unknown: 'other',
} satisfies Record<UsageRole, RoleUsageBar['role']>

export function roleUsageBars(u: ForgeLoopUsage): RoleUsageBar[] {
  const all = USAGE_ROLE_ORDER.map((role) => {
    const bar: RoleUsageBar = { role: ROLE_BAR_LABELS[role], cost: 0, messageCount: 0, tokens: 0, pct: 0 }
    const agg = u.byRole[role]
    if (!agg) return bar
    bar.cost = agg.cost
    bar.messageCount = agg.messageCount
    bar.tokens = agg.inputTokens + agg.outputTokens + agg.reasoningTokens
    return bar
  })
  const bars = all.filter((b) => b.role !== 'other' || b.cost > 0 || b.messageCount > 0)
  const max = bars.reduce((m, b) => Math.max(m, b.cost), 0)
  for (const bar of bars) bar.pct = max > 0 ? (bar.cost / max) * 100 : 0
  return bars
}

export function modelUsageBars(u: ForgeLoopUsage): ModelUsageBar[] {
  const entries = Object.keys(u.byModel).map((model) => ({ model, ...u.byModel[model] }))
  const maxCost = entries.reduce((max, e) => Math.max(max, e.cost), 0)
  return entries
    .sort((a, b) => b.cost - a.cost)
    .map((e) => ({
      model: e.model,
      cost: e.cost,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      messageCount: e.messageCount,
      pct: maxCost > 0 ? (e.cost / maxCost) * 100 : 0,
    }))
}

export function formatSectionDuration(
  startedAt: number | null | undefined,
  completedAt: number | null | undefined,
): string {
  if (!startedAt) return ''
  const seconds = computeElapsedSeconds(startedAt, completedAt ?? undefined)
  return seconds > 0 ? formatDuration(seconds) : ''
}

export function formatSpanDuration(ms: number): string {
  return ms >= 1000 ? formatDuration(Math.floor(ms / 1000)) : ms + 'ms'
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

export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts || ts === 0) return ''
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return seconds + 's ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm ago'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h ago'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + 'd ago'
  return fmtTime(ts)
}

export function tabsForLoop(loop: Pick<ForgeDashboardLoopSummary, 'sectionCount' | 'hasPlan'>): LoopTab[] {
  const tabs: LoopTab[] = ['overview']
  tabs.push('timeline')
  if (loop.sectionCount > 0) tabs.push('sections')
  tabs.push('findings')
  if (loop.hasPlan) tabs.push('plan')
  tabs.push('usage')
  return tabs
}

export interface PhaseSpan {
  phase: string
  startedAt: number
  endedAt: number | null
  durationMs: number
  open: boolean
}

export interface PhaseSpans {
  spans: PhaseSpan[]
  truncated: boolean
}

export function computePhaseSpans(
  transitions: ForgeLoopTransition[],
  startedAt: number,
  completedAt: number | null,
  now: number,
  initialPhase: string = 'coding',
  windowCapped: boolean = false,
): PhaseSpans {
  const spans: PhaseSpan[] = []
  const firstCurrentIdx = transitions.findIndex((t) => t.createdAt >= startedAt)
  let currentTransitions = firstCurrentIdx === -1 ? [] : transitions.slice(firstCurrentIdx)
  if (completedAt !== null) {
    currentTransitions = currentTransitions.filter((t) => t.createdAt <= completedAt)
  }

  let currentPhase: string
  if (
    currentTransitions.length > 0
    && currentTransitions[0].eventType === 'restart'
    && currentTransitions[0].toPhase != null
  ) {
    currentPhase = currentTransitions[0].toPhase
  } else if (currentTransitions.length > 0 && currentTransitions[0].eventType !== 'restart') {
    currentPhase = currentTransitions[0].fromPhase
  } else {
    currentPhase = initialPhase
  }
  let currentStart = startedAt

  for (const t of currentTransitions) {
    if (t.eventType === 'restart') {
      if (t.toPhase != null) currentPhase = t.toPhase
      continue
    }
    if (currentPhase === '') {
      currentPhase = t.fromPhase
      currentStart = Math.max(currentStart, t.createdAt)
    }
    const end = t.createdAt
    const spanEnd = Math.max(currentStart, end)
    spans.push({
      phase: currentPhase,
      startedAt: currentStart,
      endedAt: spanEnd,
      durationMs: spanEnd - currentStart,
      open: false,
    })
    if (t.toPhase == null) {
      currentPhase = ''
      currentStart = spanEnd
    } else {
      currentPhase = t.toPhase
      currentStart = spanEnd
    }
  }

  if (currentPhase !== '') {
    const end = completedAt ?? now
    const spanEnd = Math.max(currentStart, end)
    spans.push({
      phase: currentPhase,
      startedAt: currentStart,
      endedAt: completedAt,
      durationMs: spanEnd - currentStart,
      open: completedAt === null,
    })
  }

  const truncated = windowCapped
    && transitions.length > 0
    && transitions[0].createdAt > startedAt + 1000
  if (truncated && spans.length > 0) {
    spans[0] = { ...spans[0], phase: '' }
  }
  return { spans, truncated }
}

export interface PhaseTotals {
  [phase: string]: number
}

export function summarizePhaseTotals(spans: PhaseSpan[]): PhaseTotals {
  const out: PhaseTotals = {}
  for (const s of spans) {
    if (!s.phase) continue
    out[s.phase] = (out[s.phase] ?? 0) + s.durationMs
  }
  return out
}

export interface PhaseLegendRow {
  phase: string
  label: string
  durationMs: number
  pct: number
}

export function phaseLegendRows(spans: PhaseSpan[]): PhaseLegendRow[] {
  const totals = summarizePhaseTotals(spans)
  const rows: PhaseLegendRow[] = Object.keys(totals).map((phase) => ({
    phase,
    label: phaseLabel(phase),
    durationMs: totals[phase],
    pct: 0,
  }))
  const totalMs = rows.reduce((sum, r) => sum + r.durationMs, 0)
  for (const r of rows) r.pct = totalMs > 0 ? Math.round((r.durationMs / totalMs) * 100) : 0
  return rows.sort((a, b) => b.durationMs - a.durationMs)
}

export interface TimelineEvent {
  transition: ForgeLoopTransition
  elapsedMs: number | null
}

export function computeTimelineEvents(
  transitions: ForgeLoopTransition[],
  startedAt: number,
  truncated: boolean,
): TimelineEvent[] {
  const out: TimelineEvent[] = []
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i]
    let elapsedMs: number | null
    if (i === 0) {
      if (t.eventType === 'restart' || truncated || t.createdAt < startedAt) {
        elapsedMs = null
      } else {
        elapsedMs = Math.max(0, t.createdAt - startedAt)
      }
    } else {
      const prev = transitions[i - 1]
      if (prev.eventType === 'restart' && prev.toPhase != null && prev.toPhase === t.fromPhase) {
        if (prev.createdAt >= startedAt) {
          elapsedMs = Math.max(0, t.createdAt - startedAt)
        } else if (t.createdAt < startedAt) {
          elapsedMs = Math.max(0, t.createdAt - prev.createdAt)
        } else {
          elapsedMs = null
        }
      } else if (prev.toPhase != null && prev.toPhase === t.fromPhase) {
        elapsedMs = Math.max(0, t.createdAt - prev.createdAt)
      } else if (
        t.eventType !== 'restart'
        && prev.toPhase == null
        && t.fromPhase != null
        && t.fromPhase === prev.fromPhase
        && prev.createdAt < startedAt
        && t.createdAt >= startedAt
      ) {
        elapsedMs = Math.max(0, t.createdAt - startedAt)
      } else {
        elapsedMs = null
      }
    }
    out.push({ transition: t, elapsedMs })
  }
  out.reverse()
  return out
}

export interface AmendmentSummary {
  count: number
  lastAt: number | null
  lastSection: number | null
}

export function summarizeAmendments(amendments: ForgePlanAmendment[]): AmendmentSummary {
  if (amendments.length === 0) return { count: 0, lastAt: null, lastSection: null }
  let newest = amendments[0]
  for (const a of amendments) {
    if (a.createdAt > newest.createdAt || (a.createdAt === newest.createdAt && a.id > newest.id)) {
      newest = a
    }
  }
  return {
    count: amendments.length,
    lastAt: newest.createdAt,
    lastSection: newest.appliedAtSection,
  }
}

export function amendedSectionIndexes(amendments: ForgePlanAmendment[]): Set<number> {
  const out = new Set<number>()
  for (const a of amendments) out.add(a.appliedAtSection)
  return out
}

export type TimelineEntry =
  | { kind: 'transition'; transition: ForgeLoopTransition; elapsedMs: number | null }
  | { kind: 'amendment'; amendment: ForgePlanAmendment; elapsedMs: null }

export function mergeTimelineEntries(
  transitions: ForgeLoopTransition[],
  amendments: ForgePlanAmendment[],
  startedAt: number,
  truncated: boolean,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...computeTimelineEvents(transitions, startedAt, truncated).map((e) => ({
      kind: 'transition' as const,
      transition: e.transition,
      elapsedMs: e.elapsedMs,
    })),
    ...amendments.map((a) => ({ kind: 'amendment' as const, amendment: a, elapsedMs: null })),
  ]
  entries.sort((a, b) => {
    const ta = a.kind === 'transition' ? a.transition.createdAt : a.amendment.createdAt
    const tb = b.kind === 'transition' ? b.transition.createdAt : b.amendment.createdAt
    if (tb !== ta) return tb - ta
    if (a.kind !== b.kind) return a.kind === 'transition' ? -1 : 1
    const idA = a.kind === 'transition' ? a.transition.id : a.amendment.id
    const idB = b.kind === 'transition' ? b.transition.id : b.amendment.id
    return idB - idA
  })
  return entries
}

export interface TransitionHistoryRow {
  eventType: string
  flow: string
  time: string
}

export function recentTransitionRows(
  transitions: readonly ForgeLoopTransition[],
  limit = 20,
): TransitionHistoryRow[] {
  if (limit <= 0) return []
  return transitions
    .slice(-limit)
    .reverse()
    .map((t) => ({
      eventType: t.eventType,
      flow: t.fromPhase + ' → ' + (t.toPhase ?? t.status ?? ''),
      time: formatRelativeTime(t.createdAt),
    }))
}
