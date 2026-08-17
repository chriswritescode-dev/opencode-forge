import html from 'solid-js/html'
import { createMemo, createSignal, createEffect, getOwner, runWithOwner, onCleanup, untrack } from 'solid-js'
import type { DashboardLoop, DashboardProject, DashboardGroup } from './types'
import type { AmendmentDiff, AmendmentDiffLine } from '../amendment-diff'
import type { GroupFeatureRow } from '../../storage'
import type { RepoSection, SortMode } from './helpers'
import type { MarkdownHeading } from './helpers'
import {
  statusClass,
  sectionStatusClass,
  featureStageClass,
  fmtTime,
  formatSectionDuration,
  formatSpanDuration,
  splitFindings,
  findingsLevel,
  formatFindingCount,
  formatSectionNumber,
  clampPercent,
  formatFinding,
  formatModelUsage,
  formatTokenCount,
  formatUsageCost,
  tokenBreakdownSegments,
  modelUsageBars,
  roleUsageBars,
  renderMarkdown,
  renderMarkdownWithOutline,
  formatRelativeTime,
  tabsForLoop,
  computePhaseSpans,
  phaseLabel,
  phaseLegendRows,
  summarizeAmendments,
  amendedSectionIndexes,
  mergeTimelineEntries,
  buildDashboardHash,
  capList,
  repoRawPath,
  repoLabel,
  loopActivityAt,
  ALL_TABS,
  MAX_RENDERED_LOOP_ROWS,
  MAX_RENDERED_FINDING_ROWS,
  MAX_RENDERED_PICKER_OPTIONS,
  snapshotToLiveMessages,
  applyLiveEvent,
  liveStatusFromEvent,
} from './helpers'
import type { LoopTab, PhaseSpan, LiveMessage, LivePart } from './helpers'
import { formatDuration } from '../../utils/duration'
import { LoopMachineGraph } from './machine-graph'

type DashboardSection = NonNullable<DashboardLoop['sections']>[number]

// NOTE: solid-js/html does not support the `<${Show}>` / `<${For}>` component
// syntax reliably (it mis-parses the closing tag — see solidjs/solid#2033).
// Control flow here therefore uses ternary thunks + createMemo + `.map()`, as
// recommended by the Solid maintainers. Boolean createMemos gate show/hide so a
// content change does not tear down the surrounding wrapper, which is what
// preserves markdown scroll position and the resizable-block height.

// ── Shared types ──────────────────────────────────────────────────────────

export interface MatchedEntry {
  proj: DashboardProject
  loops: DashboardLoop[]
}

type RepoCounts = { running: number; completed: number; cancelled: number; errored: number; stalled: number }

export function FilterBar(props: {
  counts: () => RepoCounts
  statuses: () => Set<string>
  query: () => string
  sortMode: () => SortMode
  onToggleStatus: (key: string) => void
  onChangeQuery: (q: string) => void
  onChangeSort: (m: SortMode) => void
  externalNav: () => number
}) {
  const [local, setLocal] = createSignal(props.query())
  let timer: ReturnType<typeof setTimeout> | null = null
  const onInput = (e: Event) => {
    const v = (e.target as HTMLInputElement).value
    setLocal(v)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      props.onChangeQuery(v)
    }, 250)
  }
  onCleanup(() => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })
  createEffect(() => {
    props.externalNav()
    const q = untrack(() => props.query())
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    setLocal(q)
  })
  const chips = createMemo(() => {
    const c = props.counts()
    return [
      { label: 'Running', key: 'running', value: c.running },
      { label: 'Completed', key: 'completed', value: c.completed },
      { label: 'Cancelled', key: 'cancelled', value: c.cancelled },
      { label: 'Errored', key: 'errored', value: c.errored },
      { label: 'Stalled', key: 'stalled', value: c.stalled },
    ]
  })
  return html`<div class="filter-bar">
    ${() => chips().map(({ label, key, value }) => {
      const active = props.statuses().has(key)
      const cls = `badge badge-filter${active ? ' badge-active' : ''}`
      return html`<span class="${cls}" onclick=${() => props.onToggleStatus(key)}>${label}: ${value}</span>`
    })}
    <input
      id="loop-search"
      class="search-input"
      type="text"
      placeholder="Filter by loop name, branch, or repo…"
      autocomplete="off"
      value=${local}
      oninput=${onInput}
    />
    <select class="sort-select" value=${() => props.sortMode()} onchange=${(e: Event) => props.onChangeSort((e.target as HTMLSelectElement).value as SortMode)}>
      <option value="recent">Recent</option>
      <option value="cost">Cost</option>
      <option value="duration">Duration</option>
      <option value="findings">Findings</option>
    </select>
  </div>`
}

// ── Timestamp ─────────────────────────────────────────────────────────────

function Timestamp(props: { generatedAt: () => number }) {
  return html`<div class="timestamp">${() => {
    const t = props.generatedAt()
    return t > 0 ? `Last updated: ${new Date(t).toLocaleString()}` : ''
  }}</div>`
}

export function AppBar(props: { generatedAt: () => number; breadcrumb: () => Node | string }) {
  return html`<div class="app-bar">
    <h1><a class="forge-home" href="#">Forge Dashboard</a></h1>
    <div class="app-bar-nav">${() => props.breadcrumb()}</div>
    ${Timestamp({ generatedAt: props.generatedAt })}
  </div>`
}

export function RepoMenu(props: {
  entries: () => MatchedEntry[]
  labels: () => Map<string, string>
  onSelect: (projectId: string) => void
}) {
  const items = createMemo(() =>
    props.entries().map((entry: MatchedEntry) => {
      const hasRunning = entry.loops.some(dl => dl.loop.status === 'running')
      const rawPath = repoRawPath(entry.proj)
      const label = repoLabel(props.labels(), entry.proj)
      return html`<div class="repo-menu-item" onclick=${() => props.onSelect(entry.proj.projectId)}>
        ${hasRunning ? html`<span class="repo-menu-running"></span>` : ''}
        <span class="repo-menu-name" title=${rawPath}>${label}</span>
        <span class="repo-menu-count">${entry.loops.length}</span>
      </div>`
    }),
  )
  return html`<div class="repo-menu">${() => items()}</div>`
}

type RunningCard = { projectId: string; label: string; loopName: string; phase: string }
type RecentRow = { projectId: string; label: string; loopName: string; status: string; when: number }

function deriveRepoIndex(entries: MatchedEntry[], labels: Map<string, string>): {
  runningCount: number
  loopCount: number
  bugCount: number
  runningCards: RunningCard[]
  recentRows: RecentRow[]
} {
  let runningCount = 0
  let loopCount = 0
  let bugCount = 0
  const runningCards: RunningCard[] = []
  const recent: RecentRow[] = []
  for (const entry of entries) {
    const label = repoLabel(labels, entry.proj)
    for (const dl of entry.loops) {
      loopCount++
      bugCount += dl.bugCount
      const status = dl.loop.status
      const when = loopActivityAt(dl.loop)
      if (status === 'running') {
        runningCount++
        runningCards.push({ projectId: entry.proj.projectId, label, loopName: dl.loop.loopName, phase: dl.loop.phase || '' })
      }
      recent.push({ projectId: entry.proj.projectId, label, loopName: dl.loop.loopName, status, when })
    }
  }
  recent.sort((a, b) => b.when - a.when)
  return { runningCount, loopCount, bugCount, runningCards, recentRows: recent.slice(0, 8) }
}

export function RepoIndexPane(props: {
  entries: () => MatchedEntry[]
  labels: () => Map<string, string>
  onOpenLoop: (projectId: string, loopName: string) => void
}) {
  const view = createMemo(() => deriveRepoIndex(props.entries(), props.labels()))
  const runningCount = createMemo(() => view().runningCount)
  const loopCount = createMemo(() => view().loopCount)
  const bugCount = createMemo(() => view().bugCount)
  const runningCards = createMemo(() => view().runningCards)
  const recentRows = createMemo(() => view().recentRows)
  return html`<div class="repo-index-pane">
    <div class="repo-index-head">
      <h2>All repositories</h2>
      <div class="repo-index-summary">${() => `${runningCount()} running · ${loopCount()} loops · ${bugCount()} open bugs`}</div>
    </div>
    ${() => (runningCards().length > 0
      ? html`<div class="repo-index-section">
          <h3 class="repo-index-section-title">Running</h3>
          <div class="repo-running-cards">
            ${runningCards().map(c => html`<div class="repo-running-card" onclick=${() => props.onOpenLoop(c.projectId, c.loopName)}>
              <span class="repo-running-label"><span class="repo-running-dot"></span>${c.label}</span>
              <span class="repo-running-name">${c.loopName}</span>
              <span class="repo-running-phase">${phaseLabel(c.phase)}</span>
            </div>`)}
          </div>
        </div>`
      : '')}
    ${() => (recentRows().length > 0
      ? html`<div class="repo-index-section">
          <h3 class="repo-index-section-title">Recent activity</h3>
          <div class="repo-recent-list">
            ${recentRows().map(r => html`<div class="repo-recent-row" onclick=${() => props.onOpenLoop(r.projectId, r.loopName)}>
              <span class=${() => statusClass(r.status)}>${r.status}</span>
              <span class="repo-recent-label">${r.label}</span>
              <span class="repo-recent-name">${r.loopName}</span>
              <span class="repo-recent-when">${fmtTime(r.when)}</span>
            </div>`)}
          </div>
        </div>`
      : '')}
  </div>`
}

export type LoopOption = { name: string; when: number; whenLabel: string }

export type LoopNav = { index: number; total: number; onPrev: () => void; onNext: () => void }

function LoopPicker(props: {
  loopName: string
  loops: () => LoopOption[]
  onSelect: (name: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [active, setActive] = createSignal(0)

  const matches = createMemo<LoopOption[]>(() => {
    const q = query().trim().toLowerCase()
    const all = props.loops()
    return q ? all.filter(o => o.name.toLowerCase().indexOf(q) !== -1) : all
  })

  const view = createMemo(() => capList(matches(), MAX_RENDERED_PICKER_OPTIONS, false))

  const openMenu = () => {
    if (open()) return
    setQuery('')
    const idx = view().rows.findIndex(o => o.name === props.loopName)
    setActive(idx < 0 ? 0 : idx)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }
  const commit = (name: string) => {
    close()
    input.blur()
    if (name !== props.loopName) props.onSelect(name)
  }

  const menu = html`<div
    class="loop-picker-menu"
    style=${() => (open() ? 'display:block' : 'display:none')}
    onmousedown=${(e: MouseEvent) => e.preventDefault()}
  >
    ${() => view().rows.map((o, i) => html`<div
      class=${() => 'loop-picker-option'
        + (i === active() ? ' loop-picker-option-active' : '')
        + (o.name === props.loopName ? ' loop-picker-option-current' : '')}
      onclick=${() => commit(o.name)}
    >
      <span class="loop-picker-option-name" title=${o.name}>${o.name}</span>
      <span class="loop-picker-option-when">${o.whenLabel}</span>
    </div>`)}
    ${() => (view().total === 0 ? html`<div class="loop-picker-empty">No matching loops</div>` : '')}
    ${() => (view().capped
      ? html`<div class="loop-picker-cap">${() => 'Showing ' + view().rows.length + ' of ' + view().total + ' — type to filter'}</div>`
      : '')}
  </div>` as HTMLElement

  const scrollActiveIntoView = () => {
    const el = menu.querySelector('.loop-picker-option-active') as HTMLElement | null
    el?.scrollIntoView?.({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open()) {
        openMenu()
        return
      }
      const total = view().rows.length
      if (total === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => (i + delta + total) % total)
      scrollActiveIntoView()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = view().rows[active()]
      if (target) commit(target.name)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      input.blur()
    }
  }

  const input = html`<input
    class="breadcrumb-loop loop-picker-input"
    type="text"
    autocomplete="off"
    spellcheck="false"
    aria-label="Jump to loop"
    placeholder=${props.loopName}
    style=${'width:' + Math.min(48, Math.max(14, props.loopName.length + 2)) + 'ch'}
    value=${() => (open() ? query() : props.loopName)}
    onfocus=${openMenu}
    oninput=${(e: Event) => {
      setQuery((e.target as HTMLInputElement).value)
      setActive(0)
      setOpen(true)
    }}
    onkeydown=${onKeyDown}
    onblur=${close}
  />` as HTMLInputElement

  return html`<span class="loop-picker">
    ${input}
    <span class="loop-picker-caret" onmousedown=${(e: MouseEvent) => {
      e.preventDefault()
      if (open()) {
        close()
        input.blur()
      } else {
        input.focus()
      }
    }}>▾</span>
    ${menu}
  </span>`
}

export function Breadcrumb(props: {
  repoLabel: string
  projectDir: string
  loopName: string | null
  loops: () => LoopOption[]
  loopNav: () => LoopNav | null
  onSelectLoop: (name: string) => void
  onBackToRepos: () => void
  onBackToRepo: () => void
}) {
  if (props.loopName) {
    return html`<div class="breadcrumb">
      <span class="breadcrumb-back" onclick=${props.onBackToRepo}>← ${props.repoLabel}</span>
      <span class="breadcrumb-sep">/</span>
      ${LoopPicker({ loopName: props.loopName, loops: props.loops, onSelect: props.onSelectLoop })}
      ${() => {
        const nav = props.loopNav()
        return nav
          ? html`<span class="breadcrumb-loopnav">
              <span class="loopnav-prev" onclick=${nav.onPrev}>‹</span>
              <span class="loopnav-count">${nav.index + 1} of ${nav.total}</span>
              <span class="loopnav-next" onclick=${nav.onNext}>›</span>
            </span>`
          : ''
      }}
    </div>`
  }
  return html`<div class="breadcrumb">
    <span class="breadcrumb-back" onclick=${props.onBackToRepos}>← Repositories</span>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-label">${props.repoLabel}</span>
    <span class="breadcrumb-path">${props.projectDir}</span>
  </div>`
}

export function SectionNav(props: {
  section: RepoSection
  counts: { loops: number; groups: number; findings: number; plans: number }
  onNavigate: (section: RepoSection) => void
}) {
  const items: { key: RepoSection; label: string; count: number }[] = [
    { key: 'loops', label: 'Loops', count: props.counts.loops },
    { key: 'groups', label: 'Groups', count: props.counts.groups },
    { key: 'findings', label: 'Findings', count: props.counts.findings },
    { key: 'plans', label: 'Plans', count: props.counts.plans },
  ]
  return html`<div class="section-nav">
    ${items.map(item => {
      const active = item.key === props.section
      const cls = `section-nav-item${active ? ' section-nav-active' : ''}`
      return html`<div class="${cls}" onclick=${() => props.onNavigate(item.key)}>
        ${item.label}
        <span class="section-nav-count">${item.count}</span>
      </div>`
    })}
  </div>`
}

// ── LoopTable ─────────────────────────────────────────────────────────────

function ListCapNotice(props: { shown: () => number; total: () => number; noun: string; onShowAll?: () => void }) {
  return html`<div class="list-cap-notice">
    <span class="list-cap-text">${() => 'Showing ' + props.shown() + ' of ' + props.total() + ' ' + props.noun}</span>
    ${props.onShowAll
      ? html`<button class="list-cap-show-all" onclick=${props.onShowAll}>Show all</button>`
      : ''}
  </div>`
}

function MiniMeter(props: { current: () => number; total: () => number; formatCurrent?: (n: number) => string }) {
  const pct = () => clampPercent(props.current(), props.total())
  return html`<span class="lt-meter-cell">
    <span class="lt-meter"><span class="lt-meter-fill" style=${() => 'width:' + pct() + '%'}></span></span>
    <span class="lt-meter-text">${() => (props.formatCurrent ? props.formatCurrent(props.current()) : String(props.current()))}/${() => props.total()}</span>
  </span>`
}

type PhaseBarVariant = 'sm' | 'md' | 'lg'

const PHASE_BAR_HEIGHTS: Record<PhaseBarVariant, number> = { sm: 4, md: 14, lg: 22 }

function PhaseBar(props: {
  spans: () => PhaseSpan[]
  variant: PhaseBarVariant
}) {
  const height = PHASE_BAR_HEIGHTS[props.variant]
  const visible = createMemo(() => props.spans().filter(s => s.phase !== ''))
  const total = createMemo(() => Math.max(0, visible().reduce((acc, s) => acc + s.durationMs, 0)))
  const truncated = createMemo(() => props.spans().some(s => s.phase === ''))
  return html`<div class=${() => 'phase-bar phase-bar-' + props.variant + (truncated() ? ' phase-bar-trunc' : '')} data-truncated=${() => (truncated() ? 'true' : 'false')} style=${() => 'height:' + height + 'px'}>
    ${() => (truncated() ? html`<span class="phase-bar-trunc-mark" title="Earlier history truncated by the 100-row fetch window">\u22ef</span>` : '')}
    ${() => {
      const s = visible()
      const tot = total()
      return s.map(sp => {
        const pct = tot > 0 ? (sp.durationMs / tot) * 100 : 0
        const cls = 'phase-seg' + (sp.open ? ' phase-seg-open' : '')
        const dur = formatSpanDuration(sp.durationMs)
        return html`<div class=${cls} data-phase=${sp.phase} title=${phaseLabel(sp.phase) + ' · ' + dur} style=${'width:' + pct + '%'}></div>`
      })
    }}
  </div>`
}

// Shared legend under a phase bar: one row per non-empty phase, longest first,
// with the dot color, human label, and duration + share. Empty span sets render
// an empty container so the layout position is stable across polls.
function Legend(props: {
  items: () => Array<{ label: string; value: string; color?: string; phase?: string }>
  phase?: boolean
}) {
  return html`<div class=${() => 'legend' + (props.phase ? ' legend-phase' : '')}>
    ${() => props.items().map(item => html`<div class="legend-item">
      <span class="legend-dot" data-phase=${item.phase ?? ''} style=${item.color ? 'background:' + item.color : ''}></span>
      <span class="legend-label">${item.label}</span>
      <span class="legend-value">${item.value}</span>
    </div>`)}
  </div>`
}

function PhaseLegend(props: { spans: () => PhaseSpan[] }) {
  const rows = createMemo(() => phaseLegendRows(props.spans()))
  return Legend({
    phase: true,
    items: () => rows().map(row => ({
      phase: row.phase,
      label: row.label,
      value: formatSpanDuration(row.durationMs) + ' · ' + row.pct + '%',
    })),
  })
}

// Single entry point for a loop's phase spans. `now` is only read while the
// loop is in flight: a completed loop's spans are fully determined by its
// transitions, so tracking now() would recompute the spans of every table row
// on each 5s poll tick for the lifetime of the page.
function loopPhaseState(
  loop: DashboardLoop,
  now: () => number,
): { spans: PhaseSpan[]; truncated: boolean } {
  const lp = loop.loop
  return computePhaseSpans(
    loop.transitions ?? [],
    lp.startedAt,
    lp.completedAt,
    lp.completedAt === null ? now() : 0,
    lp.phase,
  )
}

export function LoopTable(props: { loops: () => DashboardLoop[]; now: () => number; onOpen: (name: string) => void }) {
  const [showAll, setShowAll] = createSignal(false)
  const view = createMemo(() => capList(props.loops(), MAX_RENDERED_LOOP_ROWS, showAll()))
  return html`<div class="loop-table-wrap">
    <table class="loop-table">
      <thead><tr>
        <th data-col="status">Status</th><th data-col="loop">Loop</th><th data-col="phase">Phase</th><th data-col="span">Phase span</th>
        <th data-col="iter">Iter</th><th data-col="sections">Sections</th>
        <th data-col="findings">Findings</th><th data-col="cost">Cost</th><th data-col="duration">Duration</th>
        <th data-col="updated">Updated</th>
      </tr></thead>
      <tbody>
        ${() => view().rows.map((dl: DashboardLoop) => LoopTableRow({ dashLoop: dl, now: props.now, onOpen: props.onOpen }))}
      </tbody>
    </table>
    ${() => (view().capped
      ? ListCapNotice({ shown: () => view().rows.length, total: () => view().total, noun: 'loops', onShowAll: () => setShowAll(true) })
      : '')}
  </div>`
}

function LoopTableRow(props: { dashLoop: DashboardLoop; now: () => number; onOpen: (name: string) => void }) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const counts = createMemo(() => splitFindings(dl().findings))
  const spans = createMemo(() => loopPhaseState(dl(), props.now).spans)
  return html`<tr class="lt-row" onclick=${() => props.onOpen(props.dashLoop.loop.loopName)}>
    <td data-col="status"><span class=${() => statusClass(lp().status)}>${() => lp().status}</span></td>
    <td data-col="loop" class="lt-name">${() => lp().loopName}</td>
    <td data-col="phase" class="lt-phase">${() => (lp().completedAt === null
      ? html`<span class="lt-phase-chip" data-phase=${() => lp().phase}>${() => phaseLabel(lp().phase)}</span>`
      : html`<span class="dim">—</span>`)}</td>
    <td data-col="span" class="lt-phase-bar">${() => PhaseBar({ spans, variant: 'sm' })}</td>
    <td data-col="iter">${MiniMeter({ current: () => lp().iteration, total: () => lp().maxIterations })}</td>
    <td data-col="sections">${() => (lp().totalSections > 0
      ? MiniMeter({ current: () => lp().currentSectionIndex, total: () => lp().totalSections, formatCurrent: formatSectionNumber })
      : html`<span class="dim">—</span>`)}</td>
    <td data-col="findings" class="lt-findings">${() => {
      const c = counts()
      if (c.bugs.length === 0 && c.warnings.length === 0) return html`<span class="dim">—</span>`
      return html`<span>
        ${c.bugs.length > 0 ? html`<span class="finding-bug">${formatFindingCount(c.bugs.length, 'bug')}</span>` : ''}
        ${c.bugs.length > 0 && c.warnings.length > 0 ? ' · ' : ''}
        ${c.warnings.length > 0 ? html`<span class="finding-warning">${formatFindingCount(c.warnings.length, 'warn')}</span>` : ''}
      </span>`
    }}</td>
    <td data-col="cost" class="lt-cost">${() => (dl().usage ? formatUsageCost(dl().usage!.totalCost) : html`<span class="dim">—</span>`)}</td>
    <td data-col="duration" class="lt-duration">${() => dl().duration || ''}</td>
    <td data-col="updated" class="lt-updated">${() => fmtTime(loopActivityAt(lp()))}</td>
  </tr>`
}
// ── MarkdownSection ───────────────────────────────────────────────────────

// Always renders its block; callers gate presence with a boolean memo so the
// body node persists across polls and only innerHTML updates in place, which is
// what keeps the collapsed/expanded state stable. The body is not scrollable —
// it lays out at full height and the page scrolls instead. The single root
// element is required — a template that is only `${...}` generates invalid code
// in solid-js/html.
function MarkdownSection(props: { label: string | (() => string); src: () => string | null | undefined }) {
  const label = () => (typeof props.label === 'function' ? props.label() : props.label)
  const [collapsed, setCollapsed] = createSignal(false)
  const toggle = () => setCollapsed(c => !c)
  const rendered = createMemo(() => renderMarkdownWithOutline(props.src() || ''))
  const toc = createMemo(() => rendered().outline.filter(h => h.depth <= 3))
  return html`<div class="markdown-section">
    <div class="markdown-heading-row">
      <div
        class="markdown-toggle"
        role="button"
        tabindex="0"
        aria-expanded=${() => (collapsed() ? 'false' : 'true')}
        onclick=${toggle}
        onkeydown=${(e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          toggle()
        }}
      >
        <span class="markdown-caret">${() => (collapsed() ? '▸' : '▾')}</span>
        <h4 class="section-label">${() => label()}</h4>
      </div>
      <button
        class="copy-btn"
        aria-label=${() => 'Copy ' + label() + ' as markdown'}
        onclick=${(e: Event) => {
          e.stopPropagation()
          const btn = e.target as HTMLButtonElement
          const orig = 'Copy'
          navigator.clipboard.writeText(props.src() || '').then(
            () => { btn.textContent = 'Copied!' },
            () => { btn.textContent = 'Failed' },
          ).then(() => {
            setTimeout(() => { btn.textContent = orig }, 2000)
          })
        }}
      >Copy</button>
    </div>
    <div class="markdown-body" style=${() => (collapsed() ? 'display:none' : 'display:block')}>
      ${() => {
        const items = toc()
        return items.length >= 2 ? MarkdownToc({ items: () => items }) : null
      }}
      <div class="markdown-content" innerHTML=${() => rendered().html}></div>
    </div>
  </div>`
}

// Floating table of contents for a markdown body. Renders only when the parent
// gates it (>= 2 h1-h3 headings). Jump links scroll the matching heading into
// view via the id injected by renderMarkdownWithOutline.
//
// Heading ids are slugs of the heading text, so the same slug can occur in
// several markdown sections and in several (kept-mounted, display:none) tabs.
// The lookup is therefore scoped to the owning .markdown-body instead of using
// document.getElementById, which would resolve the first match anywhere in the
// document — often inside a hidden tab, where scrollIntoView is a no-op.
function MarkdownToc(props: { items: () => MarkdownHeading[] }) {
  const jump = (e: MouseEvent, id: string) => {
    e.preventDefault()
    const scope = (e.currentTarget as HTMLElement).closest('.markdown-body')
    const el = scope
      ? Array.from(scope.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find(h => h.id === id)
      : document.getElementById(id)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
  return html`<nav class="markdown-toc" aria-label="Section contents">
    <div class="markdown-toc-title">Contents</div>
    <ul>
      ${() => props.items().map(h => html`<li class=${() => 'markdown-toc-item markdown-toc-depth-' + h.depth}>
        <a href=${() => '#' + h.id} onclick=${(e: MouseEvent) => jump(e, h.id)}>${h.text}</a>
      </li>`)}
    </ul>
  </nav>`
}

// ── Sections ──────────────────────────────────────────────────────────────

// A labeled markdown summary block (Done / Deviations / Follow-ups).
function SectionSummaryPart(props: { label: string; value: () => string | null }) {
  return html`<div class="section-summary-part">
    <div class="section-summary-label">${props.label}</div>
    <div class="markdown-content" innerHTML=${() => renderMarkdown(props.value() || '')}></div>
  </div>`
}

// Expanded body: timing, the auditor's section summary, and the section plan.
function SectionBody(props: { sec: DashboardSection }) {
  const sec = props.sec
  const hasTiming = createMemo(() => !!sec.startedAt || !!sec.completedAt)
  const hasDone = createMemo(() => !!sec.summaryDone)
  const hasDeviations = createMemo(() => !!sec.summaryDeviations)
  const hasFollowUps = createMemo(() => !!sec.summaryFollowUps)
  const hasContent = createMemo(() => !!sec.content)
  const hasAnything = createMemo(
    () => hasTiming() || hasDone() || hasDeviations() || hasFollowUps() || hasContent(),
  )

  return html`<div class="section-body">
    ${() =>
      hasTiming()
        ? html`<div class="section-timing">
            <span>${() => (sec.startedAt ? 'Started ' + fmtTime(sec.startedAt) : 'Not started')}</span>
            ${() => (sec.completedAt ? html`<span> → Completed ${() => fmtTime(sec.completedAt)}</span>` : '')}
          </div>`
        : ''}
    ${() => (hasDone() ? SectionSummaryPart({ label: 'Done', value: () => sec.summaryDone }) : '')}
    ${() => (hasDeviations() ? SectionSummaryPart({ label: 'Deviations', value: () => sec.summaryDeviations }) : '')}
    ${() => (hasFollowUps() ? SectionSummaryPart({ label: 'Follow-ups', value: () => sec.summaryFollowUps }) : '')}
    ${() => (hasContent() ? MarkdownSection({ label: 'Section Plan', src: () => sec.content }) : '')}
    ${() => (hasAnything() ? '' : html`<div class="section-empty">No details captured for this section yet.</div>`)}
  </div>`
}

// A compact clickable row, reusing existing .section-item-{status}, .section-index,
// .section-title, .section-status, .section-duration, .section-attempts classes.
// `adjusted` gates the .section-adjusted flag for sections amended by the loop.
function SectionListRow(props: { sec: DashboardSection; onOpen: () => void; adjusted: () => boolean }) {
  const sec = props.sec
  const duration = createMemo(() => formatSectionDuration(sec.startedAt, sec.completedAt))
  return html`<div class=${() => 'section-list-row section-item-' + sec.status} onclick=${props.onOpen}>
    <span class="section-index">#${formatSectionNumber(sec.sectionIndex)}</span>
    <span class="section-title">${() => sec.title}</span>
    <span class=${() => sectionStatusClass(sec.status)}>${() => sec.status}</span>
    ${() => (props.adjusted() ? html`<span class="section-adjusted">adjusted</span>` : '')}
    ${() => (duration() ? html`<span class="section-duration">${() => duration()}</span>` : '')}
    ${() => (sec.attempts > 0 ? html`<span class="section-attempts">${() => sec.attempts} attempts</span>` : '')}
    <span class="section-caret">▸</span>
  </div>`
}

// Owns a selectedIndex signal; selecting shows a back link + the section title +
// reused SectionBody; deselected shows the list. Persistence: current() returns
// the same store proxy across polls, so the selected branch's thunk does not
// re-run and SectionBody (its .markdown-body) is not rebuilt.
function SectionsPanel(props: {
  sections: () => DashboardSection[]
  amendments: () => DashboardLoop['amendments']
}) {
  const [selected, setSelected] = createSignal<number | null>(null)
  const adjustedSections = createMemo(() => amendedSectionIndexes(props.amendments()))
  const current = createMemo(() => {
    const idx = selected()
    if (idx === null) return null
    return props.sections().find(s => s.sectionIndex === idx) ?? null
  })
  return html`<div class="sections-panel">
    <h4>Sections</h4>
    ${() => {
      const sec = current()
      if (sec) {
        return html`<div class="section-drill">
          <div class="back-to-sections" onclick=${() => setSelected(null)}>← Back to sections</div>
          <div class="section-drill-title">
            <span class="section-index">#${formatSectionNumber(sec.sectionIndex)}</span>
            <span class="section-title">${() => sec.title}</span>
            <span class=${() => sectionStatusClass(sec.status)}>${() => sec.status}</span>
          </div>
          ${SectionBody({ sec })}
        </div>`
      }
      return html`<div class="section-list">
        ${props.sections().map((s: DashboardSection) =>
          SectionListRow({
            sec: s,
            onOpen: () => setSelected(s.sectionIndex),
            adjusted: () => adjustedSections().has(s.sectionIndex),
          }))}
      </div>`
    }}
  </div>`
}

// ── LoopDetailHeader ──────────────────────────────────────────────────────

// A labeled stat cell (label above value). The value is read through an
// accessor so it updates in place on polls without rebuilding the cell.
// An optional title accessor surfaces long model/branch values on hover.
function LoopDetailCell(props: {
  label: string
  value: () => string
  title?: () => string
  tone?: () => string
  size?: 'stat' | 'metric'
}): Node {
  const cls = () => 'ldh-cell'
    + (props.size === 'stat' ? ' ldh-cell-stat' : '')
    + (props.tone ? ' ldh-cell-' + props.tone() : '')
  const valueCls = () => 'ldh-cell-value' + (props.size === 'stat' ? ' ldh-cell-value-stat' : '')
  return html`<div class=${cls}>
    <span class="ldh-cell-label">${props.label}</span>
    <span class=${valueCls} title=${() => props.title ? props.title() : ''}>${() => props.value()}</span>
  </div>` as Node
}

// A labelled stat group: the group label plus the shared .ldh-stats grid.
function LoopDetailStatGroup(props: { label: string; children: Node[] }): Node {
  return html`<div class="ldh-group">
    <div class="ldh-group-label">${props.label}</div>
    <div class="ldh-stats">${() => props.children.map(n => n)}</div>
  </div>` as Node
}

// A progress bar with a count, clamped to 0–100%. Both current and total are
// accessors so the fill width tracks live loop updates.
function LoopDetailProgress(props: { label: string; current: () => number; total: () => number; formatCurrent?: (n: number) => string }) {
  const pct = () => clampPercent(props.current(), props.total())
  return html`<div class="ldh-bar-group">
    <div class="ldh-bar-head">
      <span class="ldh-bar-label">${props.label}</span>
      <span class="ldh-bar-count">${() => (props.formatCurrent ? props.formatCurrent(props.current()) : String(props.current()))} / ${() => props.total()}</span>
    </div>
    <div class="ldh-bar-track">
      <div class="ldh-bar-fill" style=${() => 'width:' + pct() + '%'}></div>
    </div>
  </div>`
}

// Structured replacement for the cramped single-line summary: a status/name
// title row, a primary metric strip, grouped labeled stats, iteration/section
// progress bars, and a status-tinted outcome banner. Built once per selected
// loop; every dynamic field is read reactively so it updates in place on polls.
function LoopDetailHeader(props: {
  dashLoop: DashboardLoop
  split: () => { bugs: DashboardLoop['findings']; warnings: DashboardLoop['findings'] }
  onSelectTab: (t: LoopTab) => void
}) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const hasCompletedAt = createMemo(() => !!lp().completedAt)
  const isLive = createMemo(() => lp().completedAt === null)
  const hasSectionsTotal = createMemo(() => lp().totalSections > 0)
  const amendmentsSummary = createMemo(() => summarizeAmendments(dl().amendments ?? []))
  const bannerText = createMemo(() => {
    const r = lp().terminationReason
    if (!r) return null
    return r.trim().toLowerCase() === lp().status.toLowerCase() ? null : r
  })
  const level = createMemo(() => findingsLevel(props.split()))
  const hasUsage = createMemo(() => !!props.dashLoop.usage)
  const findingsSummary = createMemo(() => {
    const s = props.split()
    if (s.bugs.length === 0 && s.warnings.length === 0) return 'No findings'
    const parts: string[] = []
    if (s.bugs.length > 0) parts.push(formatFindingCount(s.bugs.length, 'bug'))
    if (s.warnings.length > 0) parts.push(formatFindingCount(s.warnings.length, 'warning'))
    return parts.join(' · ')
  })
  // Group membership is reactive (Completed appears when the loop finishes,
  // Messages when usage arrives); the stat values update in place through
  // their accessors, so this memo only rebuilds on membership changes.
  const groups = createMemo(() => {
    const timing: Node[] = [LoopDetailCell({ label: 'Started', value: () => fmtTime(lp().startedAt), size: 'stat' })]
    if (hasCompletedAt()) timing.push(LoopDetailCell({ label: 'Completed', value: () => fmtTime(lp().completedAt), size: 'stat' }))

    const models: Node[] = [
      LoopDetailCell({ label: 'Execution model', value: () => lp().executionModel ?? '—', title: () => lp().executionModel ?? '', size: 'stat' }),
      LoopDetailCell({
        label: 'Auditor model',
        value: () => {
          const base = lp().auditorModel ?? '—'
          const fallbackIndex = lp().auditorFallbackIndex ?? 0
          return fallbackIndex > 0 ? `${base} (fallback ${fallbackIndex})` : base
        },
        title: () => lp().auditorModel ?? '',
        size: 'stat',
      }),
    ]

    const env: Node[] = [
      LoopDetailCell({ label: 'Branch', value: () => lp().worktreeBranch ?? '—', title: () => lp().worktreeBranch ?? '', size: 'stat' }),
      LoopDetailCell({ label: 'Sandbox', value: () => (lp().sandbox ? 'on' : 'off'), size: 'stat' }),
      LoopDetailCell({ label: 'Kind', value: () => lp().kind ?? '—', size: 'stat' }),
      LoopDetailCell({ label: 'Audits', value: () => String(lp().auditCount), size: 'stat' }),
      LoopDetailCell({ label: 'Errors', value: () => String(lp().errorCount), size: 'stat' }),
    ]
    if (hasUsage()) env.push(LoopDetailCell({ label: 'Messages', value: () => String(props.dashLoop.usage!.totalMessageCount), size: 'stat' }))

    return [
      LoopDetailStatGroup({ label: 'Timing', children: timing }),
      LoopDetailStatGroup({ label: 'Models', children: models }),
      LoopDetailStatGroup({ label: 'Environment', children: env }),
    ]
  })

  return html`<div class="loop-detail-header">
    <div class="ldh-top">
      <span class=${() => statusClass(lp().status)}>${() => lp().status}</span>
      <h3 class="ldh-name">${() => lp().loopName}</h3>
      ${() => (amendmentsSummary().count > 0
        ? html`<button
            class="ldh-amendments"
            onclick=${() => props.onSelectTab('plan')}
          >${() => 'Plan adjusted ' + amendmentsSummary().count + '× · last ' + formatRelativeTime(amendmentsSummary().lastAt) + ' @ section ' + formatSectionNumber(amendmentsSummary().lastSection!)}</button>`
        : '')}
      ${() => (isLive() ? html`<span class="ldh-phase">${phaseLabel(lp().phase)}</span>` : '')}
    </div>

    <div class="ldh-primary">
      ${LoopDetailCell({ label: 'Duration', value: () => dl().duration || '—' })}
      ${LoopDetailCell({ label: 'Cost', value: () => (hasUsage() ? formatUsageCost(props.dashLoop.usage!.totalCost) : '—') })}
      ${LoopDetailCell({ label: 'Iterations', value: () => lp().iteration + ' / ' + lp().maxIterations })}
      ${() => (hasSectionsTotal() ? LoopDetailCell({ label: 'Sections', value: () => formatSectionNumber(lp().currentSectionIndex) + ' / ' + lp().totalSections }) : '')}
      ${LoopDetailCell({ label: 'Findings', value: () => findingsSummary(), tone: () => level() })}
    </div>

    <div class="ldh-bars">
      ${LoopDetailProgress({ label: 'Iterations', current: () => lp().iteration, total: () => lp().maxIterations })}
      ${() =>
        hasSectionsTotal()
          ? LoopDetailProgress({ label: 'Sections', current: () => lp().currentSectionIndex, total: () => lp().totalSections, formatCurrent: formatSectionNumber })
          : ''}
    </div>

    <div class="ldh-groups">${() => groups()}</div>

    ${() =>
      bannerText()
        ? html`<div class=${() => 'ldh-banner ldh-banner-' + lp().status}>${() => bannerText()}</div>`
        : ''}
  </div>`
}

// ── LoopUsage ─────────────────────────────────────────────────────────────

// CSS-only usage graphs: a stacked token-composition bar with legend, and
// per-model cost bars. The full precise numbers remain available as hover
// tooltips via the existing format helpers. Usage has no scroll/resize state
// to preserve, so re-mapping on poll updates is fine.
function LoopUsage(props: {
  usage: () => NonNullable<DashboardLoop['usage']>
}) {
  const u = () => props.usage()
  const segments = createMemo(() => tokenBreakdownSegments(u()))
  const models = createMemo(() => modelUsageBars(u()))
  const hasModels = createMemo(() => models().length > 0)
  const roles = createMemo(() => roleUsageBars(u()))

  return html`<div class="usage-group">
    <h4>Usage</h4>

    <div class="usage-block">
      <div class="usage-block-title">Role split</div>
      <div class="usage-models" title="Role split">
        ${() => roles().map(r => html`<div class="usage-model-row" title=${() => r.role}>
          <div class="usage-model-head">
            <span class="usage-model-name" title=${() => r.role}>${r.role}</span>
            <span class="usage-model-cost">${() => formatUsageCost(r.cost)}</span>
          </div>
          <div class="usage-model-track">
            <div class="usage-model-fill" style=${() => 'width:' + r.pct + '%'}></div>
          </div>
          <div class="usage-model-meta">${() => r.messageCount + ' msg · ' + formatTokenCount(r.tokens) + ' tok'}</div>
        </div>`)}
      </div>
    </div>

    <div class="usage-block">
      <div class="usage-block-title">Token composition</div>
      <div class="usage-stack">
        ${() =>
          segments().map(seg =>
            seg.pct > 0
              ? html`<div
                  class="usage-stack-seg"
                  style=${'width:' + seg.pct + '%;background:' + seg.color}
                  title=${seg.label + ': ' + seg.value.toLocaleString()}
                ></div>`
              : '',
          )}
      </div>
      ${Legend({
        items: () => segments().map(seg => ({
          color: seg.color,
          label: seg.label,
          value: formatTokenCount(seg.value),
        })),
      })}
    </div>

    ${() =>
      hasModels()
        ? html`<div class="usage-block">
            <div class="usage-block-title">Cost by model</div>
            <div class="usage-models">
              ${() =>
                models().map(
                  m => html`<div class="usage-model-row" title=${formatModelUsage(m.model, u().byModel[m.model])}>
                    <div class="usage-model-head">
                      <span class="usage-model-name" title=${m.model}>${m.model}</span>
                      <span class="usage-model-cost">${formatUsageCost(m.cost)}</span>
                    </div>
                    <div class="usage-model-track">
                      <div class="usage-model-fill" style=${'width:' + m.pct + '%'}></div>
                    </div>
                    <div class="usage-model-meta">
                      ${formatTokenCount(m.inputTokens)} in / ${formatTokenCount(m.outputTokens)} out · ${m.messageCount} msg
                    </div>
                  </div>`,
                )}
            </div>
          </div>`
        : ''}
  </div>`
}

// ── Plan Amendments ───────────────────────────────────────────────────────

// A single amendment row with an expand/collapse toggle. The expanded body
// lazily fetches the per-amendment diff on first open and caches it for the
// row's lifetime — amendments are immutable once written.
function AmendmentRow(props: {
  amendment: NonNullable<DashboardLoop['amendments']>[number]
  expanded: () => boolean
  onToggle: () => void
}) {
  const a = props.amendment
  const [diff, setDiff] = createSignal<AmendmentDiff | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [requested, setRequested] = createSignal(false)

  createEffect(() => {
    if (!props.expanded() || requested()) return
    setRequested(true)
    setLoading(true)
    const params = new URLSearchParams({ project: a.projectId, loop: a.loopName, id: String(a.id) })
    void fetch('/api/amendment?' + params.toString())
      .then(async res => {
        if (!res.ok) {
          setError((await res.text().catch(() => '')) || `Failed (status ${res.status})`)
          return
        }
        const payload = await res.json() as AmendmentDiff
        setDiff(payload)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  })

  const summaryCounts = () => {
    const counts: Array<{ cls: string; label: string }> = []
    if (a.summary.added > 0) counts.push({ cls: 'amendment-count-add', label: '+' + a.summary.added })
    if (a.summary.removed > 0) counts.push({ cls: 'amendment-count-remove', label: '\u2212' + a.summary.removed })
    if (a.summary.modified > 0) counts.push({ cls: 'amendment-count-modified', label: '~' + a.summary.modified })
    return counts
  }

  const changedSections = () => (diff()?.sections ?? []).filter(sec => sec.change !== 'unchanged')
  const noChanges = () => diff() !== null && changedSections().length === 0

  const diffLineText = (line: AmendmentDiffLine): string => {
    if (line.kind === 'add') return '+ ' + line.text
    if (line.kind === 'remove') return '- ' + line.text
    if (line.kind === 'context') return '  ' + line.text
    return line.text
  }

  return html`<div class="amendment-row">
    <div class="amendment-head" onclick=${props.onToggle}>
      <span class="amendment-time">${() => formatRelativeTime(a.createdAt)}</span>
      <span class="amendment-section">${() => 'applied @ section ' + formatSectionNumber(a.appliedAtSection)}</span>
      <span class="amendment-source">${() => a.source}</span>
      ${() => (summaryCounts().length > 0
        ? html`<span class="amendment-summary">${summaryCounts().map(c => html`<span class=${'amendment-count ' + c.cls}>${c.label}</span>`)}</span>`
        : '')}
      <span class="amendment-rationale">${() => a.rationale}</span>
      <span class="amendment-caret">${() => (props.expanded() ? '▾' : '▸')}</span>
    </div>
    <div class="amendment-body" style=${() => props.expanded() ? 'display:block' : 'display:none'}>
      <div class="amendment-diff">
        ${() => (loading() ? html`<div class="amendment-diff-loading">Loading diff…</div>` : '')}
        ${() => (error() ? html`<div class="amendment-diff-error">${error()}</div>` : '')}
        ${() => (noChanges() ? html`<div class="amendment-diff-empty">No section changes recorded.</div>` : '')}
        ${() => changedSections().map(sec => html`<div class="amendment-diff-section">
          <div class="amendment-diff-head">
            <span class="amendment-diff-index">${() => '#' + formatSectionNumber(sec.index)}</span>
            <span class="amendment-diff-change">${() => sec.change}</span>
            <span class="amendment-diff-title">${() => sec.title}</span>
            ${() => (sec.previousTitle !== null
              ? html`<span class="amendment-diff-prev">${() => 'was: ' + sec.previousTitle}</span>`
              : '')}
          </div>
          ${() => (sec.lines.length === 0
            ? html`<div class="amendment-diff-empty">Title changed only.</div>`
            : sec.lines.map(line => html`<div class=${'amendment-diff-line amendment-diff-line-' + line.kind}>${diffLineText(line)}</div>`))}
        </div>`)}
      </div>
    </div>
  </div>`
}

// Renders an "Plan amendments" panel only when the loop has amendments (gate
// via boolean memo so the block's identity persists across polls).
function AmendmentsPanel(props: {
  amendments: () => NonNullable<DashboardLoop['amendments']>
}) {
  const list = () => props.amendments()
  const [expandedId, setExpandedId] = createSignal<number | null>(null)

  return html`<div class="amendments-panel">
    <h4>Plan amendments</h4>
    <div class="amendments-list">
      ${() => list().map(a => AmendmentRow({
        amendment: a,
        expanded: () => expandedId() === a.id,
        onToggle: () => setExpandedId(expandedId() === a.id ? null : a.id),
      }))}
    </div>
  </div>`
}

const TAB_LABELS: Record<LoopTab, string> = {
  overview: 'Overview',
  live: 'Live',
  timeline: 'Timeline',
  sections: 'Sections',
  findings: 'Findings',
  plan: 'Plan',
  usage: 'Usage',
}

function TabBar(props: {
  tabs: () => LoopTab[]
  activeTab: () => LoopTab
  onSelect: (t: LoopTab) => void
}) {
  return html`<div class="tab-bar">
    ${() => props.tabs().map((t: LoopTab) => {
      const label = TAB_LABELS[t]
      const cls = () => 'tab-item' + (props.activeTab() === t ? ' tab-active' : '')
      return html`<span class=${cls} data-tab="${t}" onclick=${() => props.onSelect(t)}>${label}</span>`
    })}
  </div>`
}

function OverviewTabBody(props: { dashLoop: DashboardLoop; split: () => Split; now: () => number; onSelectTab: (t: LoopTab) => void }) {
  const dl = () => props.dashLoop
  const lp = () => dl().loop
  const hasGoal = createMemo(() => !!dl().goal)
  const reportSrc = createMemo(() => dl().postActionReport ?? lp().completionSummary ?? null)
  const reportLabel = createMemo(() => dl().postActionReport ? 'Post-Action Report' : 'Completion Summary')
  const hasReport = createMemo(() => !!reportSrc())
  const hasAudit = createMemo(() => !!dl().lastAuditResult)
  const phaseState = createMemo(() => loopPhaseState(dl(), props.now))
  return html`<div class="overview-tab">
    ${() => PhaseBar({ spans: () => phaseState().spans, variant: 'md' })}
    ${() => PhaseLegend({ spans: () => phaseState().spans })}
    ${() => (hasGoal() ? MarkdownSection({ label: 'Goal', src: () => dl().goal }) : '')}
    ${LoopDetailHeader({ dashLoop: props.dashLoop, split: props.split, onSelectTab: props.onSelectTab })}
    ${() => (hasReport() ? MarkdownSection({ label: reportLabel, src: () => reportSrc() }) : '')}
    ${() => (hasAudit() ? MarkdownSection({ label: 'Last Audit Result', src: () => dl().lastAuditResult }) : '')}
  </div>`
}

function TimelineEventRow(props: {
  ev: { transition: NonNullable<DashboardLoop['transitions']>[number]; elapsedMs: number | null }
}) {
  const t = props.ev.transition
  const elapsedMs = props.ev.elapsedMs
  const elapsedSec = elapsedMs === null ? null : Math.floor(elapsedMs / 1000)
  const flowTarget = t.toPhase === null ? (t.status ?? '') : t.toPhase
  return html`<div class="tl-event">
    <span class="tl-event-time">${formatRelativeTime(t.createdAt)}</span>
    <span class="tl-event-flow">${phaseLabel(t.fromPhase)} → ${phaseLabel(flowTarget)}</span>
    <span class="tl-event-kind">${t.transitionKind}</span>
    <span class="tl-event-iter">iter ${t.iteration}</span>
    <span class="tl-event-section">${() => (t.sectionIndex === null ? '—' : 'sect ' + formatSectionNumber(t.sectionIndex))}</span>
    <span class="tl-event-elapsed">${() => (elapsedSec === null ? '—' : elapsedSec > 0 ? formatDuration(elapsedSec) : '0s')}</span>
  </div>`
}

// A plan adjustment entry in the merged timeline stream. Distinct from the
// uniform .tl-event grid rows: flex layout with an attention-tinted chip and
// the auditor's rationale instead of phase-flow fields.
function TimelineAmendmentRow(props: { amendment: NonNullable<DashboardLoop['amendments']>[number] }) {
  const a = props.amendment
  return html`<div class="tl-amendment">
    <span class="tl-event-time">${formatRelativeTime(a.createdAt)}</span>
    <span class="tl-amendment-kind">plan adjusted</span>
    <span class="tl-amendment-section">${() => 'section ' + formatSectionNumber(a.appliedAtSection)}</span>
    <span class="tl-amendment-rationale">${() => a.rationale}</span>
  </div>`
}

function TimelineTabBody(props: { dashLoop: DashboardLoop; now: () => number }) {
  const dl = () => props.dashLoop
  const lp = () => dl().loop
  const transitions = () => dl().transitions ?? []
  const phaseState = createMemo(() => loopPhaseState(dl(), props.now))
  const spans = createMemo(() => phaseState().spans)
  const truncated = createMemo(() => phaseState().truncated)

  const eventsNewestFirst = createMemo(() =>
    mergeTimelineEntries(transitions(), dl().amendments ?? [], lp().startedAt, truncated()),
  )

  const [showAll, setShowAll] = createSignal(false)
  const visibleEvents = createMemo(() => {
    const all = eventsNewestFirst()
    return showAll() ? all : all.slice(0, 20)
  })
  const hiddenCount = createMemo(() => (showAll() ? 0 : Math.max(0, eventsNewestFirst().length - 20)))

  return html`<div class="timeline-tab timeline-graph">
    ${LoopMachineGraph({ loop: () => lp(), transitions })}
    ${() => PhaseBar({ spans, variant: 'lg' })}
    ${() => (truncated()
      ? html`<div class="phase-truncated">Earlier history was truncated by the 100-row fetch window.</div>`
      : '')}
    ${() => PhaseLegend({ spans })}

    <div class="timeline-events">
      ${() => visibleEvents().map(entry => (entry.kind === 'transition'
        ? TimelineEventRow({ ev: { transition: entry.transition, elapsedMs: entry.elapsedMs } })
        : TimelineAmendmentRow({ amendment: entry.amendment })))}
      ${() => (hiddenCount() > 0
        ? html`<div class="tl-event-expand" onclick=${() => setShowAll(true)}>[ ${() => hiddenCount()} earlier events ]</div>`
        : '')}
    </div>
  </div>`
}

function SectionsTabBody(props: { dashLoop: DashboardLoop }) {
  return SectionsPanel({
    sections: () => props.dashLoop.sections,
    amendments: () => props.dashLoop.amendments ?? [],
  })
}

type Split = { bugs: DashboardLoop['findings']; warnings: DashboardLoop['findings'] }

function groupFindingsBySection(findings: DashboardLoop['findings']): Array<{ key: number | null; label: string; rows: DashboardLoop['findings'] }> {
  const order: (number | null)[] = []
  const map = new Map<number | null, DashboardLoop['findings']>()
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
  return order.map(k => ({
    key: k,
    label: k === null ? 'cross-section' : 'sect ' + formatSectionNumber(k),
    rows: map.get(k)!,
  }))
}

// The single renderer for a block of finding rows, shared by the per-loop
// Findings tab and the repo-level Findings section.
function FindingRows(props: { rows: DashboardLoop['findings'] }) {
  return html`<div class="resizable-block">
    ${props.rows.map(f => html`<div class=${() => 'finding finding-' + f.severity}>
      <span class="finding-time">${() => formatRelativeTime(f.createdAt)}</span>
      <span class="finding-text">${() => formatFinding(f)}</span>
    </div>`)}
  </div>`
}

// The single renderer for an anchor that opens a loop in-app. Owns both the
// deep-link hash and the modifier-key guard that lets browser-native
// open-in-new-tab keep working.
function LoopLink(props: {
  className: string
  projectId: () => string | null
  loopName: string
  onOpen: (loopName: string) => void
}) {
  const href = () =>
    buildDashboardHash({
      projectId: props.projectId(),
      section: 'loops',
      loopName: props.loopName,
      tab: 'overview',
      groupId: null,
      statuses: [],
      query: '',
    })
  return html`<a class=${props.className} href=${href} onclick=${(e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    props.onOpen(props.loopName)
  }}>${props.loopName}</a>`
}

function FindingsTabBody(props: { dashLoop: DashboardLoop }) {
  const dl = () => props.dashLoop
  const hasFindings = createMemo(() => dl().findings.length > 0)
  const groups = createMemo(() => groupFindingsBySection(dl().findings))
  return html`<div class="findings-tab">
    ${() => (hasFindings()
      ? groups().map(g => html`<div class="findings-group" data-section-key=${() => g.key === null ? 'cross' : String(g.key)}>
          <div class="findings-group-label">${g.label}</div>
          ${FindingRows({ rows: g.rows })}
        </div>`)
      : html`<div class="tab-empty">No findings recorded for this loop.</div>`)}
  </div>`
}

function PlanTabBody(props: { dashLoop: DashboardLoop }) {
  const dl = () => props.dashLoop
  const hasPlan = createMemo(() => dl().hasPlan)
  const hasAmendments = createMemo(() => !!dl().amendments && dl().amendments.length > 0)
  return html`<div class="plan-tab">
    ${() => (hasPlan()
      ? MarkdownSection({ label: 'Plan', src: () => dl().plan })
      : html`<div class="tab-empty">No plan recorded for this loop.</div>`)}
    ${() => (hasAmendments() ? AmendmentsPanel({ amendments: () => dl().amendments! }) : '')}
  </div>`
}

function UsageTabBody(props: { dashLoop: DashboardLoop }) {
  const dl = () => props.dashLoop
  const hasUsage = createMemo(() => !!dl().usage)
  return html`<div class="usage-tab">
    ${() => (hasUsage()
      ? LoopUsage({
          usage: () => dl().usage!,
        })
      : html`<div class="tab-empty">No usage recorded for this loop.</div>`)}
  </div>`
}

// ── LiveModelControls ─────────────────────────────────────────────────────

interface CatalogModel {
  id: string
  name: string
  provider: string
  variants: Array<{ id: string; label: string }>
}

// Re-point a running loop at different models. The runtime re-reads loop state
// on every prompt, so a change lands on the next coding prompt (execution) or
// the next audit dispatch (auditor) — never mid-turn.
function LiveModelControls(props: { dashLoop: DashboardLoop }) {
  const lp = () => props.dashLoop.loop
  const [catalog, setCatalog] = createSignal<CatalogModel[]>([])
  const [catalogError, setCatalogError] = createSignal('')
  const [execModel, setExecModel] = createSignal<string>('')
  const [execVariant, setExecVariant] = createSignal<string>('')
  const [auditModel, setAuditModel] = createSignal<string>('')
  const [auditVariant, setAuditVariant] = createSignal<string>('')
  const [applying, setApplying] = createSignal(false)
  const [applyError, setApplyError] = createSignal('')
  const [applied, setApplied] = createSignal(false)
  const [open, setOpen] = createSignal(false)

  // Seed the selects from loop state, and re-seed whenever the poll reports a
  // change made elsewhere (TUI, another tab) while this panel is untouched.
  createEffect(() => {
    if (applying()) return
    setExecModel(lp().executionModel ?? '')
    setExecVariant(lp().executionVariant ?? '')
    setAuditModel(lp().auditorModel ?? '')
    setAuditVariant(lp().auditorVariant ?? '')
  })

  createEffect(() => {
    if (!open() || catalog().length > 0) return
    const params = new URLSearchParams({ project: lp().projectId, loop: lp().loopName })
    void fetch('/api/models?' + params.toString())
      .then(async res => {
        if (!res.ok) {
          setCatalogError((await res.text().catch(() => '')) || `Failed (status ${res.status})`)
          return
        }
        const payload = await res.json() as { models?: CatalogModel[] }
        setCatalog(payload.models ?? [])
        setCatalogError('')
      })
      .catch(err => setCatalogError(err instanceof Error ? err.message : String(err)))
  })

  const variantsFor = (modelId: string): Array<{ id: string; label: string }> =>
    catalog().find(m => m.id === modelId)?.variants ?? []

  const apply = async () => {
    if (applying()) return
    setApplying(true)
    setApplyError('')
    setApplied(false)
    try {
      const res = await fetch('/api/loop/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: lp().projectId,
          loopName: lp().loopName,
          executionModel: execModel() || null,
          executionVariant: execVariant() || null,
          auditorModel: auditModel() || null,
          auditorVariant: auditVariant() || null,
        }),
      })
      if (!res.ok) {
        setApplyError((await res.text().catch(() => '')) || `Failed (status ${res.status})`)
        return
      }
      setApplied(true)
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const modelSelect = (
    value: () => string,
    setValue: (v: string) => void,
    onModelChange: () => void,
  ) => html`<select
    class="live-model-select"
    onchange=${(e: Event) => {
      setValue((e.currentTarget as HTMLSelectElement).value)
      onModelChange()
    }}
  >
    <option value="" selected=${() => value() === ''}>default (config)</option>
    ${() => catalog().map(m => html`<option value=${m.id} selected=${() => value() === m.id}>${m.name + ' · ' + m.provider}</option>`)}
    ${() => (value() && !catalog().some(m => m.id === value())
      ? html`<option value=${value()} selected=${true}>${value()}</option>`
      : '')}
  </select>`

  const variantSelect = (
    modelId: () => string,
    value: () => string,
    setValue: (v: string) => void,
  ) => html`<select
    class="live-variant-select"
    disabled=${() => variantsFor(modelId()).length === 0}
    onchange=${(e: Event) => setValue((e.currentTarget as HTMLSelectElement).value)}
  >
    <option value="" selected=${() => value() === ''}>default</option>
    ${() => variantsFor(modelId()).map(v => html`<option value=${v.id} selected=${() => value() === v.id}>${v.label}</option>`)}
  </select>`

  return html`<div class="live-models">
    <button class="live-models-toggle" onclick=${() => setOpen(o => !o)}>
      <span class="live-models-caret">${() => (open() ? '▾' : '▸')}</span>
      <span>Models</span>
      <span class="live-models-summary">${() => (lp().executionModel ?? 'default') + ' · audit ' + (lp().auditorModel ?? 'default')}</span>
    </button>
    ${() => {
      if (!open()) return ''
      return html`<div class="live-models-body">
        ${() => (catalogError() ? html`<div class="live-models-error">${() => catalogError()}</div>` : '')}
        <label class="live-model-row">
          <span class="live-model-label">Execution</span>
          ${modelSelect(execModel, setExecModel, () => setExecVariant(''))}
          ${variantSelect(execModel, execVariant, setExecVariant)}
        </label>
        <label class="live-model-row">
          <span class="live-model-label">Auditor</span>
          ${modelSelect(auditModel, setAuditModel, () => setAuditVariant(''))}
          ${variantSelect(auditModel, auditVariant, setAuditVariant)}
        </label>
        <div class="live-model-actions">
          <span class="live-model-hint">Applies to the next prompt, not the turn in flight.</span>
          <button class="live-send" onclick=${() => void apply()} disabled=${() => applying()}>
            ${() => (applying() ? 'Applying…' : 'Apply')}
          </button>
        </div>
        ${() => (applyError() ? html`<div class="live-models-error">${() => applyError()}</div>` : '')}
        ${() => (applied() && !applyError() ? html`<div class="live-models-ok">Models updated.</div>` : '')}
      </div>`
    }}
  </div>`
}

// One tool call: what was run, and (on demand) what it printed. Output is
// collapsed by default so a long run of shell calls stays skimmable.
function LiveToolPart(props: { part: LivePart }) {
  const p = () => props.part
  const [open, setOpen] = createSignal(false)
  const hasOutput = () => !!p().output
  return html`<div class=${() => 'live-tool live-tool-' + (p().status ?? 'pending')}>
    <div
      class=${() => 'live-tool-head' + (hasOutput() ? ' live-tool-head-clickable' : '')}
      onclick=${() => { if (hasOutput()) setOpen(o => !o) }}
    >
      <span class="live-tool-caret">${() => (hasOutput() ? (open() ? '▾' : '▸') : '')}</span>
      <span class="live-tool-name">${() => p().tool ?? 'tool'}</span>
      <span class="live-tool-title">${() => p().title ?? ''}</span>
      <span class="live-tool-status">${() => p().status ?? 'pending'}</span>
    </div>
    ${() => (open() && hasOutput() ? html`<pre class="live-tool-output">${() => p().output}</pre>` : '')}
  </div>`
}

// ── LiveTabBody ───────────────────────────────────────────────────────────

/** How long after the last change the session still counts as working. */
const ACTIVITY_WINDOW_MS = 8000
/** Distance from the bottom that still counts as "following the output". */
const BOTTOM_SLACK_PX = 48

/** Tracks whether the browser tab itself is in the foreground. */
function createDocumentVisibility(): () => boolean {
  if (typeof document === 'undefined') return () => true
  const [visible, setVisible] = createSignal(document.visibilityState !== 'hidden')
  const onChange = () => setVisible(document.visibilityState !== 'hidden')
  document.addEventListener('visibilitychange', onChange)
  onCleanup(() => document.removeEventListener('visibilitychange', onChange))
  return visible
}

// A window onto the loop's current opencode session: the transcript as the
// host has it, kept current by the host's own events, plus a box to send the
// session a message. Nothing here is persisted, and the subscription only
// exists while the view is actually on screen — see `active` below.
function LiveTabBody(props: { dashLoop: DashboardLoop; visible: () => boolean }) {
  const dl = () => props.dashLoop
  const lp = () => dl().loop
  const [messages, setMessages] = createSignal<LiveMessage[]>([])
  const [connection, setConnection] = createSignal<'connecting' | 'live' | 'failed'>('connecting')
  const [failure, setFailure] = createSignal('')
  const [sessionStatus, setSessionStatus] = createSignal<string>('')
  const [draft, setDraft] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [sendError, setSendError] = createSignal('')
  // 'stream' while the host pushes events; 'poll' once the server had to
  // refresh the transcript itself, which means this loop is being driven by a
  // different opencode process than the one serving the dashboard.
  const [mode, setMode] = createSignal<'stream' | 'poll'>('stream')
  const [lastActivityAt, setLastActivityAt] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const documentVisible = createDocumentVisibility()
  // Tab bodies stay mounted once opened, so visibility — not mount state — is
  // what decides whether this session is worth a connection. A backgrounded
  // browser tab counts as hidden: neither the stream nor the server-side
  // transcript poll should run for a view nobody is looking at.
  const active = createMemo(() => props.visible() && documentVisible())

  // Drives the "working" indicator's decay; pointless while hidden.
  createEffect(() => {
    if (!active()) return
    const ticker = setInterval(() => setTick(t => t + 1), 1000)
    onCleanup(() => clearInterval(ticker))
  })

  const working = createMemo(() => {
    tick()
    if (sessionStatus() === 'busy') return true
    const at = lastActivityAt()
    return at > 0 && Date.now() - at < ACTIVITY_WINDOW_MS
  })

  const streamUrl = createMemo(() => {
    const params = new URLSearchParams({ project: lp().projectId, loop: lp().loopName })
    return '/api/loop/stream?' + params.toString()
  })

  // Opens only while on screen, and re-subscribes when the loop rotates to a
  // new session: the stream is bound to the session current at open time.
  let shownSessionId = ''
  createEffect(() => {
    const sessionId = lp().currentSessionId
    const url = streamUrl()
    if (!active() || !sessionId || typeof EventSource === 'undefined') return
    // Returning to the same session keeps the rows on screen until the fresh
    // snapshot lands; a different session starts clean.
    if (sessionId !== shownSessionId) {
      shownSessionId = sessionId
      setMessages([])
    }
    setConnection('connecting')
    setFailure('')
    setMode('stream')
    setLastActivityAt(0)
    const source = new EventSource(url)
    source.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { messages?: unknown; reason?: string }
        const next = snapshotToLiveMessages(payload.messages)
        setMessages(next)
        setConnection('live')
        // A polled snapshot only arrives when content changed without an event.
        if (payload.reason === 'poll') {
          setMode('poll')
          setLastActivityAt(Date.now())
        }
      } catch {
        setConnection('failed')
        setFailure('Could not read the transcript snapshot.')
      }
    })
    source.addEventListener('event', (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data)
        setMessages(current => applyLiveEvent(current, event))
        setMode('stream')
        setLastActivityAt(Date.now())
        const status = liveStatusFromEvent(event)
        if (status) setSessionStatus(status)
      } catch {
        // A malformed frame is not worth tearing the view down for.
      }
    })
    source.addEventListener('failed', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { message?: string }
        setFailure(payload.message ?? 'Live stream ended.')
      } catch {
        setFailure('Live stream ended.')
      }
      setConnection('failed')
    })
    source.onerror = () => {
      // EventSource reconnects on its own; only report a hard failure.
      if (source.readyState === EventSource.CLOSED) setConnection('failed')
    }
    onCleanup(() => source.close())
  })

  const send = async () => {
    const text = draft().trim()
    if (!text || sending()) return
    setSending(true)
    setSendError('')
    try {
      const res = await fetch('/api/loop/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: lp().projectId, loopName: lp().loopName, text }),
      })
      if (!res.ok) {
        setSendError((await res.text().catch(() => '')) || `Failed (status ${res.status})`)
        return
      }
      setDraft('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const statusLabel = createMemo(() => {
    if (connection() === 'connecting') return 'connecting'
    if (connection() === 'failed') return 'disconnected'
    if (working()) return mode() === 'poll' ? 'working (refreshing)' : 'working'
    return mode() === 'poll' ? 'refreshing' : (sessionStatus() || 'idle')
  })

  const dotClass = createMemo(() => {
    if (connection() !== 'live') return 'live-dot live-dot-' + connection()
    if (working()) return 'live-dot live-dot-working'
    return 'live-dot live-dot-idle'
  })

  // Keep the newest output in view, but yield to a reader who scrolled up.
  const transcript = html`<div class="live-transcript">
    ${() => {
      const rows = messages()
      if (rows.length === 0) {
        return html`<div class="tab-empty">${() => (connection() === 'live' ? 'No messages in this session yet.' : 'Loading session…')}</div>`
      }
      return rows.map(m => html`<div class=${'live-msg live-msg-' + m.role}>
        <div class="live-msg-role">${m.role}</div>
        <div class="live-msg-body">
          ${() => m.parts.map(p => (p.type === 'text'
            ? html`<div class="live-text">${p.text ?? ''}</div>`
            : LiveToolPart({ part: p })))}
        </div>
      </div>`)
    }}
  </div>` as HTMLElement

  const [pinned, setPinned] = createSignal(true)
  const atBottom = (el: HTMLElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX
  transcript.addEventListener('scroll', () => setPinned(atBottom(transcript)))
  createEffect(() => {
    messages()
    if (!pinned()) return
    // After the rows for this update have been written to the DOM.
    queueMicrotask(() => { transcript.scrollTop = transcript.scrollHeight })
  })

  return html`<div class="live-tab">
    <div class="live-head">
      <span class=${() => dotClass()}></span>
      <span class="live-status">${() => statusLabel()}</span>
      ${() => (mode() === 'poll'
        ? html`<span class="live-mode-note" title="This loop is running in a different opencode process, so its events never reach this server. The transcript is being re-read instead.">events unavailable — refreshing every 4s</span>`
        : '')}
      <span class="live-session">${() => lp().currentSessionId}</span>
    </div>

    ${() => (failure() ? html`<div class="live-failure">${() => failure()}</div>` : '')}

    ${LiveModelControls({ dashLoop: props.dashLoop })}

    ${transcript}

    ${() => (pinned() ? '' : html`<button class="live-jump" onclick=${() => {
      transcript.scrollTop = transcript.scrollHeight
      setPinned(true)
    }}>Jump to latest ↓</button>`)}

    <div class="live-composer">
      <textarea
        class="live-input"
        rows="2"
        placeholder="Send a message to this session…"
        value=${() => draft()}
        oninput=${(e: Event) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        onkeydown=${(e: KeyboardEvent) => {
          if (e.key !== 'Enter' || e.shiftKey) return
          e.preventDefault()
          void send()
        }}
      ></textarea>
      <button
        class="live-send"
        onclick=${() => void send()}
        disabled=${() => sending() || draft().trim().length === 0}
      >${() => (sending() ? 'Sending…' : 'Send')}</button>
    </div>
    ${() => (sendError() ? html`<div class="live-send-error">${() => sendError()}</div>` : '')}
  </div>`
}

function buildTabBody(props: {
  tab: LoopTab
  dashLoop: DashboardLoop
  split: () => Split
  now: () => number
  onSelectTab: (t: LoopTab) => void
}, visible: () => boolean): Node {
  switch (props.tab) {
    case 'overview': return OverviewTabBody({ dashLoop: props.dashLoop, split: props.split, now: props.now, onSelectTab: props.onSelectTab }) as Node
    case 'live': return LiveTabBody({ dashLoop: props.dashLoop, visible }) as Node
    case 'timeline': return TimelineTabBody({ dashLoop: props.dashLoop, now: props.now }) as Node
    case 'sections': return SectionsTabBody({ dashLoop: props.dashLoop }) as Node
    case 'findings': return FindingsTabBody({ dashLoop: props.dashLoop }) as Node
    case 'plan': return PlanTabBody({ dashLoop: props.dashLoop }) as Node
    case 'usage': return UsageTabBody({ dashLoop: props.dashLoop }) as Node
  }
}

// Tab bodies are built lazily on first activation but never torn down: opening
// a loop no longer parses every tab's markdown or builds the machine graph up
// front, while a tab that has been opened keeps its DOM (scroll, collapse, and
// resize state) for the lifetime of the selected loop. `runWithOwner` is
// required — building inside the effect's own computation would attach the
// subtree's memos to an owner that is disposed on the effect's next run.
function TabBody(props: {
  tab: LoopTab
  dashLoop: DashboardLoop
  split: () => Split
  now: () => number
  tabs: () => LoopTab[]
  activeTab: () => LoopTab
  onSelectTab: (t: LoopTab) => void
}) {
  const visible = createMemo(() => props.tabs().includes(props.tab) && props.activeTab() === props.tab)
  const owner = getOwner()
  const host = html`<div class="tab-body" data-tab="${props.tab}" style=${() => visible() ? 'display:block' : 'display:none'}></div>` as HTMLElement
  let built = false
  createEffect(() => {
    if (!visible() || built) return
    built = true
    const node = runWithOwner(owner, () => buildTabBody(props, visible))
    if (node) host.appendChild(node)
  })
  return host
}

function LoopDetailTabs(props: {
  dashLoop: DashboardLoop
  split: () => Split
  now: () => number
  tabs: () => LoopTab[]
  activeTab: () => LoopTab
  onSelectTab: (t: LoopTab) => void
}) {
  return html`<div class="tab-bodies">
    ${ALL_TABS.map((t: LoopTab) => TabBody({
      tab: t,
      dashLoop: props.dashLoop,
      split: props.split,
      now: props.now,
      tabs: props.tabs,
      activeTab: props.activeTab,
      onSelectTab: props.onSelectTab,
    }))}
  </div>`
}

export function LoopDetail(props: {
  dashLoop: DashboardLoop
  now: () => number
  routeTab: () => LoopTab
  onSelectTab: (t: LoopTab) => void
}) {
  const dl = () => props.dashLoop
  const split = createMemo(() => splitFindings(dl().findings))
  const tabs = createMemo(() => tabsForLoop(dl()))
  const activeTab = createMemo(() => {
    const t = props.routeTab()
    return tabs().includes(t) ? t : 'overview'
  })

  return html`<div class="loop">
    <div class="loop-detail">
      ${TabBar({ tabs, activeTab, onSelect: props.onSelectTab })}
      ${LoopDetailTabs({ dashLoop: props.dashLoop, split, now: props.now, tabs, activeTab, onSelectTab: props.onSelectTab })}
    </div>
  </div>`
}

// ── EmptyState ────────────────────────────────────────────────────────────

export function EmptyState() {
  return html`<div class="empty-state">No loops match the current filters.</div>`
}

const TERMINAL_GROUP_STATUSES = new Set(['completed', 'cancelled', 'errored'])

function groupFeaturesMeter(features: GroupFeatureRow[]): { completed: number; total: number } {
  const total = features.length
  const completed = features.filter(f => f.stage === 'completed').length
  return { completed, total }
}

function groupStatusClass(base: 'group-row' | 'group-header', status: string): string {
  const terminal = TERMINAL_GROUP_STATUSES.has(status)
  return base + (terminal ? ` ${base}-terminal` : ` ${base}-active`)
}

export function GroupsPanel(props: {
  groups: () => DashboardGroup[]
  onOpen: (groupId: string) => void
}) {
  return html`<div class="groups-panel">
    <h4>Groups</h4>
    ${() => {
      const groups = props.groups()
      if (groups.length === 0) return html`<div class="tab-empty">No feature groups for this repo.</div>`
      return html`<div class="groups-list">
        ${groups.map(g => {
          const gr = g.group
          const meter = createMemo(() => groupFeaturesMeter(g.features))
          return html`<div class=${() => groupStatusClass('group-row', gr.status)} data-group-status=${() => gr.status} onclick=${() => props.onOpen(gr.groupId)}>
            <span class=${() => statusClass(gr.status)}>${() => gr.status}</span>
            <span class="group-row-title">${() => gr.title}</span>
            ${MiniMeter({ current: () => meter().completed, total: () => meter().total })}
            <span class="group-row-meta">max ${() => gr.maxConcurrent}</span>
            <span class="group-row-time">
              <span class="group-row-created">Created ${() => fmtTime(gr.createdAt)}</span>
              ${() => (gr.completedAt ? html`<span class="group-row-completed">Completed ${() => fmtTime(gr.completedAt)}</span>` : '')}
            </span>
          </div>`
        })}
      </div>`
    }}
  </div>`
}

export function GroupDetail(props: {
  group: () => DashboardGroup | null
  loopNames: () => Set<string>
  projectId: () => string | null
  onBack: () => void
  onOpenLoop: (loopName: string) => void
}) {
  return html`<div class="group-detail">
    <div class="back-to-groups" onclick=${props.onBack}>← Back to groups</div>
    ${() => {
      const dg = props.group()
      if (!dg) return html`<div class="tab-empty">Group not found.</div>`
      const gr = dg.group
      const meter = createMemo(() => groupFeaturesMeter(dg.features))
      // Single root element: solid-js/html generates invalid code for a
      // template whose top level is a fragment of sibling roots.
      return html`<div class="group-detail-body">
        <div class=${() => groupStatusClass('group-header', gr.status)} data-group-status=${() => gr.status}>
          <div class="group-header-top">
            <span class=${() => statusClass(gr.status)}>${() => gr.status}</span>
            <h3 class="group-header-title">${() => gr.title}</h3>
            <span class="group-header-meta">max ${() => gr.maxConcurrent}</span>
          </div>
          <div class="group-header-stats">
            <span class="group-header-stat">${() => 'Features ' + meter().completed + '/' + meter().total}</span>
            <span class="group-header-stat">Created ${() => fmtTime(gr.createdAt)}</span>
            ${() => (gr.completedAt ? html`<span class="group-header-stat">Completed ${() => fmtTime(gr.completedAt)}</span>` : '')}
            ${() => (gr.error ? html`<span class="group-header-error">${() => gr.error}</span>` : '')}
          </div>
          ${() => (gr.prdPreview ? html`<div class="markdown-section">
            <div class="markdown-heading-row"><h4 class="section-label">PRD preview</h4></div>
            <pre class="prd-preview">${() => gr.prdPreview || ''}</pre>
          </div>` : '')}
        </div>
        <div class="features-list">
          ${dg.features.map(f => html`<div class="feature-row" data-stage=${() => f.stage}>
            <span class="feature-index">#${() => f.featureIndex}</span>
            <span class="feature-title">${() => f.title}</span>
            <span class=${() => featureStageClass(f.stage)}>${() => f.stage}</span>
            <span class="feature-attempts">${() => f.attempts} attempts</span>
            ${() => (!!f.loopName && props.loopNames().has(f.loopName)
              ? LoopLink({ className: 'feature-loop-link', projectId: props.projectId, loopName: f.loopName, onOpen: props.onOpenLoop })
              : '')}
            ${() => (f.error ? html`<span class="feature-error">${() => f.error}</span>` : '')}
          </div>`)}
        </div>
      </div>`
    }}
  </div>`
}

function findingsGroupsForLoops(
  loops: DashboardLoop[],
  max: number,
  showAll: boolean,
): { groups: Array<{ loopName: string; rows: DashboardLoop['findings'] }>; total: number; capped: boolean } {
  const groups: Array<{ loopName: string; rows: DashboardLoop['findings'] }> = []
  let total = 0
  let budget = showAll ? Infinity : max
  for (const dl of loops) {
    if (dl.findings.length === 0) continue
    total += dl.findings.length
    if (budget <= 0) continue
    const take = Math.min(budget, dl.findings.length)
    groups.push({ loopName: dl.loop.loopName, rows: dl.findings.slice(0, take) })
    budget -= take
  }
  return { groups, total, capped: !showAll && total > max }
}

export function FindingsPanel(props: {
  loops: () => DashboardLoop[]
  projectId: () => string | null
  onOpenLoop: (loopName: string) => void
}) {
  const [showAll, setShowAll] = createSignal(false)
  const groups = createMemo(() => findingsGroupsForLoops(props.loops(), MAX_RENDERED_FINDING_ROWS, showAll()))
  return html`<div class="findings-panel">
    <h4>Findings <span class="findings-panel-count">${() => groups().total}</span></h4>
    ${() => (groups().capped
      ? ListCapNotice({ shown: () => groups().groups.reduce((acc, g) => acc + g.rows.length, 0), total: () => groups().total, noun: 'findings', onShowAll: () => setShowAll(true) })
      : '')}
    ${() => {
      const gs = groups().groups
      if (gs.length === 0) return html`<div class="tab-empty">No findings recorded for this repo.</div>`
      return html`<div class="findings-panel-list">
        ${gs.map(g => html`<div class="findings-loop-block" data-loop=${() => g.loopName}>
          <div class="findings-loop-head">
            ${LoopLink({ className: 'findings-loop-link', projectId: props.projectId, loopName: g.loopName, onOpen: props.onOpenLoop })}
            <span class="findings-loop-meta">${() => g.rows.length}</span>
          </div>
          ${FindingRows({ rows: g.rows })}
        </div>`)}
      </div>`
    }}
  </div>`
}

export function PlansPanel(props: {
  loops: () => DashboardLoop[]
  onOpenLoop: (loopName: string) => void
}) {
  const [showAll, setShowAll] = createSignal(false)
  const planLoops = createMemo(() => props.loops().filter(dl => dl.hasPlan))
  const view = createMemo(() => capList(planLoops(), MAX_RENDERED_LOOP_ROWS, showAll()))
  return html`<div class="plans-panel">
    <h4>Plans <span class="plans-panel-count">${() => view().total}</span></h4>
    ${() => (view().capped
      ? ListCapNotice({ shown: () => view().rows.length, total: () => view().total, noun: 'plans', onShowAll: () => setShowAll(true) })
      : '')}
    ${() => {
      const list = view().rows
      if (list.length === 0) return html`<div class="tab-empty">No plans recorded for this repo.</div>`
      return html`<div class="plans-list">
        ${list.map(dl => html`<div class="plan-row" onclick=${() => props.onOpenLoop(dl.loop.loopName)}>
          <span class=${() => statusClass(dl.loop.status)}>${() => dl.loop.status}</span>
          <span class="plan-row-name">${() => dl.loop.loopName}</span>
          <span class="plan-row-meta">
            ${() => formatFindingCount(dl.findings.length, 'finding')}
          </span>
          <span class="plan-row-iter">iter ${() => dl.loop.iteration}/${() => dl.loop.maxIterations}</span>
        </div>`)}
      </div>`
    }}
  </div>`
}
