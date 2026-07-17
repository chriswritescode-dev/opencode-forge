import { createSignal, createMemo, createEffect, onMount, onCleanup } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import html from 'solid-js/html'
import type { DashboardPayload, DashboardLoop } from './types'
import type { LoopRunRow } from '../../storage'
import { parseRoute, buildLoopHash, syncHash, dataHash, loopMatchesFilters } from './helpers'
import {
  TotalsBar,
  SearchInput,
  Timestamp,
  Sidebar,
  LoopTable,
  LoopDetail,
  EmptyState,
  RunsView,
  type MatchedEntry,
} from './components'

function syncHashTo(projectId: string | null, loopName: string | null, suppressRef: { current: boolean }) {
  syncHash(buildLoopHash(projectId, loopName), suppressRef)
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
  const [metricsSelected, setMetricsSelected] = createSignal(false)
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
    setMetricsSelected(false)
    setSelectedProjectId(projectId)
    setSelectedLoopName(loopName)
    syncHashTo(projectId, loopName, suppressHashChangeRef)
  }

  // Leave the project/loop selection intact so RunsView can filter by the
  // currently-selected project; only the route signal flips.
  const navigateMetrics = () => {
    setMetricsSelected(true)
    syncHash('metrics', suppressHashChangeRef)
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
    return LoopTable({ loops: e.loops, onOpen: (name: string) => navigate(pid, name) }) as Node
  })

  // Aggregated runs for the `#metrics` view: flattened across all projects,
  // filtered to the selected project's runs when one is active in the sidebar.
  // Swept-only projects (loops array empty, runs non-empty) are included via
  // their `runs` arrays.
  const metricsRuns = createMemo<LoopRunRow[]>(() => {
    const pid = selectedProjectId()
    const out: LoopRunRow[] = []
    for (const proj of state.projects) {
      if (pid !== null && proj.projectId !== pid) continue
      for (const r of proj.runs) out.push(r)
    }
    return out
  })

  const metricsView = createMemo<Node | string>(() => {
    if (!loaded() || !metricsSelected()) return ''
    return RunsView({ runs: metricsRuns }) as Node
  })

  // ── Effects ─────────────────────────────────────────────────────────────

  // Sync selected project when data or filters change (skipped while the
  // metrics route is active so RunsView keeps the saved project filter and the
  // auto-default does not fight the `#metrics` hash).
  createEffect(() => {
    if (!loaded()) return
    if (metricsSelected()) return
    const entries = matchedByProject()
    if (entries.length === 0) {
      setSelectedProjectId(null)
      setSelectedLoopName(null)
      return
    }
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

  // Sync hash to match current selection whenever it changes (but only after
  // data loaded). The metrics route pins the hash to `#metrics` so project /
  // loop changes do not overwrite it while RunsView is mounted.
  createEffect(() => {
    if (!loaded()) return
    if (metricsSelected()) {
      syncHash('metrics', suppressHashChangeRef)
      return
    }
    syncHashTo(selectedProjectId(), selectedLoopName(), suppressHashChangeRef)
  })

  // ── Lifecycle ───────────────────────────────────────────────────────────

  onMount(() => {
    // Seed initial selection from URL hash
    const route = parseRoute(location.hash)
    if (route.kind === 'metrics') {
      setMetricsSelected(true)
    } else if (route.kind === 'loop') {
      setSelectedProjectId(route.projectId)
      if (route.loopName) setSelectedLoopName(route.loopName)
    }

    // Initial load + poll
    load()
    const id = setInterval(() => {
      load()
    }, 5000)

    // Hash change listener (browser back/forward)
    const onHashChange = () => {
      if (suppressHashChangeRef.current) {
        suppressHashChangeRef.current = false
        return
      }
      const route = parseRoute(location.hash)
      if (route.kind === 'metrics') {
        setMetricsSelected(true)
        return
      }
      setMetricsSelected(false)
      if (route.kind === 'loop') {
        setSelectedProjectId(route.projectId)
        setSelectedLoopName(route.loopName)
      } else {
        setSelectedProjectId(null)
        setSelectedLoopName(null)
      }
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
      return html`<div class="dashboard-summary">
        ${TotalsBar({ totals: state.totals, activeStatuses: activeStatuses(), onToggle: toggleStatus })}
        <span class=${() => 'metrics-nav-link' + (metricsSelected() ? ' selected' : '')} onclick=${navigateMetrics}>Metrics</span>
        ${Timestamp({ generatedAt: state.generatedAt })}
      </div>`
    }}

    ${() => {
      if (!loaded()) return ''
      if (metricsSelected()) {
        return html`<div class="dash-layout metrics-layout">
          ${sidebarView}
          <div class="project-detail">
            ${metricsView}
          </div>
        </div>`
      }
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
