import { createSignal, createMemo, createEffect, onMount, onCleanup } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import html from 'solid-js/html'
import type { DashboardPayload, DashboardLoop } from './types'
import { parseLoopHash, buildLoopHash, dataHash, loopMatchesFilters } from './helpers'
import {
  TotalsBar,
  SearchInput,
  Timestamp,
  Sidebar,
  LoopList,
  LoopDetail,
  EmptyState,
  type MatchedEntry,
} from './components'

function syncHashTo(projectId: string | null, loopName: string | null, suppressRef: { current: boolean }) {
  const next = buildLoopHash(projectId, loopName)
  const current = location.hash || ''
  const currentNorm = '#' + current.replace(/^#/, '')
  const nextNorm = '#' + next.replace(/^#/, '')
  if (currentNorm !== nextNorm) {
    suppressRef.current = true
    location.hash = next
  }
}

export function App() {
  // ── Reactive state ──────────────────────────────────────────────────────

  const [state, setState] = createStore<DashboardPayload>({
    generatedAt: 0,
    projects: [],
    totals: { projects: 0, loops: 0, running: 0, completed: 0, cancelled: 0, errored: 0, stalled: 0 },
  })
  const [loaded, setLoaded] = createSignal(false)
  const [activeStatuses, setActiveStatuses] = createSignal<Set<string>>(new Set())
  const [searchText, setSearchText] = createSignal('')
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [selectedLoopName, setSelectedLoopName] = createSignal<string | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)

  // Non-reactive refs
  const lastDataHashRef = { current: '' }
  const suppressHashChangeRef = { current: false }

  // ── Data fetching ───────────────────────────────────────────────────────

  const load = async () => {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' })
      const json: DashboardPayload = await res.json()
      const hash = dataHash(json)
      if (hash !== lastDataHashRef.current) {
        lastDataHashRef.current = hash
        setState(reconcile(json, { key: 'projectId' }))
        setLoaded(true)
        setLoadError(null)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError('Failed to load dashboard data: ' + msg)
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  const navigate = (projectId: string | null, loopName: string | null) => {
    setSelectedProjectId(projectId)
    setSelectedLoopName(loopName)
    syncHashTo(projectId, loopName, suppressHashChangeRef)
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  const toggleStatus = (key: string) => {
    const next = new Set(activeStatuses())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setActiveStatuses(next)
  }

  const handleSearch = (e: Event) => {
    setSearchText((e.target as HTMLInputElement).value.trim().toLowerCase())
  }

  // ── Derived memos ───────────────────────────────────────────────────────

  const matchedByProject = createMemo<MatchedEntry[]>(() => {
    if (!loaded() || state.projects.length === 0) return []
    const statuses = activeStatuses()
    const search = searchText()
    const result: MatchedEntry[] = []
    for (const proj of state.projects) {
      const matched: DashboardLoop[] = []
      for (const dashLoop of proj.loops) {
        if (loopMatchesFilters(dashLoop.loop, proj, statuses, search)) {
          matched.push(dashLoop)
        }
      }
      if (matched.length > 0) {
        result.push({ proj, loops: matched })
      }
    }
    return result
  })

  const selectedEntry = createMemo<MatchedEntry | null>(() => {
    const entries = matchedByProject()
    const pid = selectedProjectId()
    if (!entries.length) return null
    const found = entries.find(e => e.proj.projectId === pid)
    return found ?? entries[0]
  })

  const activeLoop = createMemo<DashboardLoop | null>(() => {
    const entry = selectedEntry()
    const name = selectedLoopName()
    if (!entry || !name) return null
    return entry.loops.find(l => l.loop.loopName === name) ?? null
  })

  // ── View nodes ──────────────────────────────────────────────────────────
  // These memos return DOM nodes. Because a memo only re-emits when its value
  // changes, the detail subtree is built once per selected loop (stable store
  // reference) and survives polls, preserving markdown scroll / resize state;
  // only the loop's fields update in place via the reactive reads inside it.

  const sidebarView = createMemo(() =>
    Sidebar({
      entries: matchedByProject(),
      selectedProjectId: selectedProjectId(),
      onSelect: navigate,
    }),
  )

  const detailView = createMemo<Node | string>(() => {
    const loop = activeLoop()
    return loop
      ? (LoopDetail({ dashLoop: loop, onBack: () => navigate(selectedProjectId(), null) }) as Node)
      : ''
  })

  const listView = createMemo<Node | string>(() => {
    if (activeLoop()) return ''
    const e = selectedEntry()
    if (!e) return ''
    const pid = selectedProjectId()
    return LoopList({ loops: e.loops, onOpen: (name: string) => navigate(pid, name) }) as Node
  })

  // ── Effects ─────────────────────────────────────────────────────────────

  // Sync selected project when data or filters change
  createEffect(() => {
    if (!loaded()) return
    const entries = matchedByProject()
    const pid = selectedProjectId()
    const exists = pid !== null && entries.some(e => e.proj.projectId === pid)
    if (!exists) {
      setSelectedProjectId(entries[0].proj.projectId)
      setSelectedLoopName(null)
    }
  })

  // Clear invalid loop name when selection changes
  createEffect(() => {
    const entry = selectedEntry()
    const name = selectedLoopName()
    if (!entry || !name) return
    const exists = entry.loops.some(l => l.loop.loopName === name)
    if (!exists) {
      setSelectedLoopName(null)
    }
  })

  // Sync hash to match current selection whenever it changes (but only after data loaded)
  createEffect(() => {
    if (!loaded()) return
    syncHashTo(selectedProjectId(), selectedLoopName(), suppressHashChangeRef)
  })

  // ── Lifecycle ───────────────────────────────────────────────────────────

  onMount(() => {
    // Seed initial selection from URL hash
    const parsed = parseLoopHash(location.hash)
    if (parsed.projectId) setSelectedProjectId(parsed.projectId)
    if (parsed.loopName) setSelectedLoopName(parsed.loopName)

    // Initial load + poll
    load()
    const id = setInterval(load, 5000)

    // Hash change listener (browser back/forward)
    const onHashChange = () => {
      if (suppressHashChangeRef.current) {
        suppressHashChangeRef.current = false
        return
      }
      const parsed = parseLoopHash(location.hash)
      setSelectedProjectId(parsed.projectId)
      setSelectedLoopName(parsed.loopName)
    }
    window.addEventListener('hashchange', onHashChange)

    onCleanup(() => {
      clearInterval(id)
      window.removeEventListener('hashchange', onHashChange)
    })
  })

  // ── Render ──────────────────────────────────────────────────────────────

  // A single root element is required: top-level children of a multi-root
  // solid-js/html template are not wired as reactive inserts, so wrap the whole
  // UI in one container to keep the ${() => ...} regions reactive.
  return html`<div class="forge-app">
    <h1>Forge Dashboard</h1>

    ${() => {
      const err = loadError()
      return err ? html`<div class="error-text">${err}</div>` : ''
    }}

    ${SearchInput({ onInput: handleSearch })}

    ${() => {
      if (!loaded()) return ''
      return html`
        ${TotalsBar({ totals: state.totals, activeStatuses: activeStatuses(), onToggle: toggleStatus })}
        ${Timestamp({ generatedAt: state.generatedAt })}
      `
    }}

    ${() => {
      if (!loaded()) return ''
      if (matchedByProject().length === 0) return EmptyState()
      const selEntry = selectedEntry()
      if (!selEntry) return ''
      return html`
        <div class="dash-layout">
          ${sidebarView}
          <div class="project-detail">
            <div class="project">
              <div class="project-header">${selEntry.proj.projectDir || selEntry.proj.projectId}</div>
              ${listView}
              ${detailView}
            </div>
          </div>
        </div>
      `
    }}
  </div>`
}
