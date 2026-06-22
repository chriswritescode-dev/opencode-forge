import html from 'solid-js/html'
import { For, createMemo } from 'solid-js'
import type { DashboardLoop, DashboardTotals } from './types'
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

// ── Shared types ──────────────────────────────────────────────────────────

export type { DashboardTotals }

export interface MatchedEntry {
  proj: import('./types').DashboardProject
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
    <${For} each=${props.entries}>
      ${(entry: MatchedEntry) => {
        const isSelected = entry.proj.projectId === props.selectedProjectId
        const hasRunning = entry.loops.some(dl => dl.loop.status === 'running')
        const label = deriveSidebarLabel(entry.proj.projectDir || entry.proj.projectId || '')
        const rawPath = entry.proj.projectDir || entry.proj.projectId || ''
        const cls = `project-nav-item${isSelected ? ' selected' : ''}`
        return html`<div class="${cls}" onclick=${() => props.onSelect(entry.proj.projectId, null)}>
          ${hasRunning ? html`<span class="project-nav-running"></span>` : ''}
          <span class="project-nav-name" title=${rawPath}>${label}</span>
          <span class="project-nav-count">${entry.loops.length}</span>
        </div>`
      }}
    </${For}>
  </div>`
}

// ── LoopList ──────────────────────────────────────────────────────────────

export function LoopList(props: { loops: DashboardLoop[]; onOpen: (name: string) => void }) {
  return html`<div>
    <${For} each=${props.loops}>
      ${(dl: DashboardLoop) => LoopRow({ dashLoop: dl, onOpen: props.onOpen })}
    </${For}>
  </div>`
}

// ── LoopSummaryLine ────────────────────────────────────────────────────────

function LoopSummaryLine(props: { dashLoop: DashboardLoop }) {
  const lp = props.dashLoop.loop
  const parts = formatLoopSummaryParts(props.dashLoop)

  return html`
    <span class="${statusClass(lp.status)}">${lp.status}</span>
    <span class="loop-info">
      <strong>${lp.loopName}</strong>
      — ${parts.join(', ')}
      ${lp.status !== 'running' && lp.completedAt
        ? html`— <span class="dim">done: ${fmtTime(lp.completedAt)}</span>`
        : ''}
      ${lp.terminationReason
        ? html`— <span class="error-text">${lp.terminationReason}</span>`
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

export function MarkdownSection(props: { label: string; src: string | null | undefined }) {
  if (!props.src) return '' as unknown as Node

  const parsed = createMemo(() => renderMarkdown(props.src || ''))

  return html`
    <div class="markdown-heading-row">
      <h4 class="section-label">${props.label}</h4>
      <button
        class="copy-btn"
        aria-label="Copy ${props.label} as markdown"
        onclick=${(e: Event) => {
          e.stopPropagation()
          const btn = e.target as HTMLButtonElement
          const orig = 'Copy'
          navigator.clipboard.writeText(props.src!).then(
            () => { btn.textContent = 'Copied!' },
            () => { btn.textContent = 'Failed' },
          ).then(() => {
            setTimeout(() => { btn.textContent = orig }, 2000)
          })
        }}
      >Copy</button>
    </div>
    <div class="markdown-scrollable">
      <div class="markdown-content" innerHTML=${parsed()}></div>
    </div>
  `
}

// ── LoopDetail ────────────────────────────────────────────────────────────

export function LoopDetail(props: { dashLoop: DashboardLoop; onBack: () => void }) {
  const dl = props.dashLoop
  const lp = dl.loop
  const { bugs, warnings } = splitFindings(dl.findings)
  const hasSections = dl.sections && dl.sections.length > 0
  const hasFindings = dl.findings && dl.findings.length > 0

  return html`<div class="loop">
    <!-- Back to loops -->
    <div class="back-to-loops" onclick=${props.onBack}>
      ← Back to loops
    </div>

    <!-- Header summary -->
    <div class="loop-detail-header">
      ${LoopSummaryLine({ dashLoop: dl })}
    </div>

    <!-- Detail body -->
    <div class="loop-detail">
      ${MarkdownSection({ label: 'Completion Summary', src: lp.completionSummary })}

      <!-- Sections -->
      ${hasSections
        ? html`
            <h4>Sections</h4>
            <${For} each=${dl.sections}>
              ${(sec: NonNullable<DashboardLoop['sections']>[number]) => html`
                <div class="section-row">
                  <span class="${sectionStatusClass(sec.status)}">${sec.status}</span>
                  <span>#${sec.sectionIndex} ${sec.title} (attempts: ${sec.attempts})</span>
                </div>
              `}
            </${For}>
          `
        : ''}

      <!-- Findings -->
      ${hasFindings
        ? html`
            <h4>Findings (${dl.findings.length})</h4>
            <div class="resizable-block">
              ${bugs.length > 0
                ? html`
                    <div class="finding finding-bug">Bugs:</div>
                    <${For} each=${bugs}>
                      ${(f: (typeof bugs)[number]) => html`<div class="finding finding-bug">${formatFinding(f)}</div>`}
                    </${For}>
                  `
                : ''}
              ${warnings.length > 0
                ? html`
                    <div class="finding finding-warning">Warnings:</div>
                    <${For} each=${warnings}>
                      ${(f: (typeof warnings)[number]) => html`<div class="finding finding-warning">${formatFinding(f)}</div>`}
                    </${For}>
                  `
                : ''}
            </div>
          `
        : ''}

      <!-- Usage -->
      ${dl.usage
        ? html`
            <h4>Usage</h4>
            <div class="usage-row">${formatUsageTotal(dl.usage)}</div>
            <${For} each=${Object.keys(dl.usage.byModel)}>
              ${(model: string) => html`
                <div class="usage-row">${formatModelUsage(model, dl.usage!.byModel[model])}</div>
              `}
            </${For}>
          `
        : ''}

      ${MarkdownSection({ label: 'Last Audit Result', src: dl.lastAuditResult })}
      ${MarkdownSection({ label: 'Plan', src: dl.plan })}
    </div>
  </div>`
}

// ── EmptyState ────────────────────────────────────────────────────────────

export function EmptyState() {
  return html`<div class="empty-state">No loops match the current filters.</div>`
}
