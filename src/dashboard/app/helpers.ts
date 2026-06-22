import type { DashboardPayload, DashboardProject, DashboardLoop } from './types'

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

export function buildLoopHash(projectId: string | null, loopName: string | null): string {
  if (!projectId) return ''
  let h = '#' + encodeURIComponent(projectId)
  if (loopName) h += '/' + encodeURIComponent(loopName)
  return h
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
  loop: DashboardLoop['loop'],
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

export function formatFinding(f: DashboardLoop['findings'][number]): string {
  let text = f.file + ':' + f.line + ' — ' + f.description
  if (f.scenario) {
    text += ' (' + f.scenario + ')'
  }
  return text
}

export function formatUsageTotal(u: NonNullable<DashboardLoop['usage']>): string {
  return (
    'Total cost: $' +
    u.totalCost.toFixed(6) +
    ', tokens: ' +
    u.totalInputTokens +
    ' in / ' +
    u.totalOutputTokens +
    ' out (reasoning: ' +
    u.totalReasoningTokens +
    ', cache R: ' +
    u.totalCacheReadTokens +
    ' W: ' +
    u.totalCacheWriteTokens +
    '), messages: ' +
    u.totalMessageCount
  )
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

export function formatLoopSummaryParts(dashLoop: DashboardLoop): string[] {
  const lp = dashLoop.loop
  const parts: string[] = [
    fmtTime(lp.startedAt),
    'phase: ' + lp.phase,
    'iteration ' + lp.iteration + '/' + lp.maxIterations,
    'section ' + lp.currentSectionIndex + '/' + lp.totalSections,
  ]
  if (dashLoop.duration) parts.push(dashLoop.duration)
  return parts
}

const markdownCache = new Map<string, string>()

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const cached = markdownCache.get(src)
  if (cached !== undefined) return cached
  const m = (globalThis as { marked?: { parse(s: string): string } }).marked
  if (!m) return ''
  const result = m.parse(src)
  if (result) {
    markdownCache.set(src, result)
  }
  return result
}
