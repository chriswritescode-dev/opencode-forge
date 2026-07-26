import { createSignal, createMemo, createEffect, onMount, onCleanup, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import html from 'solid-js/html'
import type { DashboardPayload, DashboardProject, DashboardLoop, DashboardGroup } from './types'
import type { DashboardRoute, SortMode } from './helpers'
import { parseDashboardHash, buildDashboardHash, syncHash, dataHash, loopMatchesFilters, buildRepoLabels, sortLoops, tabsForLoop } from './helpers'
import type { LoopTab } from './helpers'
import {
  FilterBar,
  Timestamp,
  RepoMenu,
  RepoIndexPane,
  Breadcrumb,
  SectionNav,
  LoopTable,
  LoopDetail,
  EmptyState,
  GroupsPanel,
  GroupDetail,
  FindingsPanel,
  PlansPanel,
  type MatchedEntry,
  type LoopOption,
  type LoopNav,
} from './components'

export function App() {
  // ── Reactive state ──────────────────────────────────────────────────────

  const [state, setState] = createStore<DashboardPayload>({
    generatedAt: 0,
    projects: [],
  })
  const [loaded, setLoaded] = createSignal(false)
  const [route, setRoute] = createSignal<DashboardRoute>(parseDashboardHash(''))
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [sortMode, setSortMode] = createSignal<SortMode>('recent')
  const [externalNav, setExternalNav] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

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
        // Keyed reconcile by `id`: projects identify by `projectId`, loops
        // identify by `loopName` (unique within a project's loop set). Both
        // surfaces expose a top-level `id` field (see dashboard/data.ts), so a
        // single key option covers both levels. Positional fallback would have
        // mutated loop proxies in place on reorder — selecting loop A while a
        // newer loop B sorts ahead after A completes would silently swap
        // identities, tearing down the selected loop's SVG subtree. Keying by
        // `id` preserves the proxy for each loop across reorders.
        setState(reconcile(json, { key: 'id' }))
        setLoaded(true)
        setLoadError(null)
      }
      setNow(Date.now())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError('Failed to load dashboard data: ' + msg)
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  const navigate = (patch: Partial<DashboardRoute>) => {
    setRoute(r => {
      const next: DashboardRoute = { ...r, ...patch }
      if (patch.projectId !== undefined && patch.projectId !== r.projectId) {
        next.statuses = []
        next.query = ''
      }
      return next
    })
  }

  const selectTab = (t: LoopTab) => {
    navigate({ tab: t })
  }

  const openLoop = (name: string) => {
    navigate({ loopName: name, section: 'loops', groupId: null, statuses: [], query: '', tab: 'overview' })
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  const toggleStatus = (key: string) => {
    const next = new Set(route().statuses)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    navigate({ statuses: [...next] })
  }

  const handleChangeQuery = (q: string) => {
    navigate({ query: q })
  }

  const handleChangeSort = (m: SortMode) => {
    setSortMode(m)
  }

  // ── Derived memos ───────────────────────────────────────────────────────

  const activeStatusSet = createMemo(() => new Set(route().statuses))

  const repoLabels = createMemo(() =>
    buildRepoLabels(state.projects.map(p => p.projectDir || p.projectId || '')),
  )

  const matchedByProject = createMemo<MatchedEntry[]>(() => {
    if (!loaded() || state.projects.length === 0) return []
    const statuses = activeStatusSet()
    const search = route().query
    const labels = repoLabels()
    const result: MatchedEntry[] = []
    const q = search.trim().toLowerCase()
    for (const proj of state.projects) {
      const matched: DashboardLoop[] = []
      const rawPath = proj.projectDir || proj.projectId || ''
      const label = labels.get(rawPath) ?? rawPath
      for (const dashLoop of proj.loops) {
        if (loopMatchesFilters(dashLoop.loop, statuses, search, label)) {
          matched.push(dashLoop)
        }
      }
      const hasGroups = (proj.groups?.length ?? 0) > 0
      if (matched.length > 0) {
        result.push({ proj, loops: matched })
      } else if (hasGroups && (!q || label.toLowerCase().indexOf(q) !== -1)) {
        result.push({ proj, loops: [] })
      }
    }
    return result
  })

  const atRepoIndex = createMemo(() => route().projectId === null)

  const atGroupsSection = createMemo(() => route().section === 'groups')
  const atLoopsSection = createMemo(() => route().section === 'loops')
  const atFindingsSection = createMemo(() => route().section === 'findings')
  const atPlansSection = createMemo(() => route().section === 'plans')

  const selectedEntry = createMemo<MatchedEntry | null>(() => {
    const entries = matchedByProject()
    const pid = route().projectId
    if (!pid) return null
    return entries.find(e => e.proj.projectId === pid) ?? null
  })

  const activeLoop = createMemo<DashboardLoop | null>(() => {
    const r = route()
    if (!r.projectId || !r.loopName) return null
    const proj = selectedRepoProject()
    if (!proj) return null
    return proj.loops.find(l => l.loop.loopName === r.loopName) ?? null
  })

  const selectedRepoProject = createMemo<DashboardProject | null>(() => {
    const pid = route().projectId
    if (!pid) return null
    return state.projects.find(p => p.projectId === pid) ?? null
  })

  const sectionCounts = createMemo(() => {
    const proj = selectedRepoProject()
    const groups = proj?.groups?.length ?? 0
    if (!proj) return { loops: 0, groups, findings: 0, plans: 0 }
    let findings = 0
    let plans = 0
    for (const dl of proj.loops) {
      findings += dl.findings.length
      if (dl.plan) plans++
    }
    return { loops: proj.loops.length, groups, findings, plans }
  })

  const repoLoopOptions = createMemo<LoopOption[]>(() => {
    const proj = selectedRepoProject()
    if (!proj) return []
    return proj.loops
      .map(dl => ({ name: dl.loop.loopName, when: dl.loop.completedAt || dl.loop.startedAt || 0 }))
      .sort((a, b) => (b.when - a.when) || a.name.localeCompare(b.name))
  })

  const currentLoopIndex = createMemo(() => {
    const name = route().loopName
    if (!name) return -1
    return repoLoopOptions().findIndex(o => o.name === name)
  })

  const loopNav = createMemo<LoopNav | null>(() => {
    const i = currentLoopIndex()
    if (i < 0) return null
    const options = repoLoopOptions()
    if (options.length <= 1) return null
    return {
      index: i,
      total: options.length,
      onPrev: () => { if (i > 0) navigate({ loopName: options[i - 1].name }) },
      onNext: () => { if (i < options.length - 1) navigate({ loopName: options[i + 1].name }) },
    }
  })

  const selectedRepoCounts = createMemo(() => {
    const proj = selectedRepoProject()
    const c = { running: 0, completed: 0, cancelled: 0, errored: 0, stalled: 0 }
    if (!proj) return c
    for (const dl of proj.loops) {
      const s = dl.loop.status
      if (s === 'running') c.running++
      else if (s === 'completed') c.completed++
      else if (s === 'cancelled') c.cancelled++
      else if (s === 'errored') c.errored++
      else if (s === 'stalled') c.stalled++
    }
    return c
  })

  // ── View nodes ──────────────────────────────────────────────────────────
  // These memos return DOM nodes. Because a memo only re-emits when its value
  // changes, the detail subtree is built once per selected loop (stable store
  // reference) and survives polls, preserving markdown scroll / resize state;
  // only the loop's fields update in place via the reactive reads inside it.

  const breadcrumbView = createMemo(() => {
    const r = route()
    if (!r.projectId) return ''
    const proj = selectedRepoProject()
    if (!proj) return ''
    const rawPath = proj.projectDir || proj.projectId || ''
    const label = repoLabels().get(rawPath) ?? rawPath
    return untrack(() => Breadcrumb({
      repoLabel: label,
      projectDir: rawPath,
      loopName: r.loopName,
      loops: repoLoopOptions,
      loopNav,
      onSelectLoop: (name: string) => navigate({ loopName: name }),
      onBackToRepos: () => navigate({ projectId: null, loopName: null, section: 'loops' }),
      onBackToRepo: () => navigate({ loopName: null }),
    })) as Node
  })

  const sectionNavView = createMemo(() => {
    const r = route()
    if (!r.projectId || r.loopName) return ''
    return SectionNav({
      section: r.section,
      counts: sectionCounts(),
      onNavigate: (section) => navigate({ section, loopName: null, groupId: null }),
    }) as Node
  })

  const filterBarVisible = createMemo(() => {
    const r = route()
    return r.projectId !== null && r.loopName === null && r.section === 'loops'
  })

  const filterBarView = createMemo<Node | string>(() => {
    if (!filterBarVisible()) return ''
    return untrack(() => FilterBar({
      counts: selectedRepoCounts,
      statuses: activeStatusSet,
      query: () => route().query,
      sortMode,
      onToggleStatus: toggleStatus,
      onChangeQuery: handleChangeQuery,
      onChangeSort: handleChangeSort,
      externalNav,
    }) as Node)
  })

  const detailView = createMemo<Node | string>(() => {
    if (!atLoopsSection()) return ''
    const loop = activeLoop()
    return loop
      ? (LoopDetail({
          dashLoop: loop,
          now,
          routeTab: () => route().tab,
          onSelectTab: selectTab,
        }) as Node)
      : ''
  })

  const listView = createMemo<Node | string>(() => {
    if (!atLoopsSection()) return ''
    if (activeLoop()) return ''
    const r = route()
    if (!r.projectId) return ''
    return html`<div class="repo-loop-pane">
      ${LoopTable({
        loops: () => {
          const e = selectedEntry()
          return e ? sortLoops(e.loops, sortMode()) : []
        },
        now,
        onOpen: (name: string) => openLoop(name),
      })}
      ${() => (selectedEntry() ? '' : EmptyState() as Node)}
    </div>` as Node
  })

  const selectedGroup = createMemo<DashboardGroup | null>(() => {
    const r = route()
    if (r.section !== 'groups' || !r.groupId) return null
    const proj = selectedRepoProject()
    if (!proj) return null
    return proj.groups.find(g => g.group.groupId === r.groupId) ?? null
  })

  const repoLoopNames = createMemo(() => {
    const proj = selectedRepoProject()
    if (!proj) return new Set<string>()
    return new Set(proj.loops.map(l => l.loop.loopName))
  })

  const groupsView = createMemo<Node | string>(() => {
    if (!atGroupsSection()) return ''
    const r = route()
    if (!r.projectId) return ''
    if (r.groupId) {
      return GroupDetail({
        group: selectedGroup,
        loopNames: repoLoopNames,
        projectId: () => route().projectId,
        onBack: () => navigate({ groupId: null }),
        onOpenLoop: openLoop,
      }) as Node
    }
    return GroupsPanel({
      groups: () => selectedRepoProject()?.groups ?? [],
      onOpen: (groupId: string) => navigate({ groupId }),
    }) as Node
  })

  const repoAllLoops = createMemo<DashboardLoop[]>(() => {
    const proj = selectedRepoProject()
    return proj ? proj.loops : []
  })

  const findingsView = createMemo<Node | string>(() => {
    if (!atFindingsSection()) return ''
    const r = route()
    if (!r.projectId) return ''
    return FindingsPanel({
      loops: repoAllLoops,
      projectId: () => route().projectId,
      onOpenLoop: openLoop,
    }) as Node
  })

  const plansView = createMemo<Node | string>(() => {
    if (!atPlansSection()) return ''
    const r = route()
    if (!r.projectId) return ''
    return PlansPanel({
      loops: repoAllLoops,
      onOpenLoop: openLoop,
    }) as Node
  })

  // ── Effects ─────────────────────────────────────────────────────────────

  createEffect(() => {
    if (!loaded()) return
    const r = route()
    if (r.projectId === null) return
    const exists = state.projects.some(p => p.projectId === r.projectId)
    if (!exists) {
      setRoute(prev => ({ ...prev, projectId: null, loopName: null, section: 'loops', statuses: [], query: '' }))
    }
  })

  createEffect(() => {
    const r = route()
    if (!r.projectId || !r.loopName) return
    const proj = selectedRepoProject()
    if (!proj) return
    const exists = proj.loops.some(l => l.loop.loopName === r.loopName)
    if (!exists) {
      setRoute(prev => ({ ...prev, loopName: null }))
    }
  })

  createEffect(() => {
    const r = route()
    if (!r.projectId || !r.loopName || r.tab === 'overview') return
    const loop = activeLoop()
    if (!loop) return
    const tabs = tabsForLoop(loop)
    if (!tabs.includes(r.tab)) {
      setRoute(prev => ({ ...prev, tab: 'overview' }))
    }
  })

  createEffect(() => {
    if (!loaded()) return
    syncHash(buildDashboardHash(route()), suppressHashChangeRef)
  })

  // ── Lifecycle ───────────────────────────────────────────────────────────

  onMount(() => {
    setRoute(parseDashboardHash(location.hash))

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
      setRoute(parseDashboardHash(location.hash))
      setExternalNav(n => n + 1)
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
    <h1><a class="forge-home" href="#">Forge Dashboard</a></h1>

    ${() => {
      const err = loadError()
      return err ? html`<div class="error-text">${err}</div>` : ''
    }}

    ${() => {
      if (!loaded()) return ''
      return html`<div class="dashboard-summary">
        ${Timestamp({ generatedAt: state.generatedAt })}
      </div>`
    }}

    ${() => {
      if (!loaded()) return ''
      if (atRepoIndex() && matchedByProject().length === 0) return EmptyState()
      return html`<div class="forge-shell">
        ${() => {
          if (atRepoIndex()) {
            return html`<div class="repo-index">
              ${RepoMenu({
                entries: () => matchedByProject(),
                labels: () => repoLabels(),
                onSelect: (projectId: string) => navigate({ projectId, loopName: null, section: 'loops', groupId: null }),
              })}
              ${RepoIndexPane({
                entries: () => matchedByProject(),
                labels: () => repoLabels(),
                onOpenLoop: (projectId: string, loopName: string) =>
                  navigate({ projectId, loopName, section: 'loops', groupId: null, statuses: [], query: '', tab: 'overview' }),
              })}
            </div>`
          }
          return html`<div class="repo-pane">
            ${breadcrumbView}
            ${filterBarView}
            ${sectionNavView}
            ${listView}
            ${detailView}
            ${groupsView}
            ${findingsView}
            ${plansView}
          </div>`
        }}
      </div>`
    }}
  </div>`
}
