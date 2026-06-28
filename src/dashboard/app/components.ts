import html from 'solid-js/html'
import { createMemo, createSignal } from 'solid-js'
import type { DashboardLoop, DashboardTotals, DashboardProject } from './types'
import {
  statusClass,
  sectionStatusClass,
  fmtTime,
  deriveSidebarLabel,
  formatSectionDuration,
  splitFindings,
  formatFinding,
  formatModelUsage,
  formatTokenCount,
  formatUsageCost,
  tokenBreakdownSegments,
  modelUsageBars,
  renderMarkdown,
} from './helpers'

type DashboardSection = NonNullable<DashboardLoop['sections']>[number]

// NOTE: solid-js/html does not support the `<${Show}>` / `<${For}>` component
// syntax reliably (it mis-parses the closing tag — see solidjs/solid#2033).
// Control flow here therefore uses ternary thunks + createMemo + `.map()`, as
// recommended by the Solid maintainers. Boolean createMemos gate show/hide so a
// content change does not tear down the surrounding wrapper, which is what
// preserves markdown scroll position and the resizable-block height.

// ── Shared types ──────────────────────────────────────────────────────────

export type { DashboardTotals }

export interface MatchedEntry {
  proj: DashboardProject
  loops: DashboardLoop[]
}

// ── TotalsBar ─────────────────────────────────────────────────────────────

export function TotalsBar(props: {
  totals: DashboardTotals
  activeStatuses: Set<string>
  onToggle: (key: string) => void
}) {
  const entries: { label: string; key: string | null; value: number }[] = [
    { label: 'Projects', key: null, value: props.totals.projects },
    { label: 'Loops', key: null, value: props.totals.loops },
    { label: 'Running', key: 'running', value: props.totals.running },
    { label: 'Completed', key: 'completed', value: props.totals.completed },
    { label: 'Cancelled', key: 'cancelled', value: props.totals.cancelled },
    { label: 'Errored', key: 'errored', value: props.totals.errored },
    { label: 'Stalled', key: 'stalled', value: props.totals.stalled },
  ]

  return html`<div class="totals">
    ${entries.map(({ label, key, value }) => {
      if (!key) {
        return html`<span class="badge">${label}: ${value}</span>`
      }
      const active = props.activeStatuses.has(key)
      const cls = `badge badge-filter${active ? ' badge-active' : ''}`
      return html`<span class="${cls}" onclick=${() => props.onToggle(key!)}>${label}: ${value}</span>`
    })}
  </div>`
}

// ── SearchInput ───────────────────────────────────────────────────────────

export function SearchInput(props: { onInput: (e: Event) => void }) {
  return html`<input
    id="loop-search"
    class="search-input"
    type="text"
    placeholder="Filter by loop name or project…"
    autocomplete="off"
    oninput=${props.onInput}
  />`
}

// ── Timestamp ─────────────────────────────────────────────────────────────

export function Timestamp(props: { generatedAt: number }) {
  return html`<div class="timestamp">Last updated: ${new Date(props.generatedAt).toLocaleString()}</div>`
}

// ── Sidebar ───────────────────────────────────────────────────────────────

export function Sidebar(props: {
  entries: MatchedEntry[]
  selectedProjectId: string | null
  onSelect: (projectId: string | null, loopName: string | null) => void
}) {
  return html`<div class="project-sidebar">
    ${props.entries.map((entry: MatchedEntry) => {
      const isSelected = entry.proj.projectId === props.selectedProjectId
      const hasRunning = entry.loops.some(dl => dl.loop.status === 'running')
      const rawPath = entry.proj.projectDir || entry.proj.projectId || ''
      const label = deriveSidebarLabel(rawPath)
      const cls = `project-nav-item${isSelected ? ' selected' : ''}`
      return html`<div class="${cls}" onclick=${() => props.onSelect(entry.proj.projectId, null)}>
        ${hasRunning ? html`<span class="project-nav-running"></span>` : ''}
        <span class="project-nav-name" title=${rawPath}>${label}</span>
        <span class="project-nav-count">${entry.loops.length}</span>
      </div>`
    })}
  </div>`
}
// ── LoopTable ─────────────────────────────────────────────────────────────

function MiniMeter(props: { current: () => number; total: () => number }) {
  const pct = () => {
    const t = props.total()
    if (!t || t <= 0) return 0
    return Math.max(0, Math.min(100, (props.current() / t) * 100))
  }
  return html`<span class="lt-meter-cell">
    <span class="lt-meter"><span class="lt-meter-fill" style=${() => 'width:' + pct() + '%'}></span></span>
    <span class="lt-meter-text">${() => props.current()}/${() => props.total()}</span>
  </span>`
}

export function LoopTable(props: { loops: DashboardLoop[]; onOpen: (name: string) => void }) {
  return html`<table class="loop-table">
    <thead><tr>
      <th>Status</th><th>Loop</th><th>Phase</th><th>Iter</th><th>Sections</th>
      <th>Findings</th><th>Cost</th><th>Duration</th><th>Updated</th>
    </tr></thead>
    <tbody>
      ${props.loops.map((dl: DashboardLoop) => LoopTableRow({ dashLoop: dl, onOpen: props.onOpen }))}
    </tbody>
  </table>`
}

function LoopTableRow(props: { dashLoop: DashboardLoop; onOpen: (name: string) => void }) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const counts = createMemo(() => splitFindings(dl().findings))
  return html`<tr class="lt-row" onclick=${() => props.onOpen(props.dashLoop.loop.loopName)}>
    <td><span class=${() => statusClass(lp().status)}>${() => lp().status}</span></td>
    <td class="lt-name">${() => lp().loopName}</td>
    <td class="lt-phase">${() => lp().phase}</td>
    <td>${MiniMeter({ current: () => lp().iteration, total: () => lp().maxIterations })}</td>
    <td>${() => (lp().totalSections > 0
      ? MiniMeter({ current: () => lp().currentSectionIndex, total: () => lp().totalSections })
      : html`<span class="dim">—</span>`)}</td>
    <td class="lt-findings">${() => {
      const c = counts()
      if (c.bugs.length === 0 && c.warnings.length === 0) return html`<span class="dim">—</span>`
      return html`<span>
        ${c.bugs.length > 0 ? html`<span class="finding-bug">${c.bugs.length} bug${c.bugs.length === 1 ? '' : 's'}</span>` : ''}
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
// scroll box persists across polls and only innerHTML updates in place. The
// single root element is required — a template that is only `${...}` generates
// invalid code in solid-js/html.
export function MarkdownSection(props: { label: string; src: () => string | null | undefined }) {
  return html`<div class="markdown-section">
    <div class="markdown-heading-row">
      <h4 class="section-label">${props.label}</h4>
      <button
        class="copy-btn"
        aria-label="Copy ${props.label} as markdown"
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
    <div class="markdown-scrollable">
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
// re-run and SectionBody (its .markdown-scrollable) is not rebuilt.
export function SectionsPanel(props: { sections: () => DashboardSection[] }) {
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
  const pct = () => {
    const total = props.total()
    if (!total || total <= 0) return 0
    return Math.max(0, Math.min(100, (props.current() / total) * 100))
  }
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
export function LoopDetailHeader(props: { dashLoop: DashboardLoop }) {
  const lp = () => props.dashLoop.loop
  const dl = () => props.dashLoop
  const hasCompletedAt = createMemo(() => !!lp().completedAt)
  const hasDuration = createMemo(() => !!dl().duration)
  const hasSectionsTotal = createMemo(() => lp().totalSections > 0)
  const hasReason = createMemo(() => !!lp().terminationReason)
  const split = createMemo(() => splitFindings(props.dashLoop.findings))
  const findingsLevel = createMemo(() => {
    const s = split()
    if (s.bugs.length > 0) return 'bug'
    if (s.warnings.length > 0) return 'warn'
    return 'clean'
  })
  const hasUsage = createMemo(() => !!props.dashLoop.usage)

  return html`<div class="loop-detail-header">
    <div class=${() => 'ldh-findings ldh-findings-' + findingsLevel()}>
      ${() => {
        const s = split()
        if (s.bugs.length === 0 && s.warnings.length === 0) return 'No findings'
        const parts = []
        if (s.bugs.length > 0) parts.push(s.bugs.length + (s.bugs.length === 1 ? ' bug' : ' bugs'))
        if (s.warnings.length > 0) parts.push(s.warnings.length + (s.warnings.length === 1 ? ' warning' : ' warnings'))
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

    ${() => (hasUsage() ? LoopUsage({ usage: () => props.dashLoop.usage! }) : '')}

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
export function LoopUsage(props: { usage: () => NonNullable<DashboardLoop['usage']> }) {
  const u = () => props.usage()
  const segments = createMemo(() => tokenBreakdownSegments(u()))
  const models = createMemo(() => modelUsageBars(u()))
  const hasModels = createMemo(() => models().length > 0)

  return html`<div class="usage-group">
    <h4>Usage</h4>

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

// ── LoopDetail ────────────────────────────────────────────────────────────

export function LoopDetail(props: { dashLoop: DashboardLoop; onBack: () => void }) {
  const dl = () => props.dashLoop
  const split = createMemo(() => splitFindings(dl().findings))
  // Boolean memos gate each group: they only flip when a group appears or
  // disappears, so unchanged groups (and their scroll/resize state) are not
  // rebuilt when the loop's data updates on a poll.
  const hasCompletion = createMemo(() => !!dl().loop.completionSummary)
  const hasAudit = createMemo(() => !!dl().lastAuditResult)
  const hasPlan = createMemo(() => !!dl().plan)
  const hasSections = createMemo(() => !!dl().sections && dl().sections!.length > 0)
  const hasFindings = createMemo(() => !!dl().findings && dl().findings.length > 0)
  const hasBugs = createMemo(() => split().bugs.length > 0)
  const hasWarnings = createMemo(() => split().warnings.length > 0)

  return html`<div class="loop">
    <!-- Back to loops -->
    <div class="back-to-loops" onclick=${props.onBack}>
      ← Back to loops
    </div>

    <!-- Header summary -->
    ${LoopDetailHeader({ dashLoop: props.dashLoop })}

    <!-- Detail body -->
    <div class="loop-detail">
      ${() => (hasCompletion() ? MarkdownSection({ label: 'Completion Summary', src: () => dl().loop.completionSummary }) : '')}

      <!-- Sections -->
      ${() => (hasSections() ? SectionsPanel({ sections: () => dl().sections! }) : '')}

      <!-- Findings (resizable wrapper persists while findings exist) -->
      ${() =>
        hasFindings()
          ? html`<div class="findings-group">
              <h4>${() => 'Findings (' + dl().findings.length + ')'}</h4>
              <div class="resizable-block">
                ${() => (hasBugs() ? html`<div class="finding finding-bug">Bugs:</div>` : '')}
                ${() =>
                  split().bugs.map(
                    (f: DashboardLoop['findings'][number]) =>
                      html`<div class="finding finding-bug">${() => formatFinding(f)}</div>`,
                  )}
                ${() => (hasWarnings() ? html`<div class="finding finding-warning">Warnings:</div>` : '')}
                ${() =>
                  split().warnings.map(
                    (f: DashboardLoop['findings'][number]) =>
                      html`<div class="finding finding-warning">${() => formatFinding(f)}</div>`,
                  )}
              </div>
            </div>`
          : ''}

      ${() => (hasAudit() ? MarkdownSection({ label: 'Last Audit Result', src: () => dl().lastAuditResult }) : '')}
      ${() => (hasPlan() ? MarkdownSection({ label: 'Plan', src: () => dl().plan }) : '')}
    </div>
  </div>`
}

// ── EmptyState ────────────────────────────────────────────────────────────

export function EmptyState() {
  return html`<div class="empty-state">No loops match the current filters.</div>`
}
