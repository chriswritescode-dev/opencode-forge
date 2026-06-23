import { createMemo, createEffect } from 'solid-js'
import html from 'solid-js/html'
import type { OpencodeSessionRow, TranscriptEntry } from './opencode-types'
import type { SessionProjectGroup } from './opencode-helpers'
import { fmtTime, renderMarkdown } from './helpers'

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

interface TranscriptMessageGroup {
  messageId: string
  role: string | null
  model: string | null
  entries: TranscriptEntry[]
}

/** Group consecutive transcript entries that belong to the same message. */
export function groupTranscriptByMessage(entries: TranscriptEntry[]): TranscriptMessageGroup[] {
  const groups: TranscriptMessageGroup[] = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last && last.messageId === entry.messageId) {
      last.entries.push(entry)
      // Backfilled role/model may arrive on later parts; keep first known.
      if (!last.role && entry.role) last.role = entry.role
      if (!last.model && entry.model) last.model = entry.model
    } else {
      groups.push({ messageId: entry.messageId, role: entry.role, model: entry.model, entries: [entry] })
    }
  }
  return groups
}

/** Section header label: 'User' for user messages, model name for assistant. */
export function transcriptMessageLabel(role: string | null, model: string | null): string {
  if (role === 'user') return 'User'
  if (model) return model
  if (role === 'assistant') return 'Assistant'
  return role || 'Message'
}

function renderTranscriptEntry(entry: TranscriptEntry) {
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
}

/** Distance (px) from the bottom within which we consider the view "pinned". */
const STICK_THRESHOLD_PX = 48

export function TranscriptView(props: {
  entries: () => TranscriptEntry[] | null
  onBack: () => void
}) {
  // Reactive content inside a persistent scroll container: the container node
  // survives content updates, so scroll position is preserved and we can decide
  // whether to follow the tail.
  const groups = createMemo(() => groupTranscriptByMessage(props.entries() || []))

  let el: HTMLDivElement | undefined
  // Start pinned so the initial render lands at the latest output (TUI-style).
  let stuck = true
  let lastTop = 0

  const isAtBottom = (node: HTMLElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_THRESHOLD_PX

  const onScroll = () => {
    if (!el) return
    lastTop = el.scrollTop
    stuck = isAtBottom(el)
  }

  const setRef = (node: HTMLDivElement) => {
    el = node
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight })
  }

  // On each content change: follow the tail only when the user is at the bottom;
  // otherwise restore their position so streaming output doesn't fight them.
  createEffect(() => {
    groups() // track content changes
    requestAnimationFrame(() => {
      if (!el) return
      el.scrollTop = stuck ? el.scrollHeight : lastTop
    })
  })

  return html`<div class="transcript-view">
    <div class="back-to-loops" onclick=${props.onBack}>
      ← Back to sessions
    </div>
    <div class="transcript" ref=${setRef} onscroll=${onScroll}>
      ${() => groups().map((group) => {
        const cls = 'transcript-msg transcript-msg-' + (group.role === 'user' ? 'user' : 'assistant')
        return html`<div class=${cls}>
          <div class="transcript-msg-header">${transcriptMessageLabel(group.role, group.model)}</div>
          ${group.entries.map((entry) => renderTranscriptEntry(entry))}
        </div>`
      })}
    </div>
  </div>`
}

// ── SessionProjectSidebar ───────────────────────────────────────────────────

export function SessionProjectSidebar(props: {
  groups: SessionProjectGroup[]
  selectedKey: string | null
  activeKeys: () => Set<string>
  onSelect: (key: string) => void
}) {
  return html`<div class="session-project-sidebar">
    ${props.groups.map((g) => {
      const cls = 'session-project-nav-item' + (g.key === props.selectedKey ? ' selected' : '')
      return html`<div class="${cls}" onclick=${() => props.onSelect(g.key)}>
        ${() => props.activeKeys().has(g.key)
          ? html`<span class="session-project-nav-activity" title="Recent activity"></span>`
          : ''}
        <span class="session-project-nav-name">${g.label}</span>
        <span class="session-project-nav-count">${g.sessions.length}</span>
      </div>`
    })}
  </div>`
}

// ── SessionsView ───────────────────────────────────────────────────────────

export function SessionsView(props: {
  available: () => boolean
  groups: () => SessionProjectGroup[]
  selectedGroup: () => SessionProjectGroup | null
  selectedProjectKey: () => string | null
  activeSessionId: () => string | null
  transcript: () => TranscriptEntry[] | null
  activeKeys: () => Set<string>
  onSelectProject: (key: string) => void
  onOpen: (sessionId: string) => void
  onBack: () => void
}) {
  // Single reactive region. When a session is open it reads only
  // `activeSessionId`, so the transcript subtree (and its scroll container) is
  // built once per session and survives list/transcript data updates.
  return html`<div class="session-view">
    ${() => {
      const sid = props.activeSessionId()
      if (sid) {
        // Transcript view: just the conversation — no activity feed on top.
        // Pass the accessor so transcript updates stay inside TranscriptView.
        return TranscriptView({ entries: props.transcript, onBack: props.onBack })
      }
      if (!props.available()) {
        return html`<div class="empty-state">Sessions data unavailable.</div>`
      }
      const groups = props.groups()
      if (groups.length === 0) {
        return html`<div class="empty-state">No sessions found.</div>`
      }
      const selectedKey = props.selectedProjectKey()
      const group = props.selectedGroup()
      return html`<div class="session-list-view">
        <div class="session-layout">
          ${SessionProjectSidebar({ groups, selectedKey, activeKeys: props.activeKeys, onSelect: props.onSelectProject })}
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
        </div>
      </div>`
    }}
  </div>`
}
