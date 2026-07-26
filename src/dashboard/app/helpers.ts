import type { DashboardPayload, DashboardLoop, LoopTransitionRow } from './types'
import { formatDuration, computeElapsedSeconds } from '../../utils/duration'

export type LoopTab = 'overview' | 'timeline' | 'sections' | 'findings' | 'plan' | 'usage'
export type RepoSection = 'loops' | 'groups' | 'findings' | 'plans'

export interface DashboardRoute {
  projectId: string | null
  section: RepoSection
  loopName: string | null
  tab: LoopTab
  groupId: string | null
  statuses: string[]
  query: string
}

const SECTION_KEYWORDS: ReadonlySet<string> = new Set<RepoSection>(['loops', 'groups', 'findings', 'plans'])
const LOOP_TABS: ReadonlySet<string> = new Set<LoopTab>(['overview', 'timeline', 'sections', 'findings', 'plan', 'usage'])

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function emptyRoute(): DashboardRoute {
  return {
    projectId: null,
    section: 'loops',
    loopName: null,
    tab: 'overview',
    groupId: null,
    statuses: [],
    query: '',
  }
}

function applyQuery(route: DashboardRoute, queryPart: string): void {
  if (!queryPart) return
  for (const pair of queryPart.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = safeDecode(pair.slice(0, eq))
    const val = safeDecode(pair.slice(eq + 1))
    if (key === 'status') {
      route.statuses = val.split(',').map(s => s.trim()).filter(s => s !== '')
    } else if (key === 'q') {
      route.query = val
    }
  }
}

export function parseDashboardHash(hash: string): DashboardRoute {
  const route = emptyRoute()
  const raw = (hash || '').replace(/^#/, '')
  if (!raw) return route

  const qIdx = raw.indexOf('?')
  const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx)
  const queryPart = qIdx === -1 ? '' : raw.slice(qIdx + 1)

  const slash = pathPart.indexOf('/')
  let projectIdEnc: string
  let rest: string
  if (slash === -1) {
    projectIdEnc = pathPart
    rest = ''
  } else {
    projectIdEnc = pathPart.slice(0, slash)
    rest = pathPart.slice(slash + 1)
  }
  if (projectIdEnc) route.projectId = safeDecode(projectIdEnc)
  if (!rest) {
    applyQuery(route, queryPart)
    return route
  }

  const segs = rest.split('/').filter(s => s !== '')
  if (segs.length === 0) {
    applyQuery(route, queryPart)
    return route
  }

  const first = safeDecode(segs[0])
  if (first === 'loop') {
    if (segs.length >= 2) {
      route.loopName = safeDecode(segs[1])
      if (segs.length >= 3) {
        const tab = safeDecode(segs[2])
        if (LOOP_TABS.has(tab)) route.tab = tab as LoopTab
      }
    }
  } else if (SECTION_KEYWORDS.has(first)) {
    route.section = first as RepoSection
    if (first === 'groups' && segs.length >= 2) {
      route.groupId = safeDecode(segs[1])
    }
  } else {
    route.loopName = first
  }

  applyQuery(route, queryPart)
  return route
}

export function buildDashboardHash(route: DashboardRoute): string {
  if (!route.projectId) return ''
  let h = '#' + encodeURIComponent(route.projectId)

  if (route.section === 'loops') {
    if (route.loopName) {
      h += '/loop/' + encodeURIComponent(route.loopName)
      if (route.tab !== 'overview') h += '/' + route.tab
    }
  } else if (route.section === 'groups') {
    h += '/groups'
    if (route.groupId) h += '/' + encodeURIComponent(route.groupId)
  } else {
    h += '/' + route.section
  }

  const params: string[] = []
  if (route.statuses.length > 0) {
    params.push('status=' + route.statuses.map(s => encodeURIComponent(s)).join(','))
  }
  if (route.query) {
    params.push('q=' + encodeURIComponent(route.query))
  }
  if (params.length > 0) h += '?' + params.join('&')

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

export type SortMode = 'recent' | 'cost' | 'duration' | 'findings'

export function loopMatchesFilters(
  loop: DashboardLoop['loop'],
  statuses: Set<string>,
  searchText: string,
  repoLabel: string,
): boolean {
  const statusOk = statuses.size === 0 || statuses.has(loop.status)
  if (!statusOk) return false
  if (!searchText) return true
  const q = searchText.toLowerCase()
  const branch = loop.worktreeBranch ?? ''
  const hay = (
    (loop.loopName || '') + ' ' + branch + ' ' + (repoLabel || '')
  ).toLowerCase()
  return hay.indexOf(q) !== -1
}

function parseDurationSeconds(s: string): number {
  if (!s) return 0
  let total = 0
  const h = s.match(/(\d+)\s*h/i)
  if (h) total += parseInt(h[1], 10) * 3600
  const m = s.match(/(\d+)\s*m(?!s)/i)
  if (m) total += parseInt(m[1], 10) * 60
  const sec = s.match(/(\d+)\s*s/i)
  if (sec) total += parseInt(sec[1], 10)
  return total
}

export function sortLoops(loops: DashboardLoop[], mode: SortMode): DashboardLoop[] {
  if (mode === 'recent') return [...loops]
  const sorted = [...loops]
  if (mode === 'cost') {
    sorted.sort((a, b) => {
      const ac = a.usage?.totalCost ?? null
      const bc = b.usage?.totalCost ?? null
      if (ac === null && bc === null) return 0
      if (ac === null) return 1
      if (bc === null) return -1
      return bc - ac
    })
  } else if (mode === 'duration') {
    sorted.sort((a, b) => {
      const ad = a.duration ? parseDurationSeconds(a.duration) : 0
      const bd = b.duration ? parseDurationSeconds(b.duration) : 0
      return bd - ad
    })
  } else if (mode === 'findings') {
    sorted.sort((a, b) => b.findings.length - a.findings.length)
  }
  return sorted
}

export function dataHash(data: DashboardPayload): string {
  return JSON.stringify(data, (_k: string, v: unknown) => {
    if (_k === 'generatedAt') return undefined
    return v
  })
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

interface UsageSegment {
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
    { label: 'Input', value: u.totalInputTokens, color: 'var(--seg-input)' },
    { label: 'Output', value: u.totalOutputTokens, color: 'var(--seg-output)' },
    { label: 'Reasoning', value: u.totalReasoningTokens, color: 'var(--seg-reasoning)' },
    { label: 'Cache R', value: u.totalCacheReadTokens, color: 'var(--seg-cache-read)' },
    { label: 'Cache W', value: u.totalCacheWriteTokens, color: 'var(--seg-cache-write)' },
  ]
  const total = raw.reduce((sum, seg) => sum + Math.max(0, seg.value), 0)
  return raw.map(seg => ({
    ...seg,
    pct: total > 0 ? (Math.max(0, seg.value) / total) * 100 : 0,
  }))
}

interface ModelUsageBar {
  model: string
  cost: number
  inputTokens: number
  outputTokens: number
  messageCount: number
  pct: number
}

interface RoleUsageBar {
  role: 'execution' | 'auditor'
  cost: number
  messageCount: number
  pct: number
}

export function roleUsageBars(u: NonNullable<DashboardLoop['usage']>): RoleUsageBar[] {
  const exec: RoleUsageBar = { role: 'execution', cost: 0, messageCount: 0, pct: 0 }
  const audit: RoleUsageBar = { role: 'auditor', cost: 0, messageCount: 0, pct: 0 }
  for (const [role, agg] of Object.entries(u.byRole ?? {})) {
    if (role === 'auditor') {
      audit.cost += agg.cost
      audit.messageCount += agg.messageCount
    } else if (role === 'code') {
      exec.cost += agg.cost
      exec.messageCount += agg.messageCount
    }
  }
  const max = Math.max(exec.cost, audit.cost)
  exec.pct = max > 0 ? (exec.cost / max) * 100 : 0
  audit.pct = max > 0 ? (audit.cost / max) * 100 : 0
  return [exec, audit]
}

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

/** Relative-time label like "2m ago", "3h ago", "2d ago", "Jan 14-2026 3:45 PM". */
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

const markdownCache = new Map<string, string>()
const MD_CACHE_MAX = 200

export function tabsForLoop(loop: DashboardLoop): LoopTab[] {
  const tabs: LoopTab[] = ['overview', 'timeline']
  if (loop.sections.length > 0) tabs.push('sections')
  tabs.push('findings')
  if (loop.plan) tabs.push('plan')
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

export function computePhaseSpans(
  transitions: LoopTransitionRow[],
  startedAt: number,
  completedAt: number | null,
  now: number,
  initialPhase: string = 'coding',
): { spans: PhaseSpan[]; truncated: boolean } {
  const spans: PhaseSpan[] = []
  const firstCurrentIdx = transitions.findIndex(t => t.createdAt >= startedAt)
  let currentTransitions = firstCurrentIdx === -1 ? [] : transitions.slice(firstCurrentIdx)
  if (completedAt !== null) {
    currentTransitions = currentTransitions.filter(t => t.createdAt <= completedAt)
  }

  let currentPhase: string
  if (currentTransitions.length > 0 && currentTransitions[0].eventType === 'restart' && currentTransitions[0].toPhase !== null) {
    currentPhase = currentTransitions[0].toPhase
  } else if (currentTransitions.length > 0 && currentTransitions[0].eventType !== 'restart') {
    currentPhase = currentTransitions[0].fromPhase
  } else {
    currentPhase = initialPhase
  }
  let currentStart = startedAt

  for (const t of currentTransitions) {
    if (t.eventType === 'restart') {
      if (t.toPhase !== null) currentPhase = t.toPhase
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
    if (t.toPhase === null) {
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

  const truncated = transitions.length > 0
    && transitions[0].createdAt >= startedAt
    && transitions[0].createdAt > startedAt + 1000
  if (truncated && spans.length > 0) {
    spans[0] = { ...spans[0], phase: '' }
  }
  return { spans, truncated }
}

export function summarizePhaseTotals(spans: PhaseSpan[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of spans) {
    if (!s.phase) continue
    out[s.phase] = (out[s.phase] ?? 0) + s.durationMs
  }
  return out
}

interface TimelineEvent {
  transition: LoopTransitionRow
  elapsedMs: number | null
}

export function computeTimelineEvents(
  transitions: LoopTransitionRow[],
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
      if (prev.eventType === 'restart' && prev.toPhase !== null && prev.toPhase === t.fromPhase) {
        if (prev.createdAt >= startedAt) {
          elapsedMs = Math.max(0, t.createdAt - startedAt)
        } else if (t.createdAt < startedAt) {
          elapsedMs = Math.max(0, t.createdAt - prev.createdAt)
        } else {
          elapsedMs = null
        }
      } else if (prev.toPhase !== null && prev.toPhase === t.fromPhase) {
        elapsedMs = Math.max(0, t.createdAt - prev.createdAt)
      } else if (
        t.eventType !== 'restart'
        && prev.toPhase === null
        && t.fromPhase !== null
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
