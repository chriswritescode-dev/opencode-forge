import html from 'solid-js/html'
import type { OpencodeSessionRow, TranscriptEntry, OpencodeActivityEvent } from './opencode-types'
import type { SessionProjectGroup } from './opencode-helpers'
import { fmtTime, renderMarkdown, deriveSidebarLabel } from './helpers'

// ── ViewToggle ────────────────────────────────────────────────────────────

export function ViewToggle(props: {
  active: 'loops' | 'sessions'
  onSelect: (view: 'loops' | 'sessions') => void
}) {
  const loopsCls = 'view-tab' + (props.active === 'loops' ? ' view-tab-active' : '')
  const sessionsCls = 'view-tab' + (props.active === 'sessions' ? ' view-tab-active' : '')
  const loopsSel = props.active === 'loops' ? 'true' : 'false'
  const sessionsSel = props.active === 'sessions' ? 'true' : 'false'

  return html`<div class="view-tabs" role="tablist" aria-label="Dashboard view">
    <button type="button" class="${loopsCls}" aria-selected="${loopsSel}" onclick=${() => props.onSelect('loops')}>Loops</button>
    <button type="button" class="${sessionsCls}" aria-selected="${sessionsSel}" onclick=${() => props.onSelect('sessions')}>Sessions</button>
  </div>`
}

// ── SessionList ───────────────────────────────────────────────────────────

export function SessionList(props: {
  sessions: OpencodeSessionRow[]
  onOpen: (sessionId: string) => void
}) {
  return html`<div class="session-list">
    ${props.sessions.map((s) => SessionRow({ session: s, onOpen: props.onOpen }))}
  </div>`
}

// ── SessionRow ────────────────────────────────────────────────────────────

function fmtCost(cost: number): string {
  return '$' + cost.toFixed(4)
}

function fmtTokens(input: number, output: number): string {
  return input.toLocaleString() + ' in / ' + output.toLocaleString() + ' out'
}

export function SessionRow(props: {
  session: OpencodeSessionRow
  onOpen: (sessionId: string) => void
}) {
  const s = () => props.session
  const title = () => s().title || s().directory || '(untitled)'
  const project = () => s().projectName || s().directory || ''
  const model = () => s().modelId || ''
  const cost = () => fmtCost(s().cost)
  const tokens = () => fmtTokens(s().tokensInput, s().tokensOutput)
  const time = () => fmtTime(s().timeUpdated)

  return html`<div class="session-row" onclick=${() => props.onOpen(s().id)}>
    <div class="session-title">${title}</div>
    <div class="session-meta">
      ${() => {
        const parts: string[] = []
        if (project()) parts.push(project())
        if (model()) parts.push(model())
        parts.push(cost())
        parts.push(tokens())
        if (time()) parts.push(time())
        return parts.join(' · ')
      }}
    </div>
  </div>`
}

// ── TranscriptView ─────────────────────────────────────────────────────────

export function TranscriptView(props: {
  entries: TranscriptEntry[]
  onBack: () => void
}) {
  return html`<div class="transcript-view">
    <div class="back-to-loops" onclick=${props.onBack}>
      ← Back to sessions
    </div>
    <div class="transcript">
      ${props.entries.map((entry) => {
        if (entry.type === 'text') {
          return html`<div class="transcript-entry transcript-text">
            <div class="markdown-content" innerHTML=${() => renderMarkdown(entry.text || '')}></div>
          </div>`
        }
        if (entry.type === 'tool') {
          return html`<div class="transcript-entry transcript-tool">
            <span class="transcript-tool-name">${entry.toolName || ''}</span>
            <span class="transcript-tool-title">${entry.toolTitle || ''}</span>
            <span class="transcript-tool-status">${entry.toolStatus || ''}</span>
          </div>`
        }
        return ''
      })}
    </div>
  </div>`
}

// ── ActivityFeed ───────────────────────────────────────────────────────────

/** Display the trailing path segment of a directory as a project label. */
function projectLabel(directory: string | null): string {
  if (!directory) return ''
  return deriveSidebarLabel(directory)
}

export function ActivityFeed(props: {
  events: OpencodeActivityEvent[]
}) {
  if (props.events.length === 0) {
    return html`<div class="activity-feed">
      <div class="activity-empty">No recent activity.</div>
    </div>`
  }
  return html`<div class="activity-feed">
    ${props.events.map((event) => {
      const project = projectLabel(event.directory)
      return html`<div class="activity-row">
        <span class="activity-time">${fmtTime(event.time)}</span>
        <span class="activity-type">${event.type}</span>
        ${project ? html`<span class="activity-project" title=${event.directory || ''}>${project}</span>` : ''}
        <span class="activity-title">${event.title || ''}</span>
      </div>`
    })}
  </div>`
}

// ── SessionProjectSidebar ───────────────────────────────────────────────────

export function SessionProjectSidebar(props: {
  groups: SessionProjectGroup[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  return html`<div class="session-project-sidebar">
    ${props.groups.map((g) => {
      const cls = 'session-project-nav-item' + (g.key === props.selectedKey ? ' selected' : '')
      return html`<div class="${cls}" onclick=${() => props.onSelect(g.key)}>
        <span class="session-project-nav-name">${g.label}</span>
        <span class="session-project-nav-count">${g.sessions.length}</span>
      </div>`
    })}
  </div>`
}

// ── SessionsView ───────────────────────────────────────────────────────────

export function SessionsView(props: {
  groups: () => SessionProjectGroup[]
  selectedGroup: () => SessionProjectGroup | null
  selectedProjectKey: () => string | null
  activeSessionId: () => string | null
  transcript: () => TranscriptEntry[] | null
  activity: () => OpencodeActivityEvent[]
  onSelectProject: (key: string) => void
  onOpen: (sessionId: string) => void
  onBack: () => void
}) {
  return html`<div class="session-view">
    ${() => ActivityFeed({ events: props.activity() })}
    ${() => {
      const sid = props.activeSessionId()
      if (sid) {
        return TranscriptView({ entries: props.transcript() || [], onBack: props.onBack })
      }
      const groups = props.groups()
      const selectedKey = props.selectedProjectKey()
      const group = props.selectedGroup()
      return html`<div class="session-layout">
        ${SessionProjectSidebar({ groups, selectedKey, onSelect: props.onSelectProject })}
        <div class="session-detail">
          ${group
            ? html`
              <div class="session-project-header">
                <h2>${group.label}</h2>
                <span class="session-group-count">${group.sessions.length} sessions</span>
              </div>
              ${SessionList({ sessions: group.sessions, onOpen: props.onOpen })}`
            : ''}
        </div>
      </div>`
    }}
  </div>`
}
