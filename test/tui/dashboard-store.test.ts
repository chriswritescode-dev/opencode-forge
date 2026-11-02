import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

vi.mock('solid-js', async () => await import('solid-js/dist/dev.js'))

import type {
  ForgeAmendmentDiffOutput,
  ForgeDashboardLoopSummary,
  ForgeDashboardSummary,
  ForgeLoopDetail,
  ForgeLoopDetailOutput,
  ForgeProjectFindingsOutput,
} from '../../src/host/forge-rpc'
import { makeLoopSummary } from '../helpers/dashboard-fixtures'
import {
  DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS,
  createDashboardStore,
  type DashboardRoute,
  type DashboardStoreDeps,
} from '../../src/tui/dashboard/store'

const loopSummary = (
  loopName: string,
  status: 'running' | 'completed' = 'running',
): ForgeDashboardLoopSummary => makeLoopSummary({
  loopName,
  status,
  iteration: 1,
  currentSectionIndex: 0,
  totalSections: 1,
  sectionCount: 1,
  startedAt: 100,
  activityAt: 100,
})

function summaryFixture(): ForgeDashboardSummary {
  return {
    generatedAt: 1,
    projects: [
      {
        projectId: 'p1',
        projectDir: '/work/p1',
        loopCount: 2,
        unexecutedPlanCount: 1,
        bugCount: 0,
        loops: [loopSummary('loop-a'), loopSummary('loop-b', 'completed')],
        unexecutedPlans: [{ sessionId: 'ses-plan', title: 'Plan A', updatedAt: 10, charCount: 100 }],
      },
      {
        projectId: 'p2',
        projectDir: '/work/p2',
        loopCount: 0,
        unexecutedPlanCount: 0,
        bugCount: 0,
        loops: [],
        unexecutedPlans: [],
      },
    ],
  }
}

function detailFixture(loopName: string): ForgeLoopDetail {
  return {
    loop: {
      projectId: 'p1',
      loopName,
      status: 'running',
      currentSessionId: 'ses-loop',
      worktree: false,
      worktreeDir: '/work/p1',
      projectDir: '/work/p1',
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      auditorFallbackIndex: 0,
      modelFailed: false,
      sandbox: false,
      startedAt: 100,
      currentSectionIndex: 0,
      totalSections: 1,
    },
    sections: [],
    findings: [],
    transitions: [],
    transitionsCapped: false,
    amendments: [],
  }
}

function createDeps(overrides: Partial<DashboardStoreDeps> = {}): DashboardStoreDeps {
  return {
    readSummary: vi.fn(async () => summaryFixture()),
    readLoopDetail: vi.fn(async ({ loopName }: { projectId: string; loopName: string }) => detailFixture(loopName)),
    readProjectFindings: vi.fn(async () => ({ loops: [] })),
    readAmendmentDiff: vi.fn(async () => ({ sections: [], summary: { added: 0, removed: 0, modified: 0 } })),
    readSessionPlan: vi.fn(async () => ({ plan: '# plan' })),
    deletePlan: vi.fn(async () => ({ deleted: true as const })),
    currentDirectory: vi.fn(() => '/work/p1'),
    resolveProjectId: vi.fn(async () => 'p1'),
    confirm: vi.fn(async () => true),
    toast: vi.fn(),
    ...overrides,
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createDashboardStore', () => {
  test('open loads the summary, keeps the return route and preselects the current project', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })

    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    await vi.waitFor(() => expect(store.selectedProjectId()).toBe('p1'))
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    expect(deps.resolveProjectId).toHaveBeenCalledWith('/work/p1')
    expect(store.returnRoute()).toEqual({ type: 'home' })
    store.dispose()
  })

  test('inactive change events mark state stale instead of fetching, and activation refetches', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.openLoop('p1', 'loop-a')
    vi.mocked(deps.readSummary).mockClear()
    vi.mocked(deps.readLoopDetail).mockClear()

    store.handleChange('loops', 'p1')
    await tick()
    expect(deps.readSummary).not.toHaveBeenCalled()
    expect(deps.readLoopDetail).not.toHaveBeenCalled()

    store.activate()
    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(deps.readLoopDetail).toHaveBeenCalledTimes(1))
    expect(deps.readLoopDetail).toHaveBeenCalledWith({ projectId: 'p1', loopName: 'loop-a' })
    store.dispose()
  })

  test('a loops event for another project refreshes only the summary', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())
    vi.mocked(deps.readSummary).mockClear()
    vi.mocked(deps.readLoopDetail).mockClear()

    store.handleChange('loops', 'p2')

    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalledTimes(1))
    await tick()
    expect(deps.readLoopDetail).not.toHaveBeenCalled()
    store.dispose()
  })

  test('a loops event for the open loop project refreshes the summary and the detail', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())
    vi.mocked(deps.readSummary).mockClear()
    vi.mocked(deps.readLoopDetail).mockClear()

    store.handleChange('loops', 'p1')

    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(deps.readLoopDetail).toHaveBeenCalledTimes(1))
    store.dispose()
  })

  test('drops a late detail result after switching loops', async () => {
    let resolveFirst: (detail: ForgeLoopDetailOutput) => void = () => {}
    let resolveSecond: (detail: ForgeLoopDetailOutput) => void = () => {}
    const first = new Promise<ForgeLoopDetailOutput>((resolve) => { resolveFirst = resolve })
    const second = new Promise<ForgeLoopDetailOutput>((resolve) => { resolveSecond = resolve })
    let calls = 0
    const deps = createDeps({
      readLoopDetail: vi.fn(async () => {
        calls++
        return calls === 1 ? await first : await second
      }),
    })
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(deps.readLoopDetail).toHaveBeenCalledTimes(1))

    store.openLoop('p1', 'loop-b')
    resolveFirst(detailFixture('loop-a'))
    await tick()

    expect(store.detail()).toBeNull()

    resolveSecond(detailFixture('loop-b'))
    await vi.waitFor(() => expect(store.detail()?.loop.loopName).toBe('loop-b'))
    store.dispose()
  })

  test('drops a project resolution that finishes after the location changed', async () => {
    let directory = '/work/p1'
    let resolveLookup: (projectId: string | null) => void = () => {}
    const lookup = new Promise<string | null>((resolve) => { resolveLookup = resolve })
    const deps = createDeps({
      currentDirectory: vi.fn(() => directory),
      resolveProjectId: vi.fn(async () => await lookup),
    })
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(deps.resolveProjectId).toHaveBeenCalledWith('/work/p1'))

    directory = '/work/p2'
    resolveLookup('p1')
    await tick()

    expect(store.selectedProjectId()).toBeNull()
    store.dispose()
  })

  test('a loops event refreshes the findings view only for the selected project', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p1')
    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(1))
    expect(deps.readProjectFindings).toHaveBeenCalledWith({ projectId: 'p1' })
    const summariesBefore = vi.mocked(deps.readSummary).mock.calls.length

    store.handleChange('loops', 'p2')
    await vi.waitFor(() => expect(deps.readSummary.mock.calls.length).toBeGreaterThan(summariesBefore))
    await tick()
    expect(deps.readProjectFindings).toHaveBeenCalledTimes(1)

    store.handleChange('loops', 'p1')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(2))
    store.dispose()
  })

  test('the search narrows findings to the loops it keeps', async () => {
    const finding = (loopName: string) => ({ loopName, findings: [] })
    const deps = createDeps({
      readProjectFindings: vi.fn(async () => ({ loops: [finding('loop-a'), finding('loop-b')] })),
    })
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p1')
    store.setSection('findings')
    await vi.waitFor(() => expect(store.findings().map((group) => group.loopName)).toEqual(['loop-a', 'loop-b']))

    store.setQuery('loop-b')
    expect(store.findings().map((group) => group.loopName)).toEqual(['loop-b'])

    store.setQuery('/work/p1')
    expect(store.findings().map((group) => group.loopName)).toEqual(['loop-a', 'loop-b'])
    store.dispose()
  })

  test('invalidates a cached findings list when its loops event arrives on another section', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p1')
    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(1))

    store.setSection('loops')
    store.handleChange('loops', 'p1')
    await tick()
    expect(deps.readProjectFindings).toHaveBeenCalledTimes(1)

    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(2))
    expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p1' })
    store.dispose()
  })

  test('invalidates another project findings cache when its loops event arrives while viewing a different project', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p2')
    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p2' }))
    store.selectProject('p1')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p1' }))
    const callsBefore = deps.readProjectFindings.mock.calls.length

    store.handleChange('loops', 'p2')
    await tick()
    expect(deps.readProjectFindings).toHaveBeenCalledTimes(callsBefore)

    store.selectProject('p2')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p2' }))
    expect(deps.readProjectFindings).toHaveBeenCalledTimes(callsBefore + 1)
    store.dispose()
  })

  test('marks every cached findings list stale when the event stream resubscribes', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p2')
    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p2' }))
    store.selectProject('p1')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p1' }))
    const callsBefore = deps.readProjectFindings.mock.calls.length

    store.handleResubscribed()
    await tick()
    store.selectProject('p2')

    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p2' }))
    expect(deps.readProjectFindings).toHaveBeenCalledTimes(callsBefore + 2)
    store.dispose()
  })

  test('deleting a plan confirms, deletes and refetches the summary', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.activate()
    store.selectProject('p1')
    store.openPlan('ses-plan')
    await vi.waitFor(() => expect(store.planContent()).toBe('# plan'))
    vi.mocked(deps.readSummary).mockClear()

    await store.deleteSelectedPlan()

    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete plan',
      message: expect.stringContaining('Plan A'),
    }))
    expect(deps.deletePlan).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 'ses-plan' })
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    expect(store.planSessionId()).toBeNull()
    store.dispose()
  })

  test('a declined plan delete deletes nothing', async () => {
    const deps = createDeps({ confirm: vi.fn(async () => false) })
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.activate()
    store.openPlan('ses-plan')
    await vi.waitFor(() => expect(store.planContent()).toBe('# plan'))

    await store.deleteSelectedPlan()

    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.deletePlan).not.toHaveBeenCalled()
    expect(store.planSessionId()).toBe('ses-plan')
    store.dispose()
  })

  test('toasts the error and keeps the plan open when deletion fails', async () => {
    const deps = createDeps({ deletePlan: vi.fn(async () => ({ error: 'Plan not found' })) })
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.activate()
    store.openPlan('ses-plan')
    await vi.waitFor(() => expect(store.planContent()).toBe('# plan'))

    await store.deleteSelectedPlan()

    expect(deps.toast).toHaveBeenCalledWith({ message: 'Plan not found', variant: 'error' })
    expect(store.planSessionId()).toBe('ses-plan')
    store.dispose()
  })

  test('activation is reference-counted across pages', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    vi.mocked(deps.readSummary).mockClear()

    store.activate()
    store.activate()
    store.deactivate()
    store.handleChange('loops', 'p2')
    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalledTimes(1))

    store.deactivate()
    store.handleChange('loops', 'p2')
    await tick()
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  test('keeps the previous return route when a dashboard page opens the dashboard', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.open({ type: 'session', sessionID: 'ses-1' })
    store.open({ type: 'plugin', id: 'plugin-1', name: 'forge-dashboard' })

    expect(store.returnRoute()).toEqual({ type: 'session', sessionID: 'ses-1' })
    expect(deps.resolveProjectId).toHaveBeenCalledTimes(2)

    store.open({ type: 'plugin', id: 'plugin-1', name: 'forge-dashboard-loop' })

    expect(store.returnRoute()).toEqual({ type: 'session', sessionID: 'ses-1' })
    expect(deps.resolveProjectId).toHaveBeenCalledTimes(3)
    store.dispose()
  })

  test('keeps the return route after the host mutates the route object in place', () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)
    const route: DashboardRoute = { type: 'home' }

    store.open(route)
    Object.assign(route, { type: 'plugin', id: 'oc-forge', name: 'forge-dashboard' })

    expect(store.returnRoute()).toEqual({ type: 'home' })
    store.dispose()
  })

  test('snapshots the data payload of a plugin return route', () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)
    const data = { filter: 'running' }

    store.open({ type: 'plugin', id: 'oc-other', name: 'other-page', data })
    data.filter = 'completed'

    expect(store.returnRoute()).toEqual({
      type: 'plugin',
      id: 'oc-other',
      name: 'other-page',
      data: { filter: 'running' },
    })
    store.dispose()
  })

  test('reloads the diff of an amendment reopened while another amendment was loading', async () => {
    const pending: Array<(value: ForgeAmendmentDiffOutput) => void> = []
    const deps = createDeps({
      readAmendmentDiff: vi.fn(() => new Promise<ForgeAmendmentDiffOutput>((resolve) => { pending.push(resolve) })),
    })
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())

    const first = store.toggleAmendment(1)
    pending[0]({ sections: [], summary: { added: 0, removed: 0, modified: 0 } })
    await first
    expect(store.amendmentDiff()).not.toBeNull()

    void store.toggleAmendment(2)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(store.amendmentDiff()).toBeNull()

    void store.toggleAmendment(1)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    pending[2]({ sections: [], summary: { added: 0, removed: 0, modified: 0 } })

    await vi.waitFor(() => expect(store.amendmentDiff()).not.toBeNull())
    store.dispose()
  })

  test('reloads the diff of an amendment reopened after a failed load', async () => {
    let calls = 0
    const deps = createDeps({
      readAmendmentDiff: vi.fn(async () => {
        calls++
        if (calls === 2) return { error: 'diff unavailable' }
        return { sections: [], summary: { added: 0, removed: 0, modified: 0 } }
      }),
    })
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())

    await store.toggleAmendment(1)
    expect(store.amendmentDiff()).not.toBeNull()

    await store.toggleAmendment(2)
    expect(deps.toast).toHaveBeenCalledWith({ message: 'diff unavailable', variant: 'error' })
    expect(store.amendmentDiff()).toBeNull()
    expect(store.expandedAmendmentId()).toBeNull()

    await store.toggleAmendment(1)

    expect(deps.readAmendmentDiff).toHaveBeenCalledTimes(3)
    expect(store.amendmentDiff()).not.toBeNull()
    store.dispose()
  })

  test('reports a plan deleted elsewhere instead of loading it forever', async () => {
    const deps = createDeps({ readSessionPlan: vi.fn(async () => ({ plan: null })) })
    const store = createDashboardStore(deps)

    store.open({ type: 'home' })
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.activate()
    store.selectProject('p1')
    store.openPlan('ses-plan')

    await vi.waitFor(() => expect(store.planError()).toBe('Plan not found'))
    expect(store.planContent()).toBeNull()
    expect(deps.readSessionPlan).toHaveBeenCalledTimes(1)

    store.deactivate()
    store.activate()
    await tick()
    expect(deps.readSessionPlan).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  test('keeps a findings cache stale when its refresh result is dropped', async () => {
    let resolveDropped: (value: ForgeProjectFindingsOutput) => void = () => {}
    let calls = 0
    const deps = createDeps({
      readProjectFindings: vi.fn(async () => {
        calls++
        if (calls !== 2) return { loops: [] }
        return await new Promise<ForgeProjectFindingsOutput>((resolve) => { resolveDropped = resolve })
      }),
    })
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    store.selectProject('p1')
    store.setSection('findings')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(1))

    store.handleChange('loops', 'p1')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(2))
    store.selectProject('p2')
    resolveDropped({ loops: [] })
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(3))

    store.selectProject('p1')
    await vi.waitFor(() => expect(deps.readProjectFindings).toHaveBeenCalledTimes(4))
    expect(deps.readProjectFindings).toHaveBeenLastCalledWith({ projectId: 'p1' })
    store.dispose()
  })

  test('a plans event for the open loop project does not refetch the loop detail', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())
    vi.mocked(deps.readLoopDetail).mockClear()

    store.handleChange('plans', 'p1')
    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalled())
    await tick()
    expect(deps.readLoopDetail).not.toHaveBeenCalled()

    store.deactivate()
    store.activate()
    await tick()
    expect(deps.readLoopDetail).not.toHaveBeenCalled()
    store.dispose()
  })

  test('a refetched summary that is unchanged keeps its object graph', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    const first = store.summary()!

    store.handleResubscribed()

    await vi.waitFor(() => expect(deps.readSummary).toHaveBeenCalledTimes(2))
    await tick()
    expect(store.summary()).toBe(first)
    expect(store.summary()!.projects[0].loops[0]).toBe(first.projects[0].loops[0])
    store.dispose()
  })

  test('a changed loop row is replaced while unchanged siblings keep their identity', async () => {
    let iteration = 1
    const deps = createDeps({
      readSummary: vi.fn(async () => {
        const summary = summaryFixture()
        summary.projects[0].loops[0].iteration = iteration
        return summary
      }),
    })
    const store = createDashboardStore(deps)

    store.activate()
    await vi.waitFor(() => expect(store.summary()).not.toBeNull())
    const first = store.summary()!

    iteration = 4
    store.handleResubscribed()

    await vi.waitFor(() => expect(store.summary()!.projects[0].loops[0].iteration).toBe(4))
    const second = store.summary()!
    expect(second).not.toBe(first)
    expect(second.projects[0]).not.toBe(first.projects[0])
    expect(second.projects[0].loops[0]).not.toBe(first.projects[0].loops[0])
    expect(second.projects[0].loops[1]).toBe(first.projects[0].loops[1])
    expect(second.projects[1]).toBe(first.projects[1])
    store.dispose()
  })

  test('an unchanged detail refetch keeps the previous detail and its lists', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.openLoop('p1', 'loop-a')
    store.activate()
    await vi.waitFor(() => expect(store.detail()).not.toBeNull())
    const first = store.detail()!

    store.handleChange('loops', 'p1')

    await vi.waitFor(() => expect(deps.readLoopDetail).toHaveBeenCalledTimes(2))
    await tick()
    expect(store.detail()).toBe(first)
    expect(store.detail()!.sections).toBe(first.sections)
    store.dispose()
  })
})

describe('event-driven summary refresh debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function openActiveStore() {
    const deps = createDeps()
    const store = createDashboardStore(deps)
    store.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.summary()).not.toBeNull()
    vi.mocked(deps.readSummary).mockClear()
    return { deps, store }
  }

  test('coalesces a burst of change events into one summary refresh', async () => {
    const { deps, store } = await openActiveStore()

    store.handleChange('loops', 'p1')
    store.handleChange('plans', 'p1')

    await vi.advanceTimersByTimeAsync(DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS - 1)
    expect(deps.readSummary).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  test('a change while inactive schedules no fetch and activation refreshes immediately', async () => {
    const deps = createDeps()
    const store = createDashboardStore(deps)

    store.handleChange('loops', 'p1')
    await vi.advanceTimersByTimeAsync(DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS)
    expect(deps.readSummary).not.toHaveBeenCalled()

    store.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  test('deactivating the last page cancels the pending event refresh', async () => {
    const { deps, store } = await openActiveStore()

    store.handleChange('loops', 'p1')
    store.deactivate()
    await vi.advanceTimersByTimeAsync(DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS * 2)

    expect(deps.readSummary).not.toHaveBeenCalled()
    store.dispose()
  })

  test('an immediate refresh cancels the pending event refresh', async () => {
    const { deps, store } = await openActiveStore()

    store.handleChange('loops', 'p1')
    store.handleResubscribed()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.readSummary).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS * 2)
    expect(deps.readSummary).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  test('dispose cancels the pending event refresh', async () => {
    const { deps, store } = await openActiveStore()

    store.handleChange('loops', 'p1')
    store.dispose()
    await vi.advanceTimersByTimeAsync(DASHBOARD_SUMMARY_EVENT_DEBOUNCE_MS * 2)

    expect(deps.readSummary).not.toHaveBeenCalled()
  })
})
