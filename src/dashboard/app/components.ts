import html from 'solid-js/html'
import { createMemo } from 'solid-js'
import type { DashboardLoop, DashboardTotals, DashboardProject } from './types'
import {
  statusClass,
  sectionStatusClass,
  fmtTime,
  deriveSidebarLabel,
  formatLoopSummaryParts,
  splitFindings,
  formatFinding,
  formatUsageTotal,
  formatModelUsage,
  renderMarkdown,
} from './helpers'

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

// ── LoopList ──────────────────────────────────────────────────────────────

export function LoopList(props: { loops: DashboardLoop[]; onOpen: (name: string) => void }) {
  return html`<div>
    ${props.loops.map((dl: DashboardLoop) => LoopRow({ dashLoop: dl, onOpen: props.onOpen }))}
  </div>`
}

// ── LoopSummaryLine ────────────────────────────────────────────────────────

function LoopSummaryLine(props: { dashLoop: DashboardLoop }) {
  const lp = () => props.dashLoop.loop

  return html`
    <span class=${() => statusClass(lp().status)}>${() => lp().status}</span>
    <span class="loop-info">
      <strong>${() => lp().loopName}</strong>
      — ${() => formatLoopSummaryParts(props.dashLoop).join(', ')}
      ${() =>
        lp().status !== 'running' && lp().completedAt
          ? html`— <span class="dim">done: ${() => fmtTime(lp().completedAt)}</span>`
          : ''}
      ${() =>
        lp().terminationReason
          ? html`— <span class="error-text">${() => lp().terminationReason}</span>`
          : ''}
    </span>
  `
}

// ── LoopRow ───────────────────────────────────────────────────────────────

export function LoopRow(props: { dashLoop: DashboardLoop; onOpen: (name: string) => void }) {
  return html`<div class="loop-row" onclick=${() => props.onOpen(props.dashLoop.loop.loopName)}>
    ${LoopSummaryLine({ dashLoop: props.dashLoop })}
  </div>`
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
  const hasUsage = createMemo(() => !!dl().usage)

  return html`<div class="loop">
    <!-- Back to loops -->
    <div class="back-to-loops" onclick=${props.onBack}>
      ← Back to loops
    </div>

    <!-- Header summary -->
    <div class="loop-detail-header">
      ${LoopSummaryLine({ dashLoop: props.dashLoop })}
    </div>

    <!-- Detail body -->
    <div class="loop-detail">
      ${() => (hasCompletion() ? MarkdownSection({ label: 'Completion Summary', src: () => dl().loop.completionSummary }) : '')}

      <!-- Sections -->
      ${() =>
        hasSections()
          ? html`<div class="sections-group">
              <h4>Sections</h4>
              ${() =>
                dl().sections!.map(
                  (sec: NonNullable<DashboardLoop['sections']>[number]) => html`
                    <div class="section-row">
                      <span class=${() => sectionStatusClass(sec.status)}>${() => sec.status}</span>
                      <span>#${sec.sectionIndex} ${sec.title} (attempts: ${() => sec.attempts})</span>
                    </div>
                  `,
                )}
            </div>`
          : ''}

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

      <!-- Usage -->
      ${() =>
        hasUsage()
          ? html`<div class="usage-group">
              <h4>Usage</h4>
              <div class="usage-row">${() => formatUsageTotal(dl().usage!)}</div>
              ${() =>
                Object.keys(dl().usage!.byModel).map(
                  (model: string) =>
                    html`<div class="usage-row">${() => formatModelUsage(model, dl().usage!.byModel[model])}</div>`,
                )}
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
