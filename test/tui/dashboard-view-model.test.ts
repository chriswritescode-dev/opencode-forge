import { describe, test, expect, afterEach, vi } from 'vitest'
import {
  LOOP_STATUS_FILTERS,
  SORT_MODES,
  amendedSectionIndexes,
  buildRepoLabels,
  capList,
  computePhaseSpans,
  computeTimelineEvents,
  filterDashboardProjects,
  filterLoopsByStatus,
  findingsLevel,
  fmtTime,
  formatFinding,
  formatCount,
  formatRelativeTime,
  formatSectionDuration,
  formatSectionNumber,
  formatSpanDuration,
  formatTokenCount,
  formatUsageCost,
  groupFindingsBySection,
  mergeTimelineEntries,
  modelUsageBars,
  nextSortMode,
  nextStatusFilter,
  phaseLegendRows,
  repoLabel,
  roleUsageBars,
  sectionProgress,
  shareUnchanged,
  sortLoops,
  splitFindings,
  statusCounts,
  summarizeAmendments,
  summarizePhaseTotals,
  tabsForLoop,
  textBar,
  tokenBreakdownSegments,
} from '../../src/tui/dashboard/view-model'
import type { LoopTab, PhaseSpan } from '../../src/tui/dashboard/view-model'
import type {
  ForgeDashboardProjectSummary,
  ForgeDashboardSummary,
  ForgeDashboardUnexecutedPlan,
  ForgeLoopUsage,
  ForgePlanAmendment,
  ForgeReviewFinding,
} from '../../src/host/forge-rpc'
import { makeLoopSummary, makeTransition } from '../helpers/dashboard-fixtures'

function makeFinding(overrides: Partial<ForgeReviewFinding> = {}): ForgeReviewFinding {
  return {
    projectId: 'p1',
    file: 'src/main.ts',
    line: 42,
    severity: 'bug',
    description: 'Null pointer',
    createdAt: 100,
    ...overrides,
  }
}

function makeAmendment(overrides: Partial<ForgePlanAmendment> = {}): ForgePlanAmendment {
  return {
    id: 1,
    projectId: 'p1',
    loopName: 'my-loop',
    source: 'auditor',
    rationale: 'adjust plan for missing section',
    appliedAtSection: 4,
    summary: { added: 0, removed: 0, modified: 1 },
    createdAt: 100,
    ...overrides,
  }
}

function bucket(overrides: Partial<ForgeLoopUsage['byModel'][string]> = {}): ForgeLoopUsage['byModel'][string] {
  return {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 0,
    ...overrides,
  }
}

function makeUsage(overrides: Partial<ForgeLoopUsage> = {}): ForgeLoopUsage {
  return {
    loopName: 'test-loop',
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalMessageCount: 0,
    byModel: {},
    byRole: {},
    ...overrides,
  }
}

function makePlan(overrides: Partial<ForgeDashboardUnexecutedPlan> = {}): ForgeDashboardUnexecutedPlan {
  return { sessionId: 'ses-1', title: 'Plan A', updatedAt: 1, charCount: 10, ...overrides }
}

function makeProject(overrides: Partial<ForgeDashboardProjectSummary> = {}): ForgeDashboardProjectSummary {
  return {
    projectId: 'p1',
    projectDir: '/projects/p1',
    loopCount: 0,
    unexecutedPlanCount: 0,
    bugCount: 0,
    loops: [],
    unexecutedPlans: [],
    ...overrides,
  }
}

function makeSummary(projects: ForgeDashboardProjectSummary[]): ForgeDashboardSummary {
  return { generatedAt: 100, projects }
}

describe('capList', () => {
  test('returns the input array by reference when under the cap', () => {
    const items = [1, 2, 3]
    const out = capList(items, 10, false)
    expect(out.rows).toBe(items)
    expect(out.total).toBe(3)
    expect(out.capped).toBe(false)
  })

  test('slices to the cap and reports the true total when over', () => {
    const items = Array.from({ length: 25 }, (_, i) => i)
    const out = capList(items, 10, false)
    expect(out.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(out.total).toBe(25)
    expect(out.capped).toBe(true)
  })

  test('showAll bypasses the cap and reports capped false', () => {
    const items = Array.from({ length: 25 }, (_, i) => i)
    const out = capList(items, 10, true)
    expect(out.rows).toBe(items)
    expect(out.total).toBe(25)
    expect(out.capped).toBe(false)
  })

  test('an exactly-at-cap list is not reported as capped', () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const out = capList(items, 10, false)
    expect(out.rows).toBe(items)
    expect(out.total).toBe(10)
    expect(out.capped).toBe(false)
  })
})

describe('buildRepoLabels / repoLabel', () => {
  test('single path returns the bare basename', () => {
    const labels = buildRepoLabels(['/Users/chris/development/oc-manager'])
    expect(labels.get('/Users/chris/development/oc-manager')).toBe('oc-manager')
  })

  test('two non-colliding paths both return bare basenames', () => {
    const labels = buildRepoLabels(['/a/alpha', '/b/beta'])
    expect(labels.get('/a/alpha')).toBe('alpha')
    expect(labels.get('/b/beta')).toBe('beta')
  })

  test('two colliding basenames resolve to parent/segment', () => {
    const labels = buildRepoLabels(['/a/b/boatshare', '/x/y/boatshare'])
    expect(labels.get('/a/b/boatshare')).toBe('b/boatshare')
    expect(labels.get('/x/y/boatshare')).toBe('y/boatshare')
  })

  test('non-colliding sibling stays bare when only two of three collide', () => {
    const labels = buildRepoLabels(['/a/b/boatshare', '/x/y/boatshare', '/u/v/other'])
    expect(labels.get('/a/b/boatshare')).toBe('b/boatshare')
    expect(labels.get('/x/y/boatshare')).toBe('y/boatshare')
    expect(labels.get('/u/v/other')).toBe('other')
  })

  test('parent also collides — keep prepending until unique', () => {
    const labels = buildRepoLabels(['/p/q/api', '/r/q/api'])
    expect(labels.get('/p/q/api')).toBe('p/q/api')
    expect(labels.get('/r/q/api')).toBe('r/q/api')
  })

  test('path with no separator returns itself', () => {
    const labels = buildRepoLabels(['myrepo'])
    expect(labels.get('myrepo')).toBe('myrepo')
  })

  test('empty string returns itself', () => {
    const labels = buildRepoLabels([''])
    expect(labels.get('')).toBe('')
  })

  test('trailing slash uses the last non-empty segment', () => {
    const labels = buildRepoLabels(['/a/b/repo/'])
    expect(labels.get('/a/b/repo/')).toBe('repo')
  })

  test('duplicate raw paths do not inflate collision depth', () => {
    const labels = buildRepoLabels(['/a/repo', '/a/repo', '/b/repo'])
    expect(labels.get('/a/repo')).toBe('a/repo')
    expect(labels.get('/b/repo')).toBe('b/repo')
  })

  test('repoLabel reads the project label from projectDir', () => {
    const proj = makeProject({ projectId: 'p1', projectDir: '/a/b/repo' })
    const labels = buildRepoLabels(['/a/b/repo'])
    expect(repoLabel(labels, proj)).toBe('repo')
  })

  test('repoLabel falls back to the project id when projectDir is absent', () => {
    const proj = makeProject({ projectId: 'p1', projectDir: undefined })
    expect(repoLabel(new Map(), proj)).toBe('p1')
  })
})

describe('sortLoops', () => {
  test('recent preserves the running-first server order without mutating the input', () => {
    const loops = [
      makeLoopSummary({ loopName: 'r1', status: 'running', startedAt: 1700000500000 }),
      makeLoopSummary({ loopName: 'r2', status: 'running', startedAt: 1700000400000 }),
      makeLoopSummary({ loopName: 'c1', status: 'completed', startedAt: 1700000300000 }),
      makeLoopSummary({ loopName: 'c2', status: 'completed', startedAt: 1700000100000 }),
    ]
    const sorted = sortLoops(loops, 'recent')
    expect(sorted.map((l) => l.loopName)).toEqual(['r1', 'r2', 'c1', 'c2'])
    expect(loops.map((l) => l.loopName)).toEqual(['r1', 'r2', 'c1', 'c2'])
  })

  test('cost puts loops without usage last, not first', () => {
    const loops = [
      makeLoopSummary({ loopName: 'a' }),
      makeLoopSummary({ loopName: 'b', totalCost: 2 }),
      makeLoopSummary({ loopName: 'c', totalCost: 5 }),
    ]
    expect(sortLoops(loops, 'cost').map((l) => l.loopName)).toEqual(['c', 'b', 'a'])
  })

  test('duration sorts longest elapsed first', () => {
    const loops = [
      makeLoopSummary({ loopName: 'short', startedAt: 1000, completedAt: 2000 }),
      makeLoopSummary({ loopName: 'long', startedAt: 1000, completedAt: 11000 }),
      makeLoopSummary({ loopName: 'mid', startedAt: 1000, completedAt: 6000 }),
    ]
    expect(sortLoops(loops, 'duration').map((l) => l.loopName)).toEqual(['long', 'mid', 'short'])
  })

  test('findings sorts by bug count descending', () => {
    const loops = [
      makeLoopSummary({ loopName: 'clean', bugCount: 0 }),
      makeLoopSummary({ loopName: 'two', bugCount: 2 }),
      makeLoopSummary({ loopName: 'one', bugCount: 1 }),
    ]
    expect(sortLoops(loops, 'findings').map((l) => l.loopName)).toEqual(['two', 'one', 'clean'])
  })
})

describe('status filters and sort cycling', () => {
  test('SORT_MODES covers every sort in order', () => {
    expect(SORT_MODES).toEqual(['recent', 'cost', 'duration', 'findings'])
  })

  test('nextSortMode cycles and wraps', () => {
    expect(nextSortMode('recent')).toBe('cost')
    expect(nextSortMode('cost')).toBe('duration')
    expect(nextSortMode('duration')).toBe('findings')
    expect(nextSortMode('findings')).toBe('recent')
  })

  test('LOOP_STATUS_FILTERS lists all then every persisted status', () => {
    expect(LOOP_STATUS_FILTERS).toEqual(['all', 'running', 'completed', 'cancelled', 'errored', 'stalled'])
  })

  test('nextStatusFilter cycles and wraps', () => {
    expect(nextStatusFilter('all')).toBe('running')
    expect(nextStatusFilter('running')).toBe('completed')
    expect(nextStatusFilter('stalled')).toBe('all')
  })

  test('filterLoopsByStatus keeps the input for all and filters otherwise', () => {
    const loops = [
      makeLoopSummary({ loopName: 'r', status: 'running' }),
      makeLoopSummary({ loopName: 'c', status: 'completed' }),
      makeLoopSummary({ loopName: 'e', status: 'errored' }),
    ]
    expect(filterLoopsByStatus(loops, 'all')).toBe(loops)
    expect(filterLoopsByStatus(loops, 'running').map((l) => l.loopName)).toEqual(['r'])
    expect(filterLoopsByStatus(loops, 'errored').map((l) => l.loopName)).toEqual(['e'])
    expect(filterLoopsByStatus(loops, 'cancelled')).toEqual([])
  })

  test('statusCounts counts every status and the total', () => {
    const loops = [
      makeLoopSummary({ status: 'running' }),
      makeLoopSummary({ status: 'running' }),
      makeLoopSummary({ status: 'completed' }),
      makeLoopSummary({ status: 'stalled' }),
    ]
    expect(statusCounts(loops)).toEqual({
      all: 4,
      running: 2,
      completed: 1,
      cancelled: 0,
      errored: 0,
      stalled: 1,
    })
  })
})

describe('filterDashboardProjects', () => {
  function fixture(): ForgeDashboardSummary {
    const p1 = makeProject({
      projectId: 'p1',
      projectDir: '/work/alpha',
      loops: [
        makeLoopSummary({ loopName: 'fix-auth', branch: 'feat/auth' }),
        makeLoopSummary({ loopName: 'cleanup', status: 'completed' }),
      ],
      unexecutedPlans: [makePlan({ sessionId: 'ses-auth', title: 'Auth plan' }), makePlan({ sessionId: 'ses-docs', title: 'Docs plan' })],
    })
    const p2 = makeProject({
      projectId: 'p2',
      projectDir: '/work/beta',
      loops: [makeLoopSummary({ loopName: 'other', branch: 'feat/other' })],
    })
    return makeSummary([p1, p2])
  }

  test('empty query returns the same summary object', () => {
    const summary = fixture()
    expect(filterDashboardProjects(summary, '')).toBe(summary)
  })

  test('matches a loop name and drops non-matching rows and projects', () => {
    const filtered = filterDashboardProjects(fixture(), 'cleanup')
    expect(filtered.projects).toHaveLength(1)
    expect(filtered.projects[0].projectId).toBe('p1')
    expect(filtered.projects[0].loops.map((l) => l.loopName)).toEqual(['cleanup'])
    expect(filtered.projects[0].unexecutedPlans).toEqual([])
  })

  test('matches a branch name case-insensitively', () => {
    const filtered = filterDashboardProjects(fixture(), 'FEAT/AUTH')
    expect(filtered.projects).toHaveLength(1)
    expect(filtered.projects[0].loops.map((l) => l.loopName)).toEqual(['fix-auth'])
  })

  test('a project directory match keeps every row of that project', () => {
    const filtered = filterDashboardProjects(fixture(), 'beta')
    expect(filtered.projects).toHaveLength(1)
    expect(filtered.projects[0].projectId).toBe('p2')
    expect(filtered.projects[0].loops.map((l) => l.loopName)).toEqual(['other'])
  })

  test('a project label match keeps every row of that project', () => {
    const filtered = filterDashboardProjects(fixture(), 'alpha')
    expect(filtered.projects).toHaveLength(1)
    expect(filtered.projects[0].projectId).toBe('p1')
    expect(filtered.projects[0].loops.map((l) => l.loopName)).toEqual(['fix-auth', 'cleanup'])
    expect(filtered.projects[0].unexecutedPlans).toHaveLength(2)
  })

  test('matches an unexecuted plan title', () => {
    const filtered = filterDashboardProjects(fixture(), 'docs plan')
    expect(filtered.projects[0].unexecutedPlans.map((p) => p.sessionId)).toEqual(['ses-docs'])
  })

  test('no match yields no projects but keeps summary metadata', () => {
    const filtered = filterDashboardProjects(fixture(), 'zzz')
    expect(filtered.projects).toEqual([])
    expect(filtered.generatedAt).toBe(100)
  })

  test('keeps the identity of rows and projects that survive the filter', () => {
    const summary = fixture()
    const filtered = filterDashboardProjects(summary, 'cleanup')
    expect(filtered).not.toBe(summary)
    expect(filtered.projects[0]).not.toBe(summary.projects[0])
    expect(filtered.projects[0].loops).toHaveLength(1)
    expect(filtered.projects[0].loops[0]).toBe(summary.projects[0].loops[1])
  })

  test('a query that keeps every row returns the original summary', () => {
    const summary = fixture()
    expect(filterDashboardProjects(summary, 'work')).toBe(summary)
  })
})

describe('shareUnchanged', () => {
  function fixture() {
    return {
      generatedAt: 1,
      projects: [
        { projectId: 'p1', loops: [{ loopName: 'a', iteration: 1 }, { loopName: 'b', iteration: 2 }] },
        { projectId: 'p2', loops: [{ loopName: 'c', iteration: 1 }] },
      ],
    }
  }

  test('a deep-equal fresh result returns the previous reference', () => {
    const previous = fixture()
    expect(shareUnchanged(previous, fixture())).toBe(previous)
  })

  test('a changed leaf replaces its ancestors and reuses unchanged siblings', () => {
    const previous = fixture()
    const next = fixture()
    next.projects[0].loops[1].iteration = 3

    const shared = shareUnchanged(previous, next)

    expect(shared).not.toBe(previous)
    expect(shared.projects).not.toBe(previous.projects)
    expect(shared.projects[0]).not.toBe(previous.projects[0])
    expect(shared.projects[0].loops).not.toBe(previous.projects[0].loops)
    expect(shared.projects[0].loops[0]).toBe(previous.projects[0].loops[0])
    expect(shared.projects[0].loops[1]).not.toBe(previous.projects[0].loops[1])
    expect(shared.projects[0].loops[1]).toEqual({ loopName: 'b', iteration: 3 })
    expect(shared.projects[1]).toBe(previous.projects[1])
  })

  test('an appended array element keeps the unchanged prefix', () => {
    const previous = { rows: [{ id: 1 }, { id: 2 }] }
    const next = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }

    const shared = shareUnchanged(previous, next)

    expect(shared.rows).not.toBe(previous.rows)
    expect(shared.rows).toHaveLength(3)
    expect(shared.rows[0]).toBe(previous.rows[0])
    expect(shared.rows[1]).toBe(previous.rows[1])
    expect(shared.rows[2]).toBe(next.rows[2])
  })

  test('a removed array element keeps the surviving rows', () => {
    const previous = { rows: [{ id: 1 }, { id: 2 }] }
    const next = { rows: [{ id: 1 }] }

    const shared = shareUnchanged(previous, next)

    expect(shared.rows).not.toBe(previous.rows)
    expect(shared.rows).toHaveLength(1)
    expect(shared.rows[0]).toBe(previous.rows[0])
  })

  test('replaced or missing containers fall back to the next value', () => {
    const next = { a: 1 }
    expect(shareUnchanged(null, next)).toBe(next)
    expect(shareUnchanged(undefined, next)).toBe(next)
    expect(shareUnchanged({ a: 1 }, { b: 2 })).toEqual({ b: 2 })
    expect(shareUnchanged({ a: 1 }, null)).toBeNull()
    const mixed = { a: 1 }
    expect(shareUnchanged([1], mixed)).toBe(mixed)
  })

  test('primitive values compare by value', () => {
    expect(shareUnchanged(1, 2)).toBe(2)
    expect(shareUnchanged('a', 'a')).toBe('a')
    expect(shareUnchanged(null, null)).toBeNull()
  })

  test('never mutates the previous graph', () => {
    const previous = fixture()
    const snapshot = JSON.parse(JSON.stringify(previous))
    const next = fixture()
    next.projects[1].loops[0].iteration = 9

    const shared = shareUnchanged(previous, next)

    expect(previous).toEqual(snapshot)
    expect(previous.projects[1].loops[0].iteration).toBe(1)
    expect(shared.projects[1].loops[0].iteration).toBe(9)
    expect(shared.projects[1].loops[0]).not.toBe(next.projects[1].loops[0])
  })
})

describe('textBar', () => {
  test('renders empty, full and half bars at the requested width', () => {
    expect(textBar(0, 5)).toBe('░░░░░')
    expect(textBar(1, 5)).toBe('█████')
    expect(textBar(0.5, 6)).toBe('███░░░')
  })

  test('clamps fractions outside 0–1', () => {
    expect(textBar(2, 4)).toBe('████')
    expect(textBar(-1, 4)).toBe('░░░░')
    expect(textBar(Number.NaN, 4)).toBe('░░░░')
  })

  test('returns an empty string for a non-positive width', () => {
    expect(textBar(0.5, 0)).toBe('')
    expect(textBar(0.5, -3)).toBe('')
  })
})

describe('splitFindings', () => {
  test('partitions bugs vs warnings', () => {
    const findings: ForgeReviewFinding[] = [
      makeFinding({ severity: 'bug', description: 'Bug A' }),
      makeFinding({ severity: 'warning', description: 'Warning B' }),
      makeFinding({ severity: 'bug', description: 'Bug C' }),
      makeFinding({ severity: 'warning', description: 'Warning D' }),
    ]
    const { bugs, warnings } = splitFindings(findings)
    expect(bugs).toHaveLength(2)
    expect(bugs.every((f) => f.severity === 'bug')).toBe(true)
    expect(warnings).toHaveLength(2)
    expect(warnings.every((f) => f.severity === 'warning')).toBe(true)
  })

  test('handles empty and single-severity lists', () => {
    expect(splitFindings([])).toEqual({ bugs: [], warnings: [] })
    expect(splitFindings([makeFinding({ severity: 'bug' })]).warnings).toEqual([])
    expect(splitFindings([makeFinding({ severity: 'warning' })]).bugs).toEqual([])
  })
})

describe('findingsLevel', () => {
  test('returns bug when any bug present', () => {
    expect(findingsLevel({ bugs: [makeFinding({ severity: 'bug' })], warnings: [] })).toBe('bug')
    expect(
      findingsLevel({ bugs: [makeFinding({ severity: 'bug' })], warnings: [makeFinding({ severity: 'warning' })] }),
    ).toBe('bug')
  })

  test('returns warn when only warnings present', () => {
    expect(findingsLevel({ bugs: [], warnings: [makeFinding({ severity: 'warning' })] })).toBe('warn')
  })

  test('returns clean when no findings', () => {
    expect(findingsLevel({ bugs: [], warnings: [] })).toBe('clean')
  })
})

describe('formatCount / formatSectionNumber / sectionProgress', () => {
  test('singular for count of 1 and plural otherwise', () => {
    expect(formatCount(1, 'bug')).toBe('1 bug')
    expect(formatCount(1, 'warning')).toBe('1 warning')
    expect(formatCount(0, 'bug')).toBe('0 bugs')
    expect(formatCount(2, 'warning')).toBe('2 warnings')
    expect(formatCount(1, 'project')).toBe('1 project')
    expect(formatCount(3, 'loop')).toBe('3 loops')
  })

  test('converts 0-based stored indexes to 1-based display strings', () => {
    expect(formatSectionNumber(0)).toBe('1')
    expect(formatSectionNumber(1)).toBe('2')
    expect(formatSectionNumber(4)).toBe('5')
  })

  test('sectionProgress is 1-based and capped at the section total', () => {
    expect(sectionProgress(0, 3)).toEqual({ current: 1, total: 3 })
    expect(sectionProgress(1, 3)).toEqual({ current: 2, total: 3 })
    expect(sectionProgress(2, 3)).toEqual({ current: 3, total: 3 })
    expect(sectionProgress(9, 3)).toEqual({ current: 3, total: 3 })
    expect(sectionProgress(0, 0)).toEqual({ current: 0, total: 0 })
  })
})

describe('formatFinding', () => {
  test('formats with file:line — description', () => {
    const f = makeFinding({ file: 'src/util.ts', line: 15, description: 'Unused variable', scenario: undefined })
    expect(formatFinding(f)).toBe('src/util.ts:15 — Unused variable')
  })

  test('includes scenario in parentheses when present', () => {
    const f = makeFinding({ file: 'src/app.ts', line: 99, description: 'Memory leak', scenario: 'when data > 1MB' })
    expect(formatFinding(f)).toBe('src/app.ts:99 — Memory leak (when data > 1MB)')
  })
})

describe('formatTokenCount', () => {
  test('returns "0" for zero or negative', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })

  test('returns raw number below 1000', () => {
    expect(formatTokenCount(999)).toBe('999')
  })

  test('formats thousands and millions with compact suffixes', () => {
    expect(formatTokenCount(12345)).toBe('12.3k')
    expect(formatTokenCount(2000)).toBe('2k')
    expect(formatTokenCount(3_400_000)).toBe('3.4M')
    expect(formatTokenCount(1_000_000)).toBe('1M')
  })
})

describe('formatUsageCost', () => {
  test('returns "$0" for zero or negative', () => {
    expect(formatUsageCost(0)).toBe('$0')
    expect(formatUsageCost(-1)).toBe('$0')
  })

  test('keeps 4 decimals below $1 and rounds to cents at or above $1', () => {
    expect(formatUsageCost(0.1234)).toBe('$0.1234')
    expect(formatUsageCost(12.3456)).toBe('$12.35')
    expect(formatUsageCost(1)).toBe('$1.00')
  })
})

describe('tokenBreakdownSegments', () => {
  const usage = makeUsage({
    totalCost: 1,
    totalInputTokens: 50,
    totalOutputTokens: 30,
    totalReasoningTokens: 10,
    totalCacheReadTokens: 8,
    totalCacheWriteTokens: 2,
    totalMessageCount: 4,
  })

  test('returns five labeled segments', () => {
    expect(tokenBreakdownSegments(usage).map((s) => s.label)).toEqual(['Input', 'Output', 'Reasoning', 'Cache R', 'Cache W'])
  })

  test('percentages are share of total and sum to 100', () => {
    const segs = tokenBreakdownSegments(usage)
    expect(segs[0].pct).toBeCloseTo(50)
    expect(segs[1].pct).toBeCloseTo(30)
    expect(segs.reduce((acc, s) => acc + s.pct, 0)).toBeCloseTo(100)
  })

  test('all-zero usage yields zero-width segments (no divide by zero)', () => {
    const segs = tokenBreakdownSegments(makeUsage())
    expect(segs.every((s) => s.pct === 0)).toBe(true)
  })
})

describe('modelUsageBars', () => {
  const usage = makeUsage({
    totalCost: 3,
    byModel: {
      'cheap-model': bucket({ cost: 0.5, inputTokens: 100, outputTokens: 20, messageCount: 2 }),
      'pricey-model': bucket({ cost: 2, inputTokens: 400, outputTokens: 80, messageCount: 6 }),
    },
  })

  test('sorts by cost descending', () => {
    expect(modelUsageBars(usage).map((b) => b.model)).toEqual(['pricey-model', 'cheap-model'])
  })

  test('pct is relative to the most expensive model', () => {
    const bars = modelUsageBars(usage)
    expect(bars[0].pct).toBeCloseTo(100)
    expect(bars[1].pct).toBeCloseTo(25)
  })

  test('returns empty array when no models', () => {
    expect(modelUsageBars(makeUsage())).toEqual([])
  })
})

describe('roleUsageBars', () => {
  const usage = makeUsage({
    totalCost: 3,
    totalMessageCount: 8,
    byModel: {
      'exec-model': bucket({ cost: 2, inputTokens: 100, outputTokens: 20, messageCount: 6 }),
      'audit-model': bucket({ cost: 1, inputTokens: 50, outputTokens: 10, messageCount: 2 }),
    },
    byRole: {
      code: bucket({ cost: 2, inputTokens: 100, outputTokens: 20, messageCount: 6 }),
      auditor: bucket({ cost: 1, inputTokens: 50, outputTokens: 10, messageCount: 2 }),
    },
  })

  test('splits cost into execution and auditor roles by recorded role', () => {
    const bars = roleUsageBars(usage)
    expect(bars).toHaveLength(2)
    const exec = bars.find((b) => b.role === 'execution')!
    const audit = bars.find((b) => b.role === 'auditor')!
    expect(exec.cost).toBeCloseTo(2)
    expect(audit.cost).toBeCloseTo(1)
    expect(exec.messageCount).toBe(6)
    expect(audit.messageCount).toBe(2)
  })

  test('pct is relative to the larger role cost', () => {
    const bars = roleUsageBars(usage)
    expect(bars.find((b) => b.role === 'execution')!.pct).toBeCloseTo(100)
    expect(bars.find((b) => b.role === 'auditor')!.pct).toBeCloseTo(50)
  })

  test('unknown roles land in an other bar so the split reconciles with total cost', () => {
    const extra = makeUsage({
      ...usage,
      byRole: {
        ...usage.byRole,
        unknown: bucket({ cost: 0.5, messageCount: 1 }),
      },
    })
    const bars = roleUsageBars(extra)
    expect(bars).toHaveLength(3)
    expect(bars.find((b) => b.role === 'other')!.cost).toBeCloseTo(0.5)
    expect(bars.reduce((sum, b) => sum + b.cost, 0)).toBeCloseTo(3.5)
  })

  test('an other bar is omitted when every role is known', () => {
    expect(roleUsageBars(usage).map((b) => b.role)).toEqual(['execution', 'auditor'])
  })

  test('zero-cost usage yields zero-width bars', () => {
    const zero = makeUsage({
      byRole: {
        code: bucket(),
        auditor: bucket(),
      },
    })
    expect(roleUsageBars(zero).every((b) => b.pct === 0)).toBe(true)
  })

  test('role bars sum input, output and reasoning tokens per role', () => {
    const withTokens = makeUsage({
      byRole: {
        code: bucket({ cost: 2, inputTokens: 4000, outputTokens: 2000, reasoningTokens: 400, messageCount: 6 }),
        auditor: bucket({ cost: 1, inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, messageCount: 2 }),
      },
    })
    const bars = roleUsageBars(withTokens)
    expect(bars.find((b) => b.role === 'execution')!.tokens).toBe(6400)
    expect(bars.find((b) => b.role === 'auditor')!.tokens).toBe(1600)
  })
})

describe('formatSectionDuration / formatSpanDuration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns empty for a pending section', () => {
    expect(formatSectionDuration(undefined, undefined)).toBe('')
    expect(formatSectionDuration(0, undefined)).toBe('')
  })

  test('formats a completed section duration', () => {
    expect(formatSectionDuration(1_700_000_000_000, 1_700_000_090_000)).toBe('1m 30s')
  })

  test('uses live elapsed time for an in-progress section', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_005_000)
    expect(formatSectionDuration(1_700_000_000_000, undefined)).toBe('5s')
  })

  test('returns empty when the section has not advanced', () => {
    expect(formatSectionDuration(1_700_000_000_000, 1_700_000_000_000)).toBe('')
  })

  test('keeps sub-second spans as raw milliseconds', () => {
    expect(formatSpanDuration(0)).toBe('0ms')
    expect(formatSpanDuration(500)).toBe('500ms')
    expect(formatSpanDuration(999)).toBe('999ms')
  })

  test('formats spans of one second or more with the duration helper', () => {
    expect(formatSpanDuration(1000)).toBe('1s')
    expect(formatSpanDuration(90_000)).toBe('1m 30s')
    expect(formatSpanDuration(3_600_000)).toBe('1h 0m')
  })
})

describe('fmtTime / formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('fmtTime returns empty for 0, null and undefined', () => {
    expect(fmtTime(0)).toBe('')
    expect(fmtTime(null)).toBe('')
    expect(fmtTime(undefined)).toBe('')
  })

  test('fmtTime formats a known timestamp with the expected pattern', () => {
    const result = fmtTime(new Date('2024-01-15T14:30:00').getTime())
    expect(result).toMatch(/^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} (AM|PM)$/)
  })

  test('fmtTime formats midnight as 12:00 AM', () => {
    const midnight = new Date('2024-06-15T00:00:00').getTime()
    expect(fmtTime(midnight)).toMatch(/^\d{2}-\d{2}-2024 12:00 AM$/)
  })

  test('formatRelativeTime returns empty for missing timestamps', () => {
    expect(formatRelativeTime(0)).toBe('')
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime(undefined)).toBe('')
  })

  test('formatRelativeTime labels seconds, minutes, hours and days', () => {
    vi.useFakeTimers()
    const now = new Date('2024-06-15T12:00:00Z').getTime()
    vi.setSystemTime(now)
    expect(formatRelativeTime(now - 5_000)).toBe('5s ago')
    expect(formatRelativeTime(now - 120_000)).toBe('2m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000)).toBe('2d ago')
  })

  test('formatRelativeTime falls back to an absolute stamp past 30 days', () => {
    vi.useFakeTimers()
    const now = new Date('2024-06-15T12:00:00Z').getTime()
    vi.setSystemTime(now)
    const old = now - 31 * 86_400_000
    expect(formatRelativeTime(old)).toBe(fmtTime(old))
  })
})

describe('tabsForLoop', () => {
  test('running plan loop with sections and a plan returns every tab in order', () => {
    const tabs = tabsForLoop(makeLoopSummary({ hasPlan: true, sectionCount: 1 }))
    expect(tabs).toEqual<LoopTab[]>(['overview', 'timeline', 'sections', 'findings', 'plan', 'usage'])
  })

  test('loop with zero sections omits the sections tab', () => {
    expect(tabsForLoop(makeLoopSummary({ hasPlan: false, sectionCount: 0 }))).toEqual<LoopTab[]>([
      'overview',
      'timeline',
      'findings',
      'usage',
    ])
  })

  test('loop with hasPlan false omits the plan tab', () => {
    const tabs = tabsForLoop(makeLoopSummary({ hasPlan: false, sectionCount: 1 }))
    expect(tabs).not.toContain<LoopTab>('plan')
    expect(tabs).toContain<LoopTab>('sections')
  })

  test('tabsForLoop never returns an empty array', () => {
    const tabs = tabsForLoop(makeLoopSummary({ hasPlan: false, sectionCount: 0 }))
    expect(tabs.length).toBeGreaterThan(0)
    expect(tabs[0]).toBe<LoopTab>('overview')
    expect(tabs[tabs.length - 1]).toBe<LoopTab>('usage')
  })
})

describe('computePhaseSpans', () => {
  test('empty transitions on a running loop yield one open span ending at now', () => {
    const startedAt = 1700000000000
    const now = startedAt + 5000
    const { spans, truncated } = computePhaseSpans([], startedAt, null, now)
    expect(spans).toHaveLength(1)
    expect(spans[0].open).toBe(true)
    expect(spans[0].phase).toBe('coding')
    expect(spans[0].endedAt).toBeNull()
    expect(spans[0].durationMs).toBe(5000)
    expect(truncated).toBe(false)
  })

  test('empty transitions on a completed loop yield one closed span ending at completedAt', () => {
    const startedAt = 1700000000000
    const completedAt = startedAt + 7000
    const { spans, truncated } = computePhaseSpans([], startedAt, completedAt, completedAt + 1000)
    expect(spans).toHaveLength(1)
    expect(spans[0].open).toBe(false)
    expect(spans[0].endedAt).toBe(completedAt)
    expect(spans[0].durationMs).toBe(7000)
    expect(truncated).toBe(false)
  })

  test('a single coding → auditing transition yields a closed coding span and an open auditing span', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 500, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, now)
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({ phase: 'coding', open: false, durationMs: 500, endedAt: t1.createdAt })
    expect(spans[1]).toMatchObject({ phase: 'auditing', open: true, durationMs: now - t1.createdAt })
    expect(truncated).toBe(false)
  })

  test('a terminal transition closes the prior span and emits no trailing span', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 500, fromPhase: 'coding', toPhase: undefined, transitionKind: 'terminate' })
    const { spans } = computePhaseSpans([t1], startedAt, null, startedAt + 9000)
    expect(spans).toHaveLength(1)
    expect(spans.every((s) => !s.open)).toBe(true)
    expect(spans[0]).toMatchObject({ phase: 'coding', endedAt: t1.createdAt })
  })

  test('three transitions with a terminal last yield three spans summing to total elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'final_auditing', toPhase: undefined, transitionKind: 'terminate' })
    const { spans } = computePhaseSpans([t1, t2, t3], startedAt, null, startedAt + 9000)
    expect(spans).toHaveLength(3)
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBe(t3.createdAt - startedAt)
  })

  test('duplicate and out-of-order timestamps clamp to zero-duration spans', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 2000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    expect(computePhaseSpans([t1, t2], startedAt, null, startedAt + 5000).spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(computePhaseSpans([t1, t2], startedAt, null, startedAt + 5000).spans[1].durationMs).toBe(0)

    const early = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const later = makeTransition({ id: 4, createdAt: startedAt + 1000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const spans = computePhaseSpans([early, later], startedAt, null, startedAt + 7000).spans
    expect(spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(spans[1].durationMs).toBe(0)
  })

  test('truncated requires a capped window starting more than one second after startedAt', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 5000 })
    expect(computePhaseSpans([t1], startedAt, null, startedAt + 10000, 'coding', true).truncated).toBe(true)
    expect(computePhaseSpans([t1], startedAt, null, startedAt + 10000).truncated).toBe(false)
  })

  test('an uncapped window keeps a long first phase attributed instead of truncating it', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, startedAt + 10000)
    expect(truncated).toBe(false)
    expect(spans[0]).toMatchObject({ phase: 'coding', durationMs: 5000 })
  })

  test('summarizePhaseTotals folds repeated visits to the same phase into one total', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'auditing', toPhase: 'coding' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'coding', toPhase: 'auditing' })
    const { spans } = computePhaseSpans([t1, t2, t3], startedAt, null, startedAt + 8000)
    const totals = summarizePhaseTotals(spans)
    expect(totals.coding).toBe(5000)
    expect(totals.auditing).toBe(3000)
  })

  test('a truncated run marks the leading unknown span with an empty phase', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 8000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 12000, 'coding', true)
    expect(truncated).toBe(true)
    expect(spans).toHaveLength(3)
    expect(spans[0].phase).toBe('')
    expect(spans[0].durationMs).toBe(t1.createdAt - startedAt)
    expect(spans[1].phase).toBe('auditing')
    expect(spans[2].phase).toBe('final_auditing')
    expect(spans[2].open).toBe(true)
  })

  test('summarizePhaseTotals excludes the leading unknown span of a truncated run', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 8000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 12000, 'coding', true)
    const totals = summarizePhaseTotals(spans)
    expect(totals.coding).toBeUndefined()
    expect(totals.auditing).toBe(3000)
    expect(totals.final_auditing).toBe(4000)
  })

  test('a terminal row followed by a restart continues processing and excludes inactive downtime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 500, fromPhase: 'coding', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 15000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const completedAt = startedAt + 20000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, completedAt, completedAt + 1000)
    expect(spans).toHaveLength(4)
    expect(spans.every((s) => !s.open)).toBe(true)
    expect(spans.map((s) => s.phase)).toEqual(['coding', 'coding', 'auditing', 'final_auditing'])
    expect(truncated).toBe(false)
    expect(spans[1]).toMatchObject({ startedAt: t2.createdAt, endedAt: t2.createdAt, durationMs: 0 })
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBe(10500)
  })

  test('a same-phase restart with subsequent current-lifecycle transitions excludes inactive downtime', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'final_auditing', toPhase: 'coding' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'coding', toPhase: 'final_auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, null, now, 'final_auditing')
    expect(truncated).toBe(false)
    expect(spans.map((s) => s.phase)).toEqual(['final_auditing', 'coding', 'final_auditing'])
    expect(spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBe(10000)
    expect(spans[2].open).toBe(true)
    expect(spans[0].startedAt).toBe(startedAt)
  })

  test('a phase-changing restart overrides the prior terminal with a current-lifecycle destination span', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'auditing', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart' })
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 8000, 'coding')
    expect(truncated).toBe(false)
    expect(spans.map((s) => s.phase)).toEqual(['coding'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].open).toBe(true)
    expect(spans[0].durationMs).toBe(8000)
  })

  test('a phase-changing restart with no later transitions opens the destination phase from startedAt', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 10000, 'auditing')
    expect(spans.map((s) => s.phase)).toEqual(['coding'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].open).toBe(true)
    expect(spans[0].durationMs).toBe(10000)
  })

  test('out-of-order timestamps keep effective boundaries monotonic and totals within the lifetime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const now = startedAt + 7000
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, now)
    expect(spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(spans.filter((s) => !s.open).every((s) => s.startedAt <= s.endedAt!)).toBe(true)
    expect(spans[1]).toMatchObject({ phase: 'auditing', startedAt: t1.createdAt, endedAt: t1.createdAt })
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBeLessThanOrEqual(now - startedAt)
  })

  test('a terminal row followed by an out-of-order restart stays within the represented lifetime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 7000
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, now)
    expect(spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(spans.filter((s) => !s.open).every((s) => s.startedAt <= s.endedAt!)).toBe(true)
    expect(spans[1]).toMatchObject({ phase: 'coding', startedAt: t1.createdAt, endedAt: t1.createdAt, durationMs: 0 })
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBe(now - startedAt)
  })

  test('a same-phase restarted running loop emits an open current-phase span from the new startedAt', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: undefined, transitionKind: 'terminate' })
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, startedAt + 10000, 'final_auditing')
    expect(truncated).toBe(false)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      phase: 'final_auditing',
      startedAt,
      endedAt: null,
      durationMs: 10000,
      open: true,
    })
  })

  test('a phase-changing restart begins the current lifecycle in the destination phase', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const { spans } = computePhaseSpans([t1, t2, t3], startedAt, null, startedAt + 10000, 'auditing')
    expect(spans.map((s) => s.phase)).toEqual(['coding', 'auditing'])
    expect(spans[0]).toMatchObject({ startedAt, endedAt: t3.createdAt, durationMs: 5000 })
    expect(spans[1].open).toBe(true)
  })

  test('a normal transitioned loop derives the initial phase from the first transition', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 4000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 10000, 'final_auditing')
    expect(spans.map((s) => s.phase)).toEqual(['coding', 'auditing', 'final_auditing'])
    expect(spans[0]).toMatchObject({ startedAt, durationMs: 1000 })
    expect(spans[1].durationMs).toBe(3000)
    expect(spans[2]).toMatchObject({ open: true, durationMs: 6000 })
    expect(summarizePhaseTotals(spans)).toEqual({ coding: 1000, auditing: 3000, final_auditing: 6000 })
  })

  test('a failed inactive restart after completion does not extend spans past completedAt', () => {
    const startedAt = 1700000000000
    const completedAt = startedAt + 8000
    const restartAt = completedAt + 3_600_000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: completedAt, fromPhase: 'auditing', toPhase: undefined, transitionKind: 'terminate' })
    const t3 = makeTransition({ id: 3, createdAt: restartAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart' })
    const t4 = makeTransition({ id: 4, createdAt: restartAt + 50, fromPhase: 'coding', toPhase: 'auditing', eventType: 'restart_prompt_failed' })
    const { spans } = computePhaseSpans([t1, t2, t3, t4], startedAt, completedAt, restartAt + 1000, 'auditing')
    expect(spans.every((s) => !s.open)).toBe(true)
    expect(spans.every((s) => s.durationMs >= 0)).toBe(true)
    expect(spans.map((s) => s.phase)).toEqual(['coding', 'auditing'])
    expect(spans.reduce((acc, s) => acc + s.durationMs, 0)).toBe(completedAt - startedAt)
    for (const s of spans) {
      expect(s.startedAt).toBeGreaterThanOrEqual(startedAt)
      expect(s.endedAt!).toBeLessThanOrEqual(completedAt)
    }
  })
})

describe('phaseLegendRows', () => {
  function makeSpan(phase: string, durationMs: number): PhaseSpan {
    return { phase, startedAt: 0, endedAt: durationMs, durationMs, open: false }
  }

  test('returns one row per non-empty phase sorted by descending durationMs', () => {
    const rows = phaseLegendRows([
      makeSpan('coding', 2000),
      makeSpan('auditing', 6000),
      makeSpan('post_action', 2000),
      makeSpan('', 999),
    ])
    expect(rows.map((r) => r.phase)).toEqual(['auditing', 'coding', 'post_action'])
    expect(rows[0]).toEqual({ phase: 'auditing', label: 'Auditing', durationMs: 6000, pct: 60 })
    expect(rows[1]).toEqual({ phase: 'coding', label: 'Coding', durationMs: 2000, pct: 20 })
  })

  test('folds repeated visits to one phase into a single row', () => {
    const rows = phaseLegendRows([makeSpan('coding', 1000), makeSpan('auditing', 1000), makeSpan('coding', 2000)])
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.phase === 'coding')!.durationMs).toBe(3000)
    expect(rows.reduce((sum, r) => sum + r.pct, 0)).toBe(100)
  })

  test('rounds pct to integers', () => {
    expect(phaseLegendRows([makeSpan('coding', 1), makeSpan('auditing', 2)]).map((r) => r.pct)).toEqual([67, 33])
  })

  test('returns an empty array when every span has an empty phase', () => {
    expect(phaseLegendRows([makeSpan('', 500)])).toEqual([])
    expect(phaseLegendRows([])).toEqual([])
  })
})

describe('computeTimelineEvents', () => {
  test('returns events newest first', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000 })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000 })
    expect(computeTimelineEvents([t1, t2], startedAt, false).map((e) => e.transition.id)).toEqual([2, 1])
  })

  test('a contiguous chain retains correct elapsed values per row', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'final_auditing', toPhase: undefined })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
    expect(events[1].elapsedMs).toBe(t2.createdAt - t1.createdAt)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
  })

  test('the oldest row of a truncated window has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 13000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2], startedAt, true)
    expect(events[1].transition.id).toBe(1)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[0].elapsedMs).toBe(t2.createdAt - t1.createdAt)
  })

  test('the oldest row being a restart marker has null elapsed', () => {
    const startedAt = 1700000100000
    const restart = makeTransition({ id: 1, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const next = makeTransition({ id: 2, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([restart, next], startedAt, false)
    expect(events[0].elapsedMs).toBe(next.createdAt - startedAt)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a row following a terminal transition has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 500, fromPhase: 'coding', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 15000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a preserved pre-restart oldest row predating startedAt has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'coding', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 4000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[2].elapsedMs).toBeNull()
    expect(events[1].elapsedMs).toBe(t2.createdAt - startedAt)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a same-phase restart followed by a transition uses startedAt', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 600000, fromPhase: 'final_auditing', toPhase: 'coding' })
    const events = computeTimelineEvents([t1, t2], startedAt, false)
    expect(events[0].elapsedMs).toBe(t2.createdAt - startedAt)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a historical restart marker predating startedAt measures its successor from the marker', () => {
    const startedAt = 1700000100000
    const oldRestart = makeTransition({ id: 1, createdAt: startedAt - 100000, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const oldSuccessor = makeTransition({ id: 2, createdAt: startedAt - 50000, fromPhase: 'coding', toPhase: 'auditing' })
    const restart = makeTransition({ id: 3, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const successor = makeTransition({ id: 4, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const byId = new Map(
      computeTimelineEvents([oldRestart, oldSuccessor, restart, successor], startedAt, false).map((e) => [
        e.transition.id,
        e.elapsedMs,
      ]),
    )
    expect(byId.get(4)).toBe(successor.createdAt - startedAt)
    expect(byId.get(3)).toBeNull()
    expect(byId.get(2)).toBe(oldSuccessor.createdAt - oldRestart.createdAt)
    expect(byId.get(1)).toBeNull()
  })

  test('a phase-changing restart row keeps its elapsed null rather than using the terminal as boundary', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'auditing', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a transition after a phase-changing restart measures elapsed from startedAt, not the marker', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: undefined, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[0].elapsedMs).toBe(t3.createdAt - startedAt)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a row whose predecessor flowed into a different phase has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'final_auditing', toPhase: 'plan' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'plan', toPhase: undefined })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
  })

  test('no event ever carries a negative elapsed value', () => {
    const startedAt = 1700000000000
    const events = computeTimelineEvents(
      [
        makeTransition({ id: 1, createdAt: startedAt + 5000 }),
        makeTransition({ id: 2, createdAt: startedAt + 1000 }),
        makeTransition({ id: 3, createdAt: startedAt + 4000 }),
      ],
      startedAt,
      false,
    )
    for (const e of events) expect(e.elapsedMs === null || e.elapsedMs >= 0).toBe(true)
  })

  test('empty transitions yield an empty event list', () => {
    expect(computeTimelineEvents([], 1700000000000, false)).toEqual([])
  })
})

describe('summarizeAmendments / amendedSectionIndexes', () => {
  test('empty amendments yield a zero summary', () => {
    expect(summarizeAmendments([])).toEqual({ count: 0, lastAt: null, lastSection: null })
  })

  test('takes lastAt/lastSection from the newest createdAt, not the last array position', () => {
    const newest = makeAmendment({ id: 2, createdAt: 3000, appliedAtSection: 4 })
    const oldest = makeAmendment({ id: 1, createdAt: 1000, appliedAtSection: 2 })
    const middle = makeAmendment({ id: 3, createdAt: 2000, appliedAtSection: 5 })
    expect(summarizeAmendments([newest, oldest, middle])).toEqual({
      count: 3,
      lastAt: 3000,
      lastSection: 4,
    })
  })

  test('equal createdAt ties break toward the highest id', () => {
    const a1 = makeAmendment({ id: 1, createdAt: 1000, appliedAtSection: 2 })
    const a2 = makeAmendment({ id: 2, createdAt: 1000, appliedAtSection: 4 })
    expect(summarizeAmendments([a1, a2])).toEqual({ count: 2, lastAt: 1000, lastSection: 4 })
  })

  test('amendedSectionIndexes collects distinct section indexes', () => {
    expect(amendedSectionIndexes([])).toEqual(new Set<number>())
    const indexes = amendedSectionIndexes([
      makeAmendment({ id: 1, appliedAtSection: 2 }),
      makeAmendment({ id: 2, appliedAtSection: 4 }),
      makeAmendment({ id: 3, appliedAtSection: 2 }),
    ])
    expect(indexes).toEqual(new Set([2, 4]))
  })
})

describe('mergeTimelineEntries', () => {
  test('merges transitions and amendments into one newest-first timeline', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const a1 = makeAmendment({ id: 10, createdAt: startedAt + 2000, appliedAtSection: 4 })
    const entries = mergeTimelineEntries([t1, t2], [a1], startedAt, false)
    expect(entries.map((e) => e.kind)).toEqual(['transition', 'amendment', 'transition'])
    expect(entries[0].kind === 'transition' && entries[0].transition.id).toBe(2)
    expect(entries[1].kind === 'amendment' && entries[1].amendment).toBe(a1)
    expect(entries[2].kind === 'transition' && entries[2].transition.id).toBe(1)
  })

  test('transition entries preserve computeTimelineEvents elapsed values', () => {
    const startedAt = 1700000000000
    const transitions = [
      makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' }),
      makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' }),
      makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'final_auditing', toPhase: undefined }),
    ]
    const expected = new Map(
      computeTimelineEvents(transitions, startedAt, false).map((e) => [e.transition.id, e.elapsedMs]),
    )
    for (const e of mergeTimelineEntries(transitions, [], startedAt, false)) {
      if (e.kind === 'transition') expect(e.elapsedMs).toBe(expected.get(e.transition.id))
    }
  })

  test('amendment entries carry elapsedMs null', () => {
    const a1 = makeAmendment({ id: 10, createdAt: 1700000001000 })
    const entries = mergeTimelineEntries([], [a1], 1700000000000, false)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('amendment')
    if (entries[0].kind === 'amendment') expect(entries[0].elapsedMs).toBeNull()
  })

  test('equal createdAt ties break transition-before-amendment', () => {
    const startedAt = 1700000000000
    const t = makeTransition({ id: 1, createdAt: startedAt + 1000 })
    const a = makeAmendment({ id: 10, createdAt: startedAt + 1000 })
    expect(mergeTimelineEntries([t], [a], startedAt, false).map((e) => e.kind)).toEqual(['transition', 'amendment'])
  })

  test('rows sharing one createdAt order by descending id', () => {
    const startedAt = 1700000000000
    const transitions = [1, 2, 3].map((id) =>
      makeTransition({ id, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' }),
    )
    const amendments = [10, 11, 12].map((id) => makeAmendment({ id, createdAt: startedAt + 1000 }))
    expect(
      mergeTimelineEntries(transitions, amendments, startedAt, false)
        .filter((e) => e.kind === 'transition')
        .map((e) => (e.kind === 'transition' ? e.transition.id : -1)),
    ).toEqual([3, 2, 1])
    expect(
      mergeTimelineEntries(transitions, amendments, startedAt, false)
        .filter((e) => e.kind === 'amendment')
        .map((e) => (e.kind === 'amendment' ? e.amendment.id : -1)),
    ).toEqual([12, 11, 10])
  })
})

describe('groupFindingsBySection', () => {
  test('groups by section ascending with cross-section findings last', () => {
    const groups = groupFindingsBySection([
      makeFinding({ file: 'a.ts', sectionIndex: 2 }),
      makeFinding({ file: 'b.ts', sectionIndex: undefined }),
      makeFinding({ file: 'c.ts', sectionIndex: 0 }),
      makeFinding({ file: 'd.ts', sectionIndex: 2 }),
    ])
    expect(groups.map((g) => g.key)).toEqual([0, 2, null])
    expect(groups.map((g) => g.label)).toEqual(['sect 1', 'sect 3', 'cross-section'])
    expect(groups[1].rows.map((f) => f.file)).toEqual(['a.ts', 'd.ts'])
    expect(groups[2].rows.map((f) => f.file)).toEqual(['b.ts'])
  })

  test('returns no groups for no findings', () => {
    expect(groupFindingsBySection([])).toEqual([])
  })
})
