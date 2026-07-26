import html from 'solid-js/html'
import { createMemo, createSignal, createEffect, onCleanup, untrack } from 'solid-js'
import type { DashboardLoop, DashboardProject, DashboardGroup } from './types'
import type { GroupFeatureRow } from '../../storage'
import type { RepoSection, SortMode } from './helpers'
import {
  statusClass,
  sectionStatusClass,
  fmtTime,
  formatSectionDuration,
  splitFindings,
  findingsLevel,
  formatFindingCount,
  clampPercent,
  formatFinding,
  formatModelUsage,
  formatTokenCount,
  formatUsageCost,
  tokenBreakdownSegments,
  modelUsageBars,
  roleUsageBars,
  renderMarkdown,
  formatRelativeTime,
  tabsForLoop,
  computePhaseSpans,
  summarizePhaseTotals,
  computeTimelineEvents,
  buildDashboardHash,
} from './helpers'
import type { LoopTab, PhaseSpan } from './helpers'
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

export function Timestamp(props: { generatedAt: number }) {
  return html`<div class="timestamp">Last updated: ${new Date(props.generatedAt).toLocaleString()}</div>`
}

export function RepoMenu(props: {
  entries: () => MatchedEntry[]
  labels: () => Map<string, string>
  onSelect: (projectId: string) => void
}) {
  const items = createMemo(() =>
    props.entries().map((entry: MatchedEntry) => {
      const hasRunning = entry.loops.some(dl => dl.loop.status === 'running')
      const rawPath = entry.proj.projectDir || entry.proj.projectId || ''
      const label = props.labels().get(rawPath) ?? rawPath
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
    const rawPath = entry.proj.projectDir || entry.proj.projectId || ''
    const label = labels.get(rawPath) ?? rawPath
    for (const dl of entry.loops) {
      loopCount++
      for (const f of dl.findings) if (f.severity === 'bug') bugCount++
      const status = dl.loop.status
      const when = dl.loop.completedAt || dl.loop.startedAt || 0
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
              <span class="repo-running-dot"></span>
              <span class="repo-running-label">${c.label}</span>
              <span class="repo-running-name">${c.loopName}</span>
              <span class="repo-running-phase">${c.phase}</span>
            </div>`)}
          </div>
        </div>`
      : '')}
    ${() => (recentRows().length > 0
      ? html`<div class="repo-index-section">
          <h3 class="repo-index-section-title">Recent activity</h3>
          <div class="repo-recent-list">
            ${recentRows().map(r => html`<div class="repo-recent-row" onclick=${() => props.onOpenLoop(r.projectId, r.loopName)}>
              <span class=${() => 'status-badge status-' + r.status}>${r.status}</span>
              <span class="repo-recent-label">${r.label}</span>
              <span class="repo-recent-name">${r.loopName}</span>
              <span class="repo-recent-when">${fmtTime(r.when)}</span>
            </div>`)}
          </div>
        </div>`
      : '')}
  </div>`
}

export type LoopOption = { name: string; when: number }

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

  const openMenu = () => {
    if (open()) return
    setQuery('')
    const idx = props.loops().findIndex(o => o.name === props.loopName)
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
    ${() => matches().map((o, i) => html`<div
      class=${() => 'loop-picker-option'
        + (i === active() ? ' loop-picker-option-active' : '')
        + (o.name === props.loopName ? ' loop-picker-option-current' : '')}
      onclick=${() => commit(o.name)}
    >
      <span class="loop-picker-option-name" title=${o.name}>${o.name}</span>
      <span class="loop-picker-option-when">${fmtTime(o.when)}</span>
    </div>`)}
    ${() => (matches().length === 0 ? html`<div class="loop-picker-empty">No matching loops</div>` : '')}
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
      const total = matches().length
      if (total === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => (i + delta + total) % total)
      scrollActiveIntoView()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = matches()[active()]
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

function MiniMeter(props: { current: () => number; total: () => number }) {
  const pct = () => clampPercent(props.current(), props.total())
  return html`<span class="lt-meter-cell">
    <span class="lt-meter"><span class="lt-meter-fill" style=${() => 'width:' + pct() + '%'}></span></span>
    <span class="lt-meter-text">${() => props.current()}/${() => props.total()}</span>
  </span>`
}

type PhaseBarVariant = 'sm' | 'md' | 'lg'

const PHASE_BAR_HEIGHTS: Record<PhaseBarVariant, number> = { sm: 4, md: 14, lg: 22 }

function PhaseBar(props: {
  spans: () => PhaseSpan[]
  variant: PhaseBarVariant
  now: () => number
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
        return html`<div class=${cls} data-phase=${sp.phase} style=${'width:' + pct + '%'}></div>`
      })
    }}
  </div>`
}

function loopPhaseSpans(loop: DashboardLoop, now: number): PhaseSpan[] {
  return computePhaseSpans(
    loop.transitions ?? [],
    loop.loop.startedAt,
    loop.loop.completedAt,
    now,
    loop.loop.phase,
  ).spans
}

export function LoopTable(props: { loops: () => DashboardLoop[]; now: () => number; onOpen: (name: string) => void }) {
  return html`<table class="loop-table">
    <thead><tr>
      <th>Status</th><th>Loop</th><th>Phase</th><th>Phase span</th><th>Iter</th><th>Sections</th>
      <th>Findings</th><th>Cost</th><th>Duration</th><th>Updated</th>
    </tr></thead>
    <tbody>
      ${() => props.loops().map((dl: DashboardLoop) => LoopTableRow({ dashLoop: dl, now: props.now, onOpen: props.onOpen }))}
    </tbody>
  </table>`
}

function LoopTableRow(props: { dashLoop: DashboardLoop; now: () => number; onOpen: (name: string) => void }) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const counts = createMemo(() => splitFindings(dl().findings))
  const spans = createMemo(() => loopPhaseSpans(dl(), props.now()))
  return html`<tr class="lt-row" onclick=${() => props.onOpen(props.dashLoop.loop.loopName)}>
    <td><span class=${() => statusClass(lp().status)}>${() => lp().status}</span></td>
    <td class="lt-name">${() => lp().loopName}</td>
    <td class="lt-phase">${() => lp().phase}</td>
    <td class="lt-phase-bar">${() => PhaseBar({ spans, variant: 'sm', now: props.now })}</td>
    <td>${MiniMeter({ current: () => lp().iteration, total: () => lp().maxIterations })}</td>
    <td>${() => (lp().totalSections > 0
      ? MiniMeter({ current: () => lp().currentSectionIndex, total: () => lp().totalSections })
      : html`<span class="dim">—</span>`)}</td>
    <td class="lt-findings">${() => {
      const c = counts()
      if (c.bugs.length === 0 && c.warnings.length === 0) return html`<span class="dim">—</span>`
      return html`<span>
        ${c.bugs.length > 0 ? html`<span class="finding-bug">${formatFindingCount(c.bugs.length, 'bug')}</span>` : ''}
        ${c.bugs.length > 0 && c.warnings.length > 0 ? ' · ' : ''}
        ${c.warnings.length > 0 ? html`<span class="finding-warning">${c.warnings.length} warn</span>` : ''}
      </span>`
    }}</td>
    <td class="lt-cost">${() => (dl().usage ? formatUsageCost(dl().usage!.totalCost) : html`<span class="dim">—</span>`)}</td>
    <td class="lt-duration">${() => dl().duration || ''}</td>
    <td class="lt-updated">${() => fmtTime(lp().completedAt || lp().startedAt)}</td>
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
      <div class="markdown-content" innerHTML=${() => renderMarkdown(props.src() || '')}></div>
    </div>
  </div>`
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
function SectionListRow(props: { sec: DashboardSection; onOpen: () => void }) {
  const sec = props.sec
  const duration = createMemo(() => formatSectionDuration(sec.startedAt, sec.completedAt))
  return html`<div class=${() => 'section-list-row section-item-' + sec.status} onclick=${props.onOpen}>
    <span class="section-index">#${sec.sectionIndex}</span>
    <span class="section-title">${() => sec.title}</span>
    <span class=${() => sectionStatusClass(sec.status)}>${() => sec.status}</span>
    ${() => (duration() ? html`<span class="section-duration">${() => duration()}</span>` : '')}
    ${() => (sec.attempts > 0 ? html`<span class="section-attempts">${() => sec.attempts} attempts</span>` : '')}
    <span class="section-caret">▸</span>
  </div>`
}

// Owns a selectedIndex signal; selecting shows a back link + the section title +
// reused SectionBody; deselected shows the list. Persistence: current() returns
// the same store proxy across polls, so the selected branch's thunk does not
// re-run and SectionBody (its .markdown-body) is not rebuilt.
function SectionsPanel(props: { sections: () => DashboardSection[] }) {
  const [selected, setSelected] = createSignal<number | null>(null)
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
            <span class="section-index">#${sec.sectionIndex}</span>
            <span class="section-title">${() => sec.title}</span>
            <span class=${() => sectionStatusClass(sec.status)}>${() => sec.status}</span>
          </div>
          ${SectionBody({ sec })}
        </div>`
      }
      return html`<div class="section-list">
        ${props.sections().map((s: DashboardSection) =>
          SectionListRow({ sec: s, onOpen: () => setSelected(s.sectionIndex) }))}
      </div>`
    }}
  </div>`
}

// ── LoopDetailHeader ──────────────────────────────────────────────────────

// A labeled stat cell (label above value). The value is read through an
// accessor so it updates in place on polls without rebuilding the cell.
function LoopDetailStat(props: { label: string; value: () => string }) {
  return html`<div class="ldh-stat">
    <span class="ldh-stat-label">${props.label}</span>
    <span class="ldh-stat-value">${() => props.value()}</span>
  </div>`
}

// A progress bar with a count, clamped to 0–100%. Both current and total are
// accessors so the fill width tracks live loop updates.
function LoopDetailProgress(props: { label: string; current: () => number; total: () => number }) {
  const pct = () => clampPercent(props.current(), props.total())
  return html`<div class="ldh-bar-group">
    <div class="ldh-bar-head">
      <span class="ldh-bar-label">${props.label}</span>
      <span class="ldh-bar-count">${() => props.current()} / ${() => props.total()}</span>
    </div>
    <div class="ldh-bar-track">
      <div class="ldh-bar-fill" style=${() => 'width:' + pct() + '%'}></div>
    </div>
  </div>`
}

// Structured replacement for the cramped single-line summary: a status/name
// title row, a labeled stat grid, iteration/section progress bars, and a
// status-tinted outcome banner. Built once per selected loop; every dynamic
// field is read reactively so it updates in place on polls.
function LoopDetailHeader(props: {
  dashLoop: DashboardLoop
  split: () => { bugs: DashboardLoop['findings']; warnings: DashboardLoop['findings'] }
}) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const hasCompletedAt = createMemo(() => !!lp().completedAt)
  const hasDuration = createMemo(() => !!dl().duration)
  const hasSectionsTotal = createMemo(() => lp().totalSections > 0)
  const hasReason = createMemo(() => !!lp().terminationReason)
  const level = createMemo(() => findingsLevel(props.split()))
  const hasUsage = createMemo(() => !!props.dashLoop.usage)

  return html`<div class="loop-detail-header">
    <div class=${() => 'ldh-findings ldh-findings-' + level()}>
      ${() => {
        const s = props.split()
        if (s.bugs.length === 0 && s.warnings.length === 0) return 'No findings'
        const parts = []
        if (s.bugs.length > 0) parts.push(formatFindingCount(s.bugs.length, 'bug'))
        if (s.warnings.length > 0) parts.push(formatFindingCount(s.warnings.length, 'warning'))
        return parts.join(' · ')
      }}
    </div>
    <div class="ldh-top">
      <span class=${() => statusClass(lp().status)}>${() => lp().status}</span>
      <h3 class="ldh-name">${() => lp().loopName}</h3>
      <span class="ldh-phase">${() => lp().phase}</span>
    </div>

    <div class="ldh-stats">
      ${LoopDetailStat({ label: 'Started', value: () => fmtTime(lp().startedAt) })}
      ${() => (hasCompletedAt() ? LoopDetailStat({ label: 'Completed', value: () => fmtTime(lp().completedAt) }) : '')}
      ${() => (hasDuration() ? LoopDetailStat({ label: 'Duration', value: () => dl().duration || '' }) : '')}
      ${LoopDetailStat({ label: 'Iteration', value: () => lp().iteration + ' / ' + lp().maxIterations })}
      ${() => (hasSectionsTotal() ? LoopDetailStat({ label: 'Section', value: () => lp().currentSectionIndex + ' / ' + lp().totalSections }) : '')}
      ${() => (hasUsage() ? LoopDetailStat({ label: 'Messages', value: () => String(props.dashLoop.usage!.totalMessageCount) }) : '')}
    </div>

    <div class="ldh-bars">
      ${LoopDetailProgress({ label: 'Iterations', current: () => lp().iteration, total: () => lp().maxIterations })}
      ${() =>
        hasSectionsTotal()
          ? LoopDetailProgress({ label: 'Sections', current: () => lp().currentSectionIndex, total: () => lp().totalSections })
          : ''}
    </div>

    ${() =>
      hasReason()
        ? html`<div class=${() => 'ldh-banner ldh-banner-' + lp().status}>${() => lp().terminationReason}</div>`
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
          <div class="usage-model-meta">${() => r.messageCount + ' msg'}</div>
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
      <div class="usage-legend">
        ${() =>
          segments().map(
            seg => html`<div class="usage-legend-item">
              <span class="usage-legend-dot" style=${'background:' + seg.color}></span>
              <span class="usage-legend-label">${seg.label}</span>
              <span class="usage-legend-value">${formatTokenCount(seg.value)}</span>
            </div>`,
          )}
      </div>
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

function parseJsonSections(raw: string): Array<{ index: number; title: string }> {
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function formatSectionTitle(sec: { index: number; title: string }): string {
  return '#' + sec.index + ' ' + sec.title
}

// A single amendment row with an expand/collapse toggle. Expandable body shows
// the parsed before/after section titles.
function AmendmentRow(props: {
  amendment: NonNullable<DashboardLoop['amendments']>[number]
  expanded: () => boolean
  onToggle: () => void
}) {
  const a = props.amendment
  const before = createMemo(() => parseJsonSections(a.sectionsBefore))
  const after = createMemo(() => parseJsonSections(a.sectionsAfter))

  return html`<div class="amendment-row">
    <div class="amendment-head" onclick=${props.onToggle}>
      <span class="amendment-time">${() => formatRelativeTime(a.createdAt)}</span>
      <span class="amendment-section">applied @ section ${() => a.appliedAtSection}</span>
      <span class="amendment-source">${() => a.source}</span>
      <span class="amendment-rationale">${() => a.rationale}</span>
      <span class="amendment-caret">${() => (props.expanded() ? '▾' : '▸')}</span>
    </div>
    <div class="amendment-body" style=${() => props.expanded() ? 'display:block' : 'display:none'}>
      <div class="amendment-diff">
        ${() => (before().length > 0
          ? html`<div class="amendment-diff-before">
              <div class="amendment-diff-label">Before</div>
              ${() => before().map(s => html`<div class="amendment-diff-item">${() => formatSectionTitle(s)}</div>`) }
            </div>`
          : '')}
        ${() => (after().length > 0
          ? html`<div class="amendment-diff-after">
              <div class="amendment-diff-label">After</div>
              ${() => after().map(s => html`<div class="amendment-diff-item">${() => formatSectionTitle(s)}</div>`) }
            </div>`
          : '')}
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

const ALL_TABS: LoopTab[] = ['overview', 'timeline', 'sections', 'findings', 'plan', 'usage']

const TAB_LABELS: Record<LoopTab, string> = {
  overview: 'Overview',
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

function OverviewMetaCell(props: { label: string; value: () => string | null | undefined }) {
  return html`<div class="overview-meta-cell">
    <span class="overview-meta-label">${props.label}</span>
    <span class="overview-meta-value">${() => props.value() ?? '—'}</span>
  </div>`
}

function OverviewTabBody(props: { dashLoop: DashboardLoop; split: () => Split; now: () => number }) {
  const dl = () => props.dashLoop
  const lp = () => dl().loop
  const split = () => props.split()
  const hasGoal = createMemo(() => !!dl().goal)
  const hasBugs = createMemo(() => split().bugs.length > 0)
  const hasWarnings = createMemo(() => split().warnings.length > 0)
  const hasFindings = createMemo(() => hasBugs() || hasWarnings())
  const reportSrc = createMemo(() => dl().postActionReport ?? lp().completionSummary ?? null)
  const reportLabel = createMemo(() => dl().postActionReport ? 'Post-Action Report' : 'Completion Summary')
  const hasReport = createMemo(() => !!reportSrc())
  const hasAudit = createMemo(() => !!dl().lastAuditResult)
  const phaseState = createMemo(() =>
    computePhaseSpans(dl().transitions ?? [], lp().startedAt, lp().completedAt, props.now(), lp().phase),
  )
  return html`<div class="overview-tab">
    ${() => PhaseBar({ spans: () => phaseState().spans, variant: 'md', now: props.now })}
    ${() => (hasGoal() ? MarkdownSection({ label: 'Goal', src: () => dl().goal }) : '')}
    ${LoopDetailHeader({ dashLoop: props.dashLoop, split: props.split })}
    <div class="overview-meta">
      ${OverviewMetaCell({ label: 'Execution model', value: () => lp().executionModel })}
      ${OverviewMetaCell({ label: 'Auditor model', value: () => lp().auditorModel })}
      ${OverviewMetaCell({ label: 'Branch', value: () => lp().worktreeBranch })}
      ${OverviewMetaCell({ label: 'Sandbox', value: () => (lp().sandbox ? 'on' : 'off') })}
      ${OverviewMetaCell({ label: 'Kind', value: () => lp().kind })}
      ${OverviewMetaCell({ label: 'Audits', value: () => String(lp().auditCount) })}
      ${OverviewMetaCell({ label: 'Errors', value: () => String(lp().errorCount) })}
    </div>
    <div class="overview-findings">
      ${() => (hasFindings()
        ? html`<div class="overview-chip-row">
            ${() => (hasBugs() ? html`<span class="overview-chip overview-chip-bug">${() => formatFindingCount(split().bugs.length, 'bug')}</span>` : '')}
            ${() => (hasWarnings() ? html`<span class="overview-chip overview-chip-warning">${() => formatFindingCount(split().warnings.length, 'warning')}</span>` : '')}
          </div>`
        : html`<span class="overview-chip overview-chip-clean">No findings</span>`)}
    </div>
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
    <span class="tl-event-flow">${t.fromPhase} → ${flowTarget}</span>
    <span class="tl-event-kind">${t.transitionKind}</span>
    <span class="tl-event-iter">iter ${t.iteration}</span>
    <span class="tl-event-section">${() => (t.sectionIndex === null ? '—' : 'sect ' + (t.sectionIndex + 1))}</span>
    <span class="tl-event-elapsed">${() => (elapsedSec === null ? '—' : elapsedSec > 0 ? formatDuration(elapsedSec) : '0s')}</span>
  </div>`
}

function TimelineTabBody(props: { dashLoop: DashboardLoop; now: () => number }) {
  const dl = () => props.dashLoop
  const lp = () => dl().loop
  const transitions = () => dl().transitions ?? []
  const phaseState = createMemo(() =>
    computePhaseSpans(transitions(), lp().startedAt, lp().completedAt, props.now(), lp().phase),
  )
  const spans = createMemo(() => phaseState().spans)
  const truncated = createMemo(() => phaseState().truncated)
  const totals = createMemo(() => summarizePhaseTotals(spans()))
  const totalMs = createMemo(() => spans().filter(s => s.phase !== '').reduce((acc, s) => acc + s.durationMs, 0))

  const sortedPhases = createMemo(() => {
    const t = totals()
    return Object.keys(t)
      .filter(p => p !== '')
      .sort((a, b) => t[b] - t[a])
  })

  const eventsNewestFirst = createMemo(() =>
    computeTimelineEvents(transitions(), lp().startedAt, truncated()),
  )

  const [showAll, setShowAll] = createSignal(false)
  const visibleEvents = createMemo(() => {
    const all = eventsNewestFirst()
    return showAll() ? all : all.slice(0, 20)
  })
  const hiddenCount = createMemo(() => (showAll() ? 0 : Math.max(0, eventsNewestFirst().length - 20)))

  return html`<div class="timeline-tab timeline-graph">
    ${LoopMachineGraph({ loop: () => lp(), transitions })}
    ${() => PhaseBar({ spans, variant: 'lg', now: props.now })}
    ${() => (truncated()
      ? html`<div class="phase-truncated">Earlier history was truncated by the 100-row fetch window.</div>`
      : '')}

    <div class="phase-totals">
      ${() =>
        sortedPhases().map(phase => {
          const ms = totals()[phase]
          const pct = totalMs() > 0 ? Math.round((ms / totalMs()) * 100) : 0
          return html`<div class="phase-totals-row">
            <span class="phase-totals-label">
              <span class="phase-totals-dot" data-phase=${phase}></span>${phase}
            </span>
            <span class="phase-totals-value">${() => (ms >= 1000 ? formatDuration(Math.floor(ms / 1000)) : ms + 'ms')} · ${pct}%</span>
          </div>`
        })}
    </div>

    <div class="timeline-events">
      ${() => visibleEvents().map(ev => TimelineEventRow({ ev }))}
      ${() => (hiddenCount() > 0
        ? html`<div class="tl-event-expand" onclick=${() => setShowAll(true)}>[ ${() => hiddenCount()} earlier events ]</div>`
        : '')}
    </div>
  </div>`
}

function SectionsTabBody(props: { dashLoop: DashboardLoop }) {
  return SectionsPanel({ sections: () => props.dashLoop.sections })
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
    label: k === null ? 'cross-section' : 'sect ' + (k + 1),
    rows: map.get(k)!,
  }))
}

function FindingsTabBody(props: { dashLoop: DashboardLoop }) {
  const dl = () => props.dashLoop
  const hasFindings = createMemo(() => dl().findings.length > 0)
  const groups = createMemo(() => groupFindingsBySection(dl().findings))
  return html`<div class="findings-tab">
    ${() => (hasFindings()
      ? groups().map(g => html`<div class="findings-group" data-section-key=${() => g.key === null ? 'cross' : String(g.key)}>
          <div class="findings-group-label">${g.label}</div>
          <div class="resizable-block">
            ${g.rows.map(f => html`<div class=${() => 'finding finding-' + f.severity}>
              <span class="finding-time">${() => formatRelativeTime(f.createdAt)}</span>
              <span class="finding-text">${() => formatFinding(f)}</span>
            </div>`)}
          </div>
        </div>`)
      : html`<div class="tab-empty">No findings recorded for this loop.</div>`)}
  </div>`
}

function PlanTabBody(props: { dashLoop: DashboardLoop }) {
  const dl = () => props.dashLoop
  const hasPlan = createMemo(() => !!dl().plan)
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

function TabBody(props: {
  tab: LoopTab
  dashLoop: DashboardLoop
  split: () => Split
  now: () => number
  tabs: () => LoopTab[]
  activeTab: () => LoopTab
}) {
  const visible = createMemo(() => props.tabs().includes(props.tab) && props.activeTab() === props.tab)
  const body = (() => {
    switch (props.tab) {
      case 'overview': return OverviewTabBody({ dashLoop: props.dashLoop, split: props.split, now: props.now })
      case 'timeline': return TimelineTabBody({ dashLoop: props.dashLoop, now: props.now })
      case 'sections': return SectionsTabBody({ dashLoop: props.dashLoop })
      case 'findings': return FindingsTabBody({ dashLoop: props.dashLoop })
      case 'plan': return PlanTabBody({ dashLoop: props.dashLoop })
      case 'usage': return UsageTabBody({ dashLoop: props.dashLoop })
    }
  })()
  return html`<div class="tab-body" data-tab="${props.tab}" style=${() => visible() ? 'display:block' : 'display:none'}>
    ${body}
  </div>`
}

function LoopDetailTabs(props: {
  dashLoop: DashboardLoop
  split: () => Split
  now: () => number
  tabs: () => LoopTab[]
  activeTab: () => LoopTab
}) {
  return html`<div class="tab-bodies">
    ${ALL_TABS.map((t: LoopTab) => TabBody({
      tab: t,
      dashLoop: props.dashLoop,
      split: props.split,
      now: props.now,
      tabs: props.tabs,
      activeTab: props.activeTab,
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
      ${LoopDetailTabs({ dashLoop: props.dashLoop, split, now: props.now, tabs, activeTab })}
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

function groupRowClass(status: string): string {
  const terminal = TERMINAL_GROUP_STATUSES.has(status)
  return 'group-row' + (terminal ? ' group-row-terminal' : ' group-row-active')
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
          return html`<div class=${() => groupRowClass(gr.status)} data-group-status=${() => gr.status} onclick=${() => props.onOpen(gr.groupId)}>
            <span class=${() => statusClass(gr.status)}>${() => gr.status}</span>
            <span class="group-row-title">${() => gr.title}</span>
            <span class="group-row-meter">
              <span class="lt-meter"><span class="lt-meter-fill" style=${() => 'width:' + clampPercent(groupFeaturesMeter(g.features).completed, groupFeaturesMeter(g.features).total) + '%'}></span></span>
              <span class="lt-meter-text">${() => { const m = groupFeaturesMeter(g.features); return m.completed + '/' + m.total }}</span>
            </span>
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

function groupHeaderClass(status: string): string {
  const terminal = TERMINAL_GROUP_STATUSES.has(status)
  return 'group-header' + (terminal ? ' group-header-terminal' : ' group-header-active')
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
      return html`<div class=${() => groupHeaderClass(gr.status)} data-group-status=${() => gr.status}>
        <div class="group-header-top">
          <span class=${() => statusClass(gr.status)}>${() => gr.status}</span>
          <h3 class="group-header-title">${() => gr.title}</h3>
          <span class="group-header-meta">max ${() => gr.maxConcurrent}</span>
        </div>
        <div class="group-header-stats">
          <span class="group-header-stat">${() => { const m = groupFeaturesMeter(dg.features); return 'Features ' + m.completed + '/' + m.total }}</span>
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
        ${dg.features.map(f => {
          return html`<div class="feature-row" data-stage=${() => f.stage}>
            <span class="feature-index">#${() => f.featureIndex}</span>
            <span class="feature-title">${() => f.title}</span>
            <span class=${() => sectionStatusClass(f.stage)}>${() => f.stage}</span>
            <span class="feature-attempts">${() => f.attempts} attempts</span>
            ${() => (!!f.loopName && props.loopNames().has(f.loopName)
              ? html`<a class="feature-loop-link" href=${() => buildDashboardHash({ projectId: props.projectId(), section: 'loops', loopName: f.loopName, tab: 'overview', groupId: null, statuses: [], query: '' })} onclick=${(e: MouseEvent) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                e.preventDefault()
                props.onOpenLoop(f.loopName!)
              }}>${() => f.loopName}</a>`
              : '')}
            ${() => (f.error ? html`<span class="feature-error">${() => f.error}</span>` : '')}
          </div>`
        })}
      </div>`
    }}
  </div>`
}

function findingsGroupsForLoops(loops: DashboardLoop[]): Array<{ loopName: string; rows: DashboardLoop['findings'] }> {
  const order: string[] = []
  const map = new Map<string, DashboardLoop['findings']>()
  for (const dl of loops) {
    if (dl.findings.length === 0) continue
    if (!map.has(dl.loop.loopName)) {
      map.set(dl.loop.loopName, [])
      order.push(dl.loop.loopName)
    }
    map.get(dl.loop.loopName)!.push(...dl.findings)
  }
  return order.map(name => ({ loopName: name, rows: map.get(name)! }))
}

export function FindingsPanel(props: {
  loops: () => DashboardLoop[]
  projectId: () => string | null
  onOpenLoop: (loopName: string) => void
}) {
  const groups = createMemo(() => findingsGroupsForLoops(props.loops()))
  const total = createMemo(() => groups().reduce((acc, g) => acc + g.rows.length, 0))
  return html`<div class="findings-panel">
    <h4>Findings <span class="findings-panel-count">${() => total()}</span></h4>
    ${() => {
      const gs = groups()
      if (gs.length === 0) return html`<div class="tab-empty">No findings recorded for this repo.</div>`
      return html`<div class="findings-panel-list">
        ${gs.map(g => html`<div class="findings-loop-block" data-loop=${() => g.loopName}>
          <div class="findings-loop-head">
            <a class="findings-loop-link" href=${() => buildDashboardHash({ projectId: props.projectId(), section: 'loops', loopName: g.loopName, tab: 'overview', groupId: null, statuses: [], query: '' })} onclick=${(e: MouseEvent) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              props.onOpenLoop(g.loopName)
            }}>${() => g.loopName}</a>
            <span class="findings-loop-meta">${() => g.rows.length}</span>
          </div>
          <div class="resizable-block">
            ${g.rows.map(f => html`<div class=${() => 'finding finding-' + f.severity}>
              <span class="finding-time">${() => formatRelativeTime(f.createdAt)}</span>
              <span class="finding-text">${() => formatFinding(f)}</span>
            </div>`)}
          </div>
        </div>`)}
      </div>`
    }}
  </div>`
}

export function PlansPanel(props: {
  loops: () => DashboardLoop[]
  onOpenLoop: (loopName: string) => void
}) {
  const planLoops = createMemo(() => props.loops().filter(dl => !!dl.plan))
  return html`<div class="plans-panel">
    <h4>Plans <span class="plans-panel-count">${() => planLoops().length}</span></h4>
    ${() => {
      const list = planLoops()
      if (list.length === 0) return html`<div class="tab-empty">No plans recorded for this repo.</div>`
      return html`<div class="plans-list">
        ${list.map(dl => html`<div class="plan-row" onclick=${() => props.onOpenLoop(dl.loop.loopName)}>
          <span class=${() => statusClass(dl.loop.status)}>${() => dl.loop.status}</span>
          <span class="plan-row-name">${() => dl.loop.loopName}</span>
          <span class="plan-row-meta">
            ${() => dl.findings.length + ' finding' + (dl.findings.length === 1 ? '' : 's')}
          </span>
          <span class="plan-row-iter">iter ${() => dl.loop.iteration}/${() => dl.loop.maxIterations}</span>
        </div>`)}
      </div>`
    }}
  </div>`
}
