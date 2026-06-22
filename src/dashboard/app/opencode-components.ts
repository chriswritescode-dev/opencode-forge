import html from 'solid-js/html'
import type { OpencodeSessionRow, TranscriptEntry, OpencodeActivityEvent } from './opencode-types'
import { fmtTime, renderMarkdown } from './helpers'

// ── ViewToggle ────────────────────────────────────────────────────────────

export function ViewToggle(props: {
  active: 'loops' | 'sessions'
  onSelect: (view: 'loops' | 'sessions') => void
}) {
  const loopsCls = 'badge badge-filter' + (props.active === 'loops' ? ' badge-active' : '')
  const sessionsCls = 'badge badge-filter' + (props.active === 'sessions' ? ' badge-active' : '')

  return html`<div class="view-toggle">
    <span class="${loopsCls}" onclick=${() => props.onSelect('loops')}>Loops</span>
    <span class="${sessionsCls}" onclick=${() => props.onSelect('sessions')}>Sessions</span>
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

export function ActivityFeed(props: {
  events: OpencodeActivityEvent[]
}) {
  if (props.events.length === 0) {
    return html`<div class="activity-feed">
      <div class="activity-empty">No recent activity.</div>
    </div>`
  }
  return html`<div class="activity-feed">
    ${props.events.map(
      (event) => html`<div class="activity-row">
        <span class="activity-time">${fmtTime(event.time)}</span>
        <span class="activity-type">${event.type}</span>
        <span class="activity-title">${event.title || event.directory || ''}</span>
      </div>`,
    )}
  </div>`
}

// ── SessionsView ───────────────────────────────────────────────────────────

export function SessionsView(props: {
  sessions: () => OpencodeSessionRow[]
  activeSessionId: () => string | null
  transcript: () => TranscriptEntry[] | null
  activity: () => OpencodeActivityEvent[]
  onOpen: (sessionId: string) => void
  onBack: () => void
}) {
  return html`<div class="session-view">
    ${() => ActivityFeed({ events: props.activity() })}
    ${() => {
      const sid = props.activeSessionId()
      return sid
        ? TranscriptView({ entries: props.transcript() || [], onBack: props.onBack })
        : SessionList({ sessions: props.sessions(), onOpen: props.onOpen })
    }}
  </div>`
}
