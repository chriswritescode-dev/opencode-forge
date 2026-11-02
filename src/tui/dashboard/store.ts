import type { Plugin } from '@opencode/plugin/tui'
import { createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import type {
  ForgeAmendmentDiff,
  ForgeAmendmentDiffOutput,
  ForgeDashboardLoopSummary,
  ForgeDashboardProjectSummary,
  ForgeDashboardSummary,
  ForgeDashboardSummaryOutput,
  ForgeLoopDetail,
  ForgeLoopDetailOutput,
  ForgePlanDeleteOutput,
  ForgeProjectFindings,
  ForgeProjectFindingsLoop,
  ForgeProjectFindingsOutput,
  ForgeSessionPlanOutput,
  ForgeToastInput,
} from '../../host/forge-rpc'
import { createRefetchCoordinator } from '../refetch-coordinator'
import {
  MAX_RENDERED_LOOP_ROWS,
  capList,
  filterDashboardProjects,
  filterLoopsByStatus,
  nextSortMode,
  nextStatusFilter,
  shareUnchanged,
  sortLoops,
  statusCounts,
  type CappedList,
  type LoopStatusFilter,
  type LoopTab,
  type SortMode,
} from './view-model'

export type DashboardSection = 'loops' | 'findings' | 'plans'

export type DashboardChangeType = 'loops' | 'plans'

/** The TUI route the dashboard returns to; the plugin package does not export it directly. */
export type DashboardRoute = ReturnType<Plugin.Context['ui']['router']['current']>

/** Routes owned by the dashboard; opening from one of them must keep the pre-dashboard return route. */
const DASHBOARD_ROUTE_NAMES = new Set(['forge-dashboard', 'forge-dashboard-loop'])

/** Trailing debounce that collapses a burst of backend events into one summary refresh. */
export const DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS = 150

/** Copies a route so the host mutating its live route object cannot rewrite the return route. */
function snapshotRoute(route: DashboardRoute): DashboardRoute {
  if (route.type !== 'plugin' || !route.data) return { ...route }
  return { ...route, data: { ...route.data } }
}

export interface DashboardStoreDeps {
  readSummary(): Promise<ForgeDashboardSummaryOutput>
  readLoopDetail(input: { projectId: string; loopName: string }): Promise<ForgeLoopDetailOutput>
  readProjectFindings(input: { projectId: string }): Promise<ForgeProjectFindingsOutput>
  readAmendmentDiff(input: { projectId: string; loopName: string; id: number }): Promise<ForgeAmendmentDiffOutput>
  readSessionPlan(input: { projectId: string; sessionId: string }): Promise<ForgeSessionPlanOutput>
  deletePlan(input: { projectId: string; sessionId: string }): Promise<ForgePlanDeleteOutput>
  currentDirectory(): string | null
  resolveProjectId(directory: string): Promise<string | null>
  confirm(input: { title: string; message: string }): Promise<boolean>
  toast(input: ForgeToastInput): void
}

export interface DashboardStore {
  summary: Accessor<ForgeDashboardSummary | null>
  error: Accessor<string | null>
  returnRoute: Accessor<DashboardRoute | null>

  query: Accessor<string>
  searchFocused: Accessor<boolean>
  selectedProjectId: Accessor<string | null>
  section: Accessor<DashboardSection>
  cursor: Accessor<number>
  sort: Accessor<SortMode>
  statusFilter: Accessor<LoopStatusFilter>
  planSessionId: Accessor<string | null>
  planContent: Accessor<string | null>
  planError: Accessor<string | null>

  loopProjectId: Accessor<string | null>
  loopName: Accessor<string | null>
  loopTab: Accessor<LoopTab>
  detail: Accessor<ForgeLoopDetail | null>
  detailError: Accessor<string | null>
  loopScrollTop: Accessor<number>
  expandedAmendmentId: Accessor<number | null>
  amendmentDiff: Accessor<ForgeAmendmentDiff | null>

  projects: Accessor<ForgeDashboardProjectSummary[]>
  selectedProject: Accessor<ForgeDashboardProjectSummary | null>
  loopRows: Accessor<CappedList<ForgeDashboardLoopSummary>>
  loopStatusCounts: Accessor<Record<LoopStatusFilter, number>>
  findings: Accessor<ForgeProjectFindingsLoop[]>
  findingsError: Accessor<string | null>

  open(returnRoute: DashboardRoute): void
  activate(): void
  deactivate(): void
  handleChange(type: DashboardChangeType, projectId: string): void
  handleResubscribed(): void
  dispose(): void

  setQuery(query: string): void
  focusSearch(): void
  blurSearch(): void
  selectProject(projectId: string | null): void
  setSection(section: DashboardSection): void
  setCursor(cursor: number): void
  cycleSort(): void
  cycleStatusFilter(): void
  openPlan(sessionId: string): void
  closePlan(): void
  deleteSelectedPlan(): Promise<void>
  openLoop(projectId: string, loopName: string): void
  closeLoop(): void
  setLoopTab(tab: LoopTab): void
  setLoopScrollTop(scrollTop: number): void
  toggleAmendment(id: number): Promise<void>
}

/**
 * Every dashboard value, held outside the pages because the TUI remounts a page
 * on each navigation. Fetches coalesce per surface and a result for a selection
 * that has since changed is dropped. While no page is mounted, change events
 * only mark state stale so a closed dashboard never fetches.
 */
export function createDashboardStore(deps: DashboardStoreDeps): DashboardStore {
  const [summary, setSummary] = createSignal<ForgeDashboardSummary | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const [query, setQuerySignal] = createSignal('')
  const [searchFocused, setSearchFocused] = createSignal(false)
  const [selectedProjectId, setSelectedProjectIdSignal] = createSignal<string | null>(null)
  const [section, setSectionSignal] = createSignal<DashboardSection>('loops')
  const [cursor, setCursorSignal] = createSignal(0)
  const [sort, setSortSignal] = createSignal<SortMode>('recent')
  const [statusFilter, setStatusFilterSignal] = createSignal<LoopStatusFilter>('all')
  const [planSessionId, setPlanSessionId] = createSignal<string | null>(null)
  const [planContent, setPlanContent] = createSignal<string | null>(null)
  const [planError, setPlanError] = createSignal<string | null>(null)

  const [findingsByProject, setFindingsByProject] = createSignal<Record<string, ForgeProjectFindings>>({})
  const [findingsError, setFindingsError] = createSignal<string | null>(null)

  const [loopProjectId, setLoopProjectId] = createSignal<string | null>(null)
  const [loopName, setLoopName] = createSignal<string | null>(null)
  const [loopTab, setLoopTabSignal] = createSignal<LoopTab>('overview')
  const [detail, setDetail] = createSignal<ForgeLoopDetail | null>(null)
  const [detailError, setDetailError] = createSignal<string | null>(null)
  const [loopScrollTop, setLoopScrollTopSignal] = createSignal(0)
  const [expandedAmendmentId, setExpandedAmendmentId] = createSignal<number | null>(null)
  const [amendmentDiff, setAmendmentDiff] = createSignal<ForgeAmendmentDiff | null>(null)

  const [returnRoute, setReturnRoute] = createSignal<DashboardRoute | null>(null)

  let activeCount = 0
  let openGeneration = 0
  let summaryStale = false
  let detailStale = false
  let planStale = false
  let detailGeneration = 0
  let findingsGeneration = 0
  let planGeneration = 0
  let amendmentGeneration = 0
  let loadedAmendmentId: number | null = null
  let summaryDebounce: ReturnType<typeof setTimeout> | null = null
  const staleFindings = new Set<string>()

  return createRoot((disposeRoot) => {
    const cancelSummaryDebounce = (): void => {
      if (summaryDebounce === null) return
      clearTimeout(summaryDebounce)
      summaryDebounce = null
    }

    const refreshSummary = (): void => {
      cancelSummaryDebounce()
      summaryStale = false
      summaryCoordinator.trigger()
    }

    const scheduleSummaryRefresh = (): void => {
      cancelSummaryDebounce()
      summaryDebounce = setTimeout(() => {
        summaryDebounce = null
        refreshSummary()
      }, DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS)
    }

    const summaryCoordinator = createRefetchCoordinator(async () => {
      const result = await deps.readSummary()
      if ('error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setSummary((previous) => shareUnchanged(previous, result))
    })

    const refreshDetail = (): void => {
      detailStale = false
      detailCoordinator.trigger()
    }

    const detailCoordinator = createRefetchCoordinator(async () => {
      const projectId = loopProjectId()
      const name = loopName()
      if (!projectId || !name) return
      const generation = detailGeneration
      const result = await deps.readLoopDetail({ projectId, loopName: name })
      if (generation !== detailGeneration) return
      if ('error' in result) {
        setDetailError(result.error)
        return
      }
      setDetailError(null)
      setDetail((previous) =>
        previous
        && previous.loop.projectId === result.loop.projectId
        && previous.loop.loopName === result.loop.loopName
          ? shareUnchanged(previous, result)
          : result)
    })

    const refreshFindings = (): void => {
      findingsCoordinator.trigger()
    }

    const findingsCoordinator = createRefetchCoordinator(async () => {
      const projectId = selectedProjectId()
      if (!projectId) return
      const generation = findingsGeneration
      const result = await deps.readProjectFindings({ projectId })
      if (generation !== findingsGeneration || selectedProjectId() !== projectId) return
      if ('error' in result) {
        setFindingsError(result.error)
        return
      }
      staleFindings.delete(projectId)
      setFindingsError(null)
      setFindingsByProject((cache) => ({ ...cache, [projectId]: result }))
    })

    const refreshPlan = (): void => {
      planStale = false
      const projectId = selectedProjectId()
      const sessionId = planSessionId()
      if (!projectId || !sessionId) return
      const generation = ++planGeneration
      void deps.readSessionPlan({ projectId, sessionId }).then((result) => {
        if (generation !== planGeneration || planSessionId() !== sessionId) return
        if ('error' in result) {
          setPlanError(result.error)
          return
        }
        if (result.plan === null) {
          setPlanError('Plan not found')
          return
        }
        setPlanError(null)
        setPlanContent(result.plan)
      })
    }

    const ensureFindings = (): void => {
      const projectId = selectedProjectId()
      if (!projectId) return
      if (staleFindings.has(projectId) || !findingsByProject()[projectId]) refreshFindings()
    }

    const refreshMissing = (): void => {
      if (summaryStale || summary() === null) refreshSummary()
      if (loopName() && (detailStale || detail() === null)) refreshDetail()
      if (section() === 'findings') ensureFindings()
      if (planSessionId() && (planStale || (planContent() === null && planError() === null))) refreshPlan()
    }

    const refreshVisible = (): void => {
      refreshSummary()
      if (loopName()) refreshDetail()
      if (section() === 'findings') ensureFindings()
      if (planSessionId()) refreshPlan()
    }

    const open = (route: DashboardRoute): void => {
      if (!(route.type === 'plugin' && DASHBOARD_ROUTE_NAMES.has(route.name))) setReturnRoute(snapshotRoute(route))
      const generation = ++openGeneration
      const directory = deps.currentDirectory()
      refreshSummary()
      if (!directory) return
      void deps.resolveProjectId(directory).then((projectId) => {
        if (generation !== openGeneration || deps.currentDirectory() !== directory) return
        if (projectId) selectProject(projectId)
      })
    }

    const activate = (): void => {
      activeCount++
      if (activeCount > 1) return
      refreshMissing()
    }

    const deactivate = (): void => {
      activeCount = Math.max(0, activeCount - 1)
      if (activeCount === 0) cancelSummaryDebounce()
    }

    const handleChange = (type: DashboardChangeType, projectId: string): void => {
      summaryStale = true
      const loopsChanged = type === 'loops'
      const loopMatches = loopsChanged && loopName() !== null && loopProjectId() === projectId
      const findingsVisible = loopsChanged && section() === 'findings' && selectedProjectId() === projectId
      if (loopMatches) detailStale = true
      if (loopsChanged) staleFindings.add(projectId)
      const planMatches = type === 'plans' && selectedProjectId() === projectId
      if (planMatches) planStale = true
      if (activeCount === 0) return
      scheduleSummaryRefresh()
      if (loopMatches) refreshDetail()
      if (findingsVisible) refreshFindings()
      if (planMatches) refreshPlan()
    }

    const handleResubscribed = (): void => {
      summaryStale = true
      if (loopName()) detailStale = true
      for (const cachedProjectId of Object.keys(findingsByProject())) staleFindings.add(cachedProjectId)
      const projectId = selectedProjectId()
      if (section() === 'findings' && projectId) staleFindings.add(projectId)
      if (planSessionId()) planStale = true
      if (activeCount === 0) return
      refreshVisible()
    }

    const selectProject = (projectId: string | null): void => {
      if (selectedProjectId() === projectId) return
      setSelectedProjectIdSignal(projectId)
      findingsGeneration++
      setCursorSignal(0)
      setPlanSessionId(null)
      setPlanContent(null)
      setPlanError(null)
      setFindingsError(null)
      if (activeCount > 0 && section() === 'findings') ensureFindings()
    }

    const setSection = (next: DashboardSection): void => {
      if (section() === next) return
      setSectionSignal(next)
      setCursorSignal(0)
      setPlanSessionId(null)
      setPlanContent(null)
      setPlanError(null)
      if (next === 'findings' && activeCount > 0) ensureFindings()
    }

    const openPlan = (sessionId: string): void => {
      setPlanSessionId(sessionId)
      setPlanContent(null)
      setPlanError(null)
      planStale = false
      if (activeCount > 0) refreshPlan()
    }

    const closePlan = (): void => {
      planGeneration++
      setPlanSessionId(null)
      setPlanContent(null)
      setPlanError(null)
    }

    const deleteSelectedPlan = async (): Promise<void> => {
      const projectId = selectedProjectId()
      const sessionId = planSessionId()
      if (!projectId || !sessionId) return
      const project = summary()?.projects.find((candidate) => candidate.projectId === projectId)
      const plan = project?.unexecutedPlans.find((candidate) => candidate.sessionId === sessionId)
      const confirmed = await deps.confirm({
        title: 'Delete plan',
        message: `Delete "${plan?.title ?? sessionId}"? This cannot be undone.`,
      })
      if (!confirmed) return
      const result = await deps.deletePlan({ projectId, sessionId })
      if ('error' in result) {
        deps.toast({ message: result.error, variant: 'error' })
        return
      }
      if (planSessionId() === sessionId) closePlan()
      refreshSummary()
    }

    const openLoop = (projectId: string, name: string): void => {
      setLoopProjectId(projectId)
      setLoopName(name)
      setLoopTabSignal('overview')
      setLoopScrollTopSignal(0)
      setExpandedAmendmentId(null)
      setAmendmentDiff(null)
      loadedAmendmentId = null
      amendmentGeneration++
      setDetail(null)
      setDetailError(null)
      detailGeneration++
      detailStale = false
      if (activeCount > 0) refreshDetail()
    }

    const closeLoop = (): void => {
      detailGeneration++
      amendmentGeneration++
      loadedAmendmentId = null
      setLoopProjectId(null)
      setLoopName(null)
      setDetail(null)
      setDetailError(null)
      setExpandedAmendmentId(null)
      setAmendmentDiff(null)
      setLoopScrollTopSignal(0)
    }

    const toggleAmendment = async (id: number): Promise<void> => {
      if (expandedAmendmentId() === id) {
        setExpandedAmendmentId(null)
        return
      }
      setExpandedAmendmentId(id)
      if (loadedAmendmentId === id) return
      const projectId = loopProjectId()
      const name = loopName()
      if (!projectId || !name) return
      loadedAmendmentId = null
      setAmendmentDiff(null)
      const generation = ++amendmentGeneration
      const result = await deps.readAmendmentDiff({ projectId, loopName: name, id })
      if (generation !== amendmentGeneration || expandedAmendmentId() !== id) return
      if ('error' in result) {
        setExpandedAmendmentId(null)
        deps.toast({ message: result.error, variant: 'error' })
        return
      }
      loadedAmendmentId = id
      setAmendmentDiff(result)
    }

    const projects = createMemo(() => {
      const value = summary()
      return value ? filterDashboardProjects(value, query()).projects : []
    })

    const selectedProject = createMemo(
      () => projects().find((project) => project.projectId === selectedProjectId()) ?? null,
    )

    const loopRows = createMemo(() => {
      const project = selectedProject()
      if (!project) return { rows: [], total: 0, capped: false }
      return capList(
        sortLoops(filterLoopsByStatus(project.loops, statusFilter()), sort()),
        MAX_RENDERED_LOOP_ROWS,
        false,
      )
    })

    const loopStatusCounts = createMemo(() => statusCounts(selectedProject()?.loops ?? []))

    const findings = createMemo(() => {
      const project = selectedProject()
      if (!project) return []
      const groups = findingsByProject()[project.projectId]?.loops ?? []
      if (query() === '') return groups
      const loopNames = new Set(project.loops.map((loop) => loop.loopName))
      return groups.filter((group) => loopNames.has(group.loopName))
    })

    return {
      summary,
      error,
      returnRoute,
      query,
      searchFocused,
      selectedProjectId,
      section,
      cursor,
      sort,
      statusFilter,
      planSessionId,
      planContent,
      planError,
      loopProjectId,
      loopName,
      loopTab,
      detail,
      detailError,
      loopScrollTop,
      expandedAmendmentId,
      amendmentDiff,
      projects,
      selectedProject,
      loopRows,
      loopStatusCounts,
      findings,
      findingsError,
      open,
      activate,
      deactivate,
      handleChange,
      handleResubscribed,
      dispose() {
        cancelSummaryDebounce()
        summaryCoordinator.dispose()
        detailCoordinator.dispose()
        findingsCoordinator.dispose()
        disposeRoot()
      },
      setQuery(value) {
        setQuerySignal(value)
        setCursorSignal(0)
      },
      focusSearch() {
        setSearchFocused(true)
      },
      blurSearch() {
        setSearchFocused(false)
      },
      selectProject,
      setSection,
      setCursor(value) {
        setCursorSignal(value)
      },
      cycleSort() {
        setSortSignal(nextSortMode(sort()))
        setCursorSignal(0)
      },
      cycleStatusFilter() {
        setStatusFilterSignal(nextStatusFilter(statusFilter()))
        setCursorSignal(0)
      },
      openPlan,
      closePlan,
      deleteSelectedPlan,
      openLoop,
      closeLoop,
      setLoopTab(value) {
        setLoopTabSignal(value)
      },
      setLoopScrollTop(value) {
        setLoopScrollTopSignal(value)
      },
      toggleAmendment,
    }
  })
}
