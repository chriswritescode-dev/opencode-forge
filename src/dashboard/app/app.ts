import { createSignal, createMemo, createEffect, onMount, onCleanup, untrack, on, batch } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import html from 'solid-js/html'
import type { DashboardPayload, DashboardProject, DashboardLoop, DashboardGroup } from './types'
import type { DashboardRoute, SortMode, RepoSection, LoopTab } from './helpers'
import { parseDashboardHash, buildDashboardHash, syncHash, dataHash, loopMatchesFilters, buildRepoLabels, repoRawPath, repoLabel, loopActivityAt, sortLoops, tabsForLoop, sameList, fmtTime } from './helpers'
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
  const initialRoute = parseDashboardHash(typeof location !== 'undefined' ? location.hash : '')
  const [projectId, setProjectId] = createSignal<string | null>(initialRoute.projectId)
  const [section, setSection] = createSignal<RepoSection>(initialRoute.section)
  const [loopName, setLoopName] = createSignal<string | null>(initialRoute.loopName)
  const [tab, setTab] = createSignal<LoopTab>(initialRoute.tab)
  const [groupId, setGroupId] = createSignal<string | null>(initialRoute.groupId)
  const [statuses, setStatuses] = createSignal<string[]>(initialRoute.statuses, { equals: sameList })
  const [query, setQuery] = createSignal(initialRoute.query)
  // Rebuilt only for the hash-serialisation boundary and the scope key; the
  // derived memos below read the individual fields so a tab change no longer
  // invalidates the filter/match pass.
  const route = createMemo<DashboardRoute>(() => ({
    projectId: projectId(),
    section: section(),
    loopName: loopName(),
    tab: tab(),
    groupId: groupId(),
    statuses: statuses(),
    query: query(),
  }))
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [sortMode, setSortMode] = createSignal<SortMode>('recent')
  const [externalNav, setExternalNav] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  // Non-reactive refs
  const lastDataHashRef = { current: '' }
  const suppressHashChangeRef = { current: false }

  // ── Data fetching ───────────────────────────────────────────────────────

  const scopedDataUrl = (): string => {
    const r = untrack(route)
    const params = new URLSearchParams()
    if (r.projectId) params.set('project', r.projectId)
    if (r.loopName) params.set('loop', r.loopName)
    const qs = params.toString()
    return qs ? '/api/data?' + qs : '/api/data'
  }

  // Request coordination: every issued load() bumps the generation counter and
  // records the scoped URL it was issued for. A response is accepted only if
  // its generation still matches the latest issued request, so a late response
  // from a superseded scope (a navigation mid-flight, or two rapid scope
  // changes) can never clobber the current scope's data. While a request is in
  // flight for the current scoped URL, subsequent calls (the 5s interval poll)
  // are coalesced rather than bumping the generation — otherwise a slow
  // /api/data response would be permanently invalidated by every tick and
  // never render. A genuine scope change still issues a fresh request
  // immediately because its URL differs from the in-flight URL. The hash check
  // still dedups identical payloads.
  let loadGen = 0
  const inFlight = { url: null as string | null, gen: 0 }

  const load = async () => {
    const url = scopedDataUrl()
    if (inFlight.url === url) return // coalesce overlapping same-scope polls
    const gen = ++loadGen
    inFlight.url = url
    inFlight.gen = gen
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (gen !== loadGen) return
      const json: DashboardPayload = await res.json()
      if (gen !== loadGen) return
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
      if (gen !== loadGen) return
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError('Failed to load dashboard data: ' + msg)
    } finally {
      if (inFlight.gen === gen) {
        inFlight.url = null
        inFlight.gen = 0
      }
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  const applyRoute = (next: DashboardRoute) => {
    batch(() => {
      setProjectId(next.projectId)
      setSection(next.section)
      setLoopName(next.loopName)
      setTab(next.tab)
      setGroupId(next.groupId)
      setStatuses(next.statuses)
      setQuery(next.query)
    })
  }

  const navigate = (patch: Partial<DashboardRoute>) => {
    batch(() => {
      const projectChanged = patch.projectId !== undefined && patch.projectId !== projectId()
      if (patch.projectId !== undefined) setProjectId(patch.projectId)
      if (patch.section !== undefined) setSection(patch.section)
      if (patch.loopName !== undefined) setLoopName(patch.loopName)
      if (patch.tab !== undefined) setTab(patch.tab)
      if (patch.groupId !== undefined) setGroupId(patch.groupId)
      if (patch.statuses !== undefined) setStatuses(patch.statuses)
      if (patch.query !== undefined) setQuery(patch.query)
      if (projectChanged) {
        setStatuses([])
        setQuery('')
      }
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
    const next = new Set(statuses())
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

  const activeStatusSet = createMemo(() => new Set(statuses()))

  const repoLabels = createMemo(() => buildRepoLabels(state.projects.map(repoRawPath)))

  const matchedByProject = createMemo<MatchedEntry[]>(() => {
    if (!loaded() || state.projects.length === 0) return []
    const statuses = activeStatusSet()
    const search = query()
    const labels = repoLabels()
    const result: MatchedEntry[] = []
    const q = search.trim().toLowerCase()
    for (const proj of state.projects) {
      const matched: DashboardLoop[] = []
      const label = repoLabel(labels, proj)
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

  const atRepoIndex = createMemo(() => projectId() === null)

  const atGroupsSection = createMemo(() => section() === 'groups')
  const atLoopsSection = createMemo(() => section() === 'loops')
  const atFindingsSection = createMemo(() => section() === 'findings')
  const atPlansSection = createMemo(() => section() === 'plans')

  const selectedEntry = createMemo<MatchedEntry | null>(() => {
    const entries = matchedByProject()
    const pid = projectId()
    if (!pid) return null
    return entries.find(e => e.proj.projectId === pid) ?? null
  })

  const selectedRepoProject = createMemo<DashboardProject | null>(() => {
    const pid = projectId()
    if (!pid) return null
    return state.projects.find(p => p.projectId === pid) ?? null
  })

  const activeLoop = createMemo<DashboardLoop | null>(() => {
    const pid = projectId()
    const name = loopName()
    if (!pid || !name) return null
    const proj = selectedRepoProject()
    if (!proj) return null
    return proj.loops.find(l => l.loop.loopName === name) ?? null
  })

  const sectionCounts = createMemo(() => {
    const proj = selectedRepoProject()
    const groups = proj?.groups?.length ?? 0
    if (!proj) return { loops: 0, groups, findings: 0, plans: 0 }
    let findings = 0
    let plans = 0
    for (const dl of proj.loops) {
      findings += dl.findings.length
      if (dl.hasPlan) plans++
    }
    return { loops: proj.loops.length, groups, findings, plans }
  })

  const repoLoopOptions = createMemo<LoopOption[]>(() => {
    const proj = selectedRepoProject()
    if (!proj) return []
    return proj.loops
      .map(dl => {
        const when = loopActivityAt(dl.loop)
        return { name: dl.loop.loopName, when, whenLabel: fmtTime(when) }
      })
      .sort((a, b) => (b.when - a.when) || a.name.localeCompare(b.name))
  })

  const currentLoopIndex = createMemo(() => {
    const name = loopName()
    if (!name) return -1
    return repoLoopOptions().findIndex(o => o.name === name)
  })

  const loopNav = createMemo<LoopNav | null>(() => {
    const i = currentLoopIndex()
    if (i < 0) return null
    const options = repoLoopOptions()
    if (options.length <= 1) return null
    // The equality option below preserves the breadcrumb DOM when only the
    // neighbour identities change. The callbacks therefore cannot close over
    // `i`/`options` — a retained node must read the current index and option
    // set at click time so a poll that re-orders neighbours navigates to the
    // current adjacent loop, not the stale one captured at memo run.
    return {
      index: i,
      total: options.length,
      onPrev: () => {
        const cur = currentLoopIndex()
        const opts = repoLoopOptions()
        if (cur > 0) navigate({ loopName: opts[cur - 1].name })
      },
      onNext: () => {
        const cur = currentLoopIndex()
        const opts = repoLoopOptions()
        if (cur < opts.length - 1) navigate({ loopName: opts[cur + 1].name })
      },
    }
  }, null, {
    equals: (a, b) => a === b || (!!a && !!b && a.index === b.index && a.total === b.total),
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
    const name = loopName()
    if (!projectId()) return ''
    const proj = selectedRepoProject()
    if (!proj) return ''
    const rawPath = repoRawPath(proj)
    const label = repoLabel(repoLabels(), proj)
    return untrack(() => Breadcrumb({
      repoLabel: label,
      projectDir: rawPath,
      loopName: name,
      loops: repoLoopOptions,
      loopNav,
      onSelectLoop: (name: string) => navigate({ loopName: name }),
      onBackToRepos: () => navigate({ projectId: null, loopName: null, section: 'loops' }),
      onBackToRepo: () => navigate({ loopName: null }),
    })) as Node
  })

  const sectionNavView = createMemo(() => {
    const pid = projectId()
    const name = loopName()
    if (!pid || name) return ''
    return SectionNav({
      section: section(),
      counts: sectionCounts(),
      onNavigate: (section) => navigate({ section, loopName: null, groupId: null }),
    }) as Node
  })

  const filterBarVisible = createMemo(() => {
    return projectId() !== null && loopName() === null && section() === 'loops'
  })

  const filterBarView = createMemo<Node | string>(() => {
    if (!filterBarVisible()) return ''
    return untrack(() => FilterBar({
      counts: selectedRepoCounts,
      statuses: activeStatusSet,
      query,
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
          routeTab: tab,
          onSelectTab: selectTab,
        }) as Node)
      : ''
  })

  const visibleLoops = createMemo<DashboardLoop[]>(() => {
    const e = selectedEntry()
    return e ? sortLoops(e.loops, sortMode()) : []
  }, [], { equals: sameList })

  const listView = createMemo<Node | string>(() => {
    if (!atLoopsSection()) return ''
    if (activeLoop()) return ''
    if (!projectId()) return ''
    return html`<div class="repo-loop-pane">
      ${LoopTable({
        loops: visibleLoops,
        now,
        onOpen: (name: string) => openLoop(name),
      })}
      ${() => (selectedEntry() ? '' : EmptyState() as Node)}
    </div>` as Node
  })

  const selectedGroup = createMemo<DashboardGroup | null>(() => {
    if (section() !== 'groups' || !groupId()) return null
    const proj = selectedRepoProject()
    if (!proj) return null
    return proj.groups.find(g => g.group.groupId === groupId()) ?? null
  })

  const repoLoopNames = createMemo(() => {
    const proj = selectedRepoProject()
    if (!proj) return new Set<string>()
    return new Set(proj.loops.map(l => l.loop.loopName))
  })

  const groupsView = createMemo<Node | string>(() => {
    if (!atGroupsSection()) return ''
    const pid = projectId()
    if (!pid) return ''
    if (groupId()) {
      return GroupDetail({
        group: selectedGroup,
        loopNames: repoLoopNames,
        projectId: () => projectId(),
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
    const pid = projectId()
    if (!pid) return ''
    return FindingsPanel({
      loops: repoAllLoops,
      projectId: () => projectId(),
      onOpenLoop: openLoop,
    }) as Node
  })

  const plansView = createMemo<Node | string>(() => {
    if (!atPlansSection()) return ''
    const pid = projectId()
    if (!pid) return ''
    return PlansPanel({
      loops: repoAllLoops,
      onOpenLoop: openLoop,
    }) as Node
  })

  // ── Effects ─────────────────────────────────────────────────────────────

  createEffect(() => {
    if (!loaded()) return
    const pid = projectId()
    if (pid === null) return
    const exists = state.projects.some(p => p.projectId === pid)
    if (!exists) {
      setProjectId(null)
      setLoopName(null)
      setSection('loops')
      setStatuses([])
      setQuery('')
    }
  })

  createEffect(() => {
    const pid = projectId()
    const name = loopName()
    if (!pid || !name) return
    const proj = selectedRepoProject()
    if (!proj) return
    const exists = proj.loops.some(l => l.loop.loopName === name)
    if (!exists) {
      setLoopName(null)
    }
  })

  createEffect(() => {
    const name = loopName()
    const t = tab()
    if (!projectId() || !name || t === 'overview') return
    const loop = activeLoop()
    if (!loop) return
    const tabs = tabsForLoop(loop)
    if (!tabs.includes(t)) {
      setTab('overview')
    }
  })

  createEffect(() => {
    if (!loaded()) return
    syncHash(buildDashboardHash(route()), suppressHashChangeRef)
  })

  // A scope change means the server owes us different detail; poll immediately
  // rather than waiting up to 5s. The previous detail stays rendered until the
  // response lands, so reconcile swaps content in place and the keep-mounted
  // node identity contract is preserved. `on(..., { defer: true })` runs the
  // effect only on subsequent scopeKey changes, never on first execution, so
  // the initial mount issues exactly one request (via onMount's load()).
  const scopeKey = createMemo(() => (projectId() ?? '') + '\u0000' + (loopName() ?? ''))
  createEffect(on(scopeKey, () => {
    void load()
  }, { defer: true }))

  // ── Lifecycle ───────────────────────────────────────────────────────────

  onMount(() => {
    // Route was already adopted from `location.hash` at signal setup. Syncing
    // here again is a no-op for scope (and thus for the deferred scope effect),
    // so the explicit load() below is the one and only initial fetch.
    applyRoute(parseDashboardHash(location.hash))

    // Initial load + background poll.
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
      applyRoute(parseDashboardHash(location.hash))
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
