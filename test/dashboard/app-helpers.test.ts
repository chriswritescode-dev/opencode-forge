import { describe, test, expect, beforeEach } from 'vitest'
import {
  parseDashboardHash,
  buildDashboardHash,
  fmtTime,
  statusClass,
  sectionStatusClass,
  loopMatchesFilters,
  sortLoops,
  dataHash,
  buildRepoLabels,
  splitFindings,
  findingsLevel,
  formatFindingCount,
  clampPercent,
  formatFinding,
  formatModelUsage,
  formatTokenCount,
  formatUsageCost,
  tokenBreakdownSegments,
  modelUsageBars,
  roleUsageBars,
  renderMarkdown,
  tabsForLoop,
  computePhaseSpans,
  summarizePhaseTotals,
  computeTimelineEvents,
  capList,
} from '../../src/dashboard/app/helpers'
import type { LoopTab } from '../../src/dashboard/app/helpers'
import type { DashboardPayload, DashboardProject, DashboardLoop, LoopTransitionRow } from '../../src/dashboard/app/types'
import type { ReviewFindingRow } from '../../src/storage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLoopRow(overrides: Partial<DashboardLoop['loop']> = {}): DashboardLoop['loop'] {
  return {
    projectId: 'p1',
    loopName: 'my-loop',
    status: 'running',
    currentSessionId: 'sess-abc',
    worktree: false,
    worktreeDir: '',
    worktreeBranch: null,
    projectDir: '/projects/p1',
    maxIterations: 10,
    iteration: 3,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: 1700000000000,
    completedAt: null,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 1,
    totalSections: 5,
    finalAuditDone: 0,
    executionVariant: null,
    auditorVariant: null,
    kind: 'plan',
    ...overrides,
  }
}

function mockProject(overrides: Partial<DashboardProject> = {}): DashboardProject {
  return {
    projectId: 'p1',
    projectDir: '/projects/p1',
    loops: [],
    ...overrides,
  }
}

function mockDashLoop(overrides: Partial<DashboardLoop> = {}): DashboardLoop {
  return {
    loop: mockLoopRow(),
    lastAuditResult: null,
    plan: null,
    hasPlan: false,
    sections: [],
    sectionCount: 0,
    findings: [],
    usage: null,
    duration: null,
    ...overrides,
  }
}

function mockFinding(overrides: Partial<ReviewFindingRow> = {}): ReviewFindingRow {
  return {
    projectId: 'p1',
    file: 'src/main.ts',
    line: 42,
    severity: 'bug',
    description: 'Null pointer',
    scenario: null,
    loopName: 'my-loop',
    sectionIndex: null,
    createdAt: 100,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseDashboardHash / buildDashboardHash
// ---------------------------------------------------------------------------

describe('parseDashboardHash / buildDashboardHash', () => {
  test('empty hash returns the default route', () => {
    expect(parseDashboardHash('')).toEqual({
      projectId: null,
      section: 'loops',
      loopName: null,
      tab: 'overview',
      groupId: null,
      statuses: [],
      query: '',
    })
  })

  test('project-only hash yields projectId with default loops section', () => {
    const r = parseDashboardHash('#p1')
    expect(r.projectId).toBe('p1')
    expect(r.section).toBe('loops')
    expect(r.loopName).toBeNull()
    expect(r.tab).toBe('overview')
  })

  test('groups section keyword sets section groups', () => {
    const r = parseDashboardHash('#p1/groups')
    expect(r.projectId).toBe('p1')
    expect(r.section).toBe('groups')
    expect(r.groupId).toBeNull()
  })

  test('group detail sets groupId', () => {
    const r = parseDashboardHash('#p1/groups/g-abc')
    expect(r.section).toBe('groups')
    expect(r.groupId).toBe('g-abc')
  })

  test('canonical loop route sets loopName with default overview tab', () => {
    const r = parseDashboardHash('#p1/loop/my-loop')
    expect(r.projectId).toBe('p1')
    expect(r.section).toBe('loops')
    expect(r.loopName).toBe('my-loop')
    expect(r.tab).toBe('overview')
  })

  test('explicit tab is parsed', () => {
    const r = parseDashboardHash('#p1/loop/my-loop/timeline')
    expect(r.loopName).toBe('my-loop')
    expect(r.tab).toBe('timeline')
  })

  test('unknown tab falls back to overview rather than throwing', () => {
    const r = parseDashboardHash('#p1/loop/x/bogus')
    expect(r.loopName).toBe('x')
    expect(r.tab).toBe('overview')
  })

  test('legacy second segment is treated as a loop name', () => {
    const r = parseDashboardHash('#p1/my-loop')
    expect(r.section).toBe('loops')
    expect(r.loopName).toBe('my-loop')
    expect(r.tab).toBe('overview')
  })

  test('legacy collision guard: section keyword wins over loop name', () => {
    const r = parseDashboardHash('#p1/loops')
    expect(r.section).toBe('loops')
    expect(r.loopName).toBeNull()
  })

  test('filters parse status and query', () => {
    const r = parseDashboardHash('#p1?status=running,errored&q=post')
    expect(r.statuses).toEqual(['running', 'errored'])
    expect(r.query).toBe('post')
  })

  test('filters combine with a loop route', () => {
    const r = parseDashboardHash('#p1/loop/x/usage?status=running')
    expect(r.loopName).toBe('x')
    expect(r.tab).toBe('usage')
    expect(r.statuses).toEqual(['running'])
    expect(r.query).toBe('')
  })

  test('percent-encoding of slashes and spaces round-trips', () => {
    const h = '#' + encodeURIComponent('proj x/y') + '/loop/' + encodeURIComponent('loop a/b')
    const r = parseDashboardHash(h)
    expect(r.projectId).toBe('proj x/y')
    expect(r.loopName).toBe('loop a/b')
    expect(buildDashboardHash(r)).toBe(h)
  })

  test('buildDashboardHash omits defaults for a project-only route', () => {
    expect(
      buildDashboardHash({
        projectId: 'p1',
        section: 'loops',
        loopName: null,
        tab: 'overview',
        groupId: null,
        statuses: [],
        query: '',
      }),
    ).toBe('#p1')
  })

  test('round-trip property for canonical hashes', () => {
    // Legacy (#p1/my-loop), section-keyword-only (#p1/loops), and unknown-tab
    // (#p1/loop/x/bogus) inputs intentionally canonicalize on build per case
    // 13, so they are excluded from the literal round-trip set below.
    const hashes = [
      '#p1',
      '#p1/groups',
      '#p1/groups/g-abc',
      '#p1/loop/my-loop',
      '#p1/loop/my-loop/timeline',
      '#p1?status=running,errored&q=post',
      '#p1/loop/x/usage?status=running',
      '#' + encodeURIComponent('proj x/y') + '/loop/' + encodeURIComponent('loop a/b'),
    ]
    for (const h of hashes) {
      expect(buildDashboardHash(parseDashboardHash(h))).toBe(h)
    }
  })

  test('legacy and unknown-tab inputs canonicalize via parse/build', () => {
    // Although not literal round-trips, these inputs preserve their semantic
    // route through a parse -> build -> parse cycle.
    const normalize: [string, string][] = [
      ['#p1/my-loop', '#p1/loop/my-loop'],
      ['#p1/loops', '#p1'],
      ['#p1/loop/x/bogus', '#p1/loop/x'],
    ]
    for (const [input, canonical] of normalize) {
      const built = buildDashboardHash(parseDashboardHash(input))
      expect(built).toBe(canonical)
      const reparsed = parseDashboardHash(built)
      expect(parseDashboardHash(canonical)).toEqual(reparsed)
    }
  })

  test('malformed percent escape in project id does not throw', () => {
    const r = parseDashboardHash('#%')
    expect(r).toEqual({
      projectId: '%',
      section: 'loops',
      loopName: null,
      tab: 'overview',
      groupId: null,
      statuses: [],
      query: '',
    })
  })

  test('malformed percent escape in loop segment does not throw', () => {
    const r = parseDashboardHash('#p1/loop/%')
    expect(r.projectId).toBe('p1')
    expect(r.loopName).toBe('%')
    expect(r.tab).toBe('overview')
  })

  test('malformed percent escape in groups segment does not throw', () => {
    const r = parseDashboardHash('#p1/groups/%GG')
    expect(r.section).toBe('groups')
    expect(r.groupId).toBe('%GG')
  })

  test('malformed percent escape in query value does not throw', () => {
    const r = parseDashboardHash('#p1?q=%GG')
    expect(r.projectId).toBe('p1')
    expect(r.query).toBe('%GG')
  })

  test('malformed percent escape in query key does not throw', () => {
    const r = parseDashboardHash('#p1?%GG=post')
    expect(r.projectId).toBe('p1')
    // Unknown key is ignored; route is otherwise valid.
    expect(r.statuses).toEqual([])
    expect(r.query).toBe('')
  })

  test('mixed malformed escapes across path and query do not throw', () => {
    const r = parseDashboardHash('#%ZZ/loop/%/timeline?status=%&q=%GG')
    expect(r.projectId).toBe('%ZZ')
    expect(r.loopName).toBe('%')
    expect(r.tab).toBe('timeline')
    expect(r.statuses).toEqual(['%'])
    expect(r.query).toBe('%GG')
  })
})

// ---------------------------------------------------------------------------
// buildRepoLabels
// ---------------------------------------------------------------------------

describe('buildRepoLabels', () => {
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
})

// ---------------------------------------------------------------------------
// tabsForLoop
// ---------------------------------------------------------------------------

describe('tabsForLoop', () => {
  test('plan loop with sections and a plan returns all six tabs in order', () => {
    const loop = mockDashLoop({
      hasPlan: true,
      sectionCount: 1,
    })
    expect(tabsForLoop(loop)).toEqual<LoopTab[]>(['overview', 'timeline', 'sections', 'findings', 'plan', 'usage'])
  })

  test('goal loop with zero sections omits the sections tab', () => {
    const loop = mockDashLoop({ hasPlan: false, sectionCount: 0 })
    expect(tabsForLoop(loop)).toEqual<LoopTab[]>(['overview', 'timeline', 'findings', 'usage'])
  })

  test('loop with hasPlan: false omits the plan tab', () => {
    const loop = mockDashLoop({
      hasPlan: false,
      sectionCount: 1,
    })
    const tabs = tabsForLoop(loop)
    expect(tabs).not.toContain<LoopTab>('plan')
    expect(tabs).toContain<LoopTab>('sections')
  })

  test('tabsForLoop never returns an empty array', () => {
    const loop = mockDashLoop({ hasPlan: false, sectionCount: 0 })
    const tabs = tabsForLoop(loop)
    expect(tabs.length).toBeGreaterThan(0)
    expect(tabs[0]).toBe<LoopTab>('overview')
    expect(tabs[tabs.length - 1]).toBe<LoopTab>('usage')
  })
})

// ---------------------------------------------------------------------------
// loopMatchesFilters
// ---------------------------------------------------------------------------

describe('loopMatchesFilters', () => {
  const loop = mockLoopRow({
    status: 'completed',
    loopName: 'feature-x',
    worktreeBranch: 'feat/branch-1',
  })
  const label = 'my-app'

  test('empty activeStatuses means no status filtering (matches all)', () => {
    expect(loopMatchesFilters(loop, new Set(), '', label)).toBe(true)
  })

  test('status membership filter — matching status', () => {
    expect(loopMatchesFilters(loop, new Set(['completed']), '', label)).toBe(true)
  })

  test('status membership filter — non-matching status', () => {
    expect(loopMatchesFilters(loop, new Set(['running']), '', label)).toBe(false)
  })

  test('matches on loop name substring', () => {
    expect(loopMatchesFilters(loop, new Set(), 'feature', label)).toBe(true)
  })

  test('matches on worktreeBranch substring', () => {
    expect(loopMatchesFilters(loop, new Set(), 'branch-1', label)).toBe(true)
  })

  test('matches on short repo label', () => {
    expect(loopMatchesFilters(loop, new Set(), 'my-app', label)).toBe(true)
  })

  test('does not match on a path segment absent from the label', () => {
    // Full repo path would be /projects/my-app; the parent segment "projects"
    // is intentionally excluded from the short label, so it must not match.
    expect(loopMatchesFilters(loop, new Set(), 'projects', label)).toBe(false)
  })

  test('non-matching search returns false', () => {
    expect(loopMatchesFilters(loop, new Set(), 'nonexistent', label)).toBe(false)
  })

  test('search AND status filter combine correctly', () => {
    expect(loopMatchesFilters(loop, new Set(['running']), 'feature', label)).toBe(false)
    expect(loopMatchesFilters(loop, new Set(['completed']), 'feature', label)).toBe(true)
  })

  test('loop with null worktreeBranch matches on other fields', () => {
    const l = mockLoopRow({ loopName: 'feature-x', worktreeBranch: null })
    expect(loopMatchesFilters(l, new Set(), 'feature', label)).toBe(true)
  })

  test('empty label does not cause a false positive on whitespace', () => {
    expect(loopMatchesFilters(loop, new Set(), '', '')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sortLoops
// ---------------------------------------------------------------------------

describe('sortLoops', () => {
  function makeDash(over: Partial<DashboardLoop> = {}): DashboardLoop {
    return {
      id: 'test-id',
      loop: mockLoopRow(),
      lastAuditResult: null,
      postActionReport: null,
      goal: null,
      plan: null,
      hasPlan: false,
      sections: [],
      sectionCount: 0,
      findings: [],
      bugCount: 0,
      usage: null,
      duration: null,
      transitions: [],
      amendments: [],
      ...over,
    }
  }

  test('by cost puts loops with null usage last, not first', () => {
    const loops = [
      makeDash({
        loop: mockLoopRow({ loopName: 'a' }),
        usage: null,
      }),
      makeDash({
        loop: mockLoopRow({ loopName: 'b' }),
        usage: {
          loopName: 'b',
          totalCost: 2,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 0,
          byModel: {},
          byRole: {},
        },
      }),
      makeDash({
        loop: mockLoopRow({ loopName: 'c' }),
        usage: {
          loopName: 'c',
          totalCost: 5,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 0,
          byModel: {},
          byRole: {},
        },
      }),
    ]
    const sorted = sortLoops(loops, 'cost')
    expect(sorted.map(dl => dl.loop.loopName)).toEqual(['c', 'b', 'a'])
  })

  test('by recent preserves the running-first ordering', () => {
    // Input mirrors the backend's running-first ordering (running loops first,
    // then by startedAt desc). `recent` must not reorder.
    const loops = [
      makeDash({ loop: mockLoopRow({ loopName: 'r1', status: 'running', startedAt: 1700000500000 }) }),
      makeDash({ loop: mockLoopRow({ loopName: 'r2', status: 'running', startedAt: 1700000400000 }) }),
      makeDash({ loop: mockLoopRow({ loopName: 'c1', status: 'completed', startedAt: 1700000300000 }) }),
      makeDash({ loop: mockLoopRow({ loopName: 'c2', status: 'completed', startedAt: 1700000100000 }) }),
    ]
    const sorted = sortLoops(loops, 'recent')
    expect(sorted.map(dl => dl.loop.loopName)).toEqual(['r1', 'r2', 'c1', 'c2'])
    // Original array is not mutated.
    expect(loops.map(dl => dl.loop.loopName)).toEqual(['r1', 'r2', 'c1', 'c2'])
  })
})

// ---------------------------------------------------------------------------
// dataHash
// ---------------------------------------------------------------------------

describe('dataHash', () => {
  const emptyPayload: DashboardPayload = {
    generatedAt: 100,
    projects: [],
  }

  test('identical payloads differing only in generatedAt produce equal hashes', () => {
    const a: DashboardPayload = { ...emptyPayload, generatedAt: 100 }
    const b: DashboardPayload = { ...emptyPayload, generatedAt: 999 }
    expect(dataHash(a)).toBe(dataHash(b))
  })

  test('differing loop data produces different hashes', () => {
    const a: DashboardPayload = {
      ...emptyPayload,
      projects: [
        {
          projectId: 'p1',
          projectDir: null,
          loops: [
            {
              loop: mockLoopRow({ loopName: 'loop-a' }),
              lastAuditResult: null,
              plan: null,
              sections: [],
              findings: [],
              usage: null,
              duration: null,
            },
          ],
        },
      ],
    }
    const b: DashboardPayload = {
      ...emptyPayload,
      projects: [
        {
          projectId: 'p1',
          projectDir: null,
          loops: [
            {
              loop: mockLoopRow({ loopName: 'loop-b' }),
              lastAuditResult: null,
              plan: null,
              sections: [],
              findings: [],
              usage: null,
              duration: null,
            },
          ],
        },
      ],
    }
    expect(dataHash(a)).not.toBe(dataHash(b))
  })

  test('order of keys in the payload is deterministic', () => {
    const a = dataHash(emptyPayload)
    const b = dataHash({ ...emptyPayload, generatedAt: 999 })
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// fmtTime
// ---------------------------------------------------------------------------

describe('fmtTime', () => {
  test('returns empty string for 0', () => {
    expect(fmtTime(0)).toBe('')
  })

  test('returns empty string for null', () => {
    expect(fmtTime(null)).toBe('')
  })

  test('returns empty string for undefined', () => {
    expect(fmtTime(undefined)).toBe('')
  })

  test('formats a known timestamp with the expected pattern', () => {
    const result = fmtTime(new Date('2024-01-15T14:30:00').getTime())
    expect(result).toMatch(/^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} (AM|PM)$/)
  })

  test('formats midnight as 12:00 AM', () => {
    const midnight = new Date('2024-06-15T00:00:00').getTime()
    const result = fmtTime(midnight)
    expect(result).toMatch(/^\d{2}-\d{2}-2024 12:00 AM$/)
  })
})

// ---------------------------------------------------------------------------
// statusClass / sectionStatusClass
// ---------------------------------------------------------------------------

describe('statusClass', () => {
  test('returns status-badge status-<status>', () => {
    expect(statusClass('running')).toBe('status-badge status-running')
    expect(statusClass('completed')).toBe('status-badge status-completed')
    expect(statusClass('errored')).toBe('status-badge status-errored')
  })
})

describe('sectionStatusClass', () => {
  test('returns section-status section-<status>', () => {
    expect(sectionStatusClass('pending')).toBe('section-status section-pending')
    expect(sectionStatusClass('in_progress')).toBe('section-status section-in_progress')
    expect(sectionStatusClass('completed')).toBe('section-status section-completed')
    expect(sectionStatusClass('failed')).toBe('section-status section-failed')
  })
})

// ---------------------------------------------------------------------------
// splitFindings
// ---------------------------------------------------------------------------

describe('splitFindings', () => {
  test('partitions bugs vs warnings', () => {
    const findings: ReviewFindingRow[] = [
      mockFinding({ severity: 'bug', description: 'Bug A' }),
      mockFinding({ severity: 'warning', description: 'Warning B' }),
      mockFinding({ severity: 'bug', description: 'Bug C' }),
      mockFinding({ severity: 'warning', description: 'Warning D' }),
    ]
    const { bugs, warnings } = splitFindings(findings)
    expect(bugs).toHaveLength(2)
    expect(bugs.every((f) => f.severity === 'bug')).toBe(true)
    expect(warnings).toHaveLength(2)
    expect(warnings.every((f) => f.severity === 'warning')).toBe(true)
  })

  test('handles empty array', () => {
    const { bugs, warnings } = splitFindings([])
    expect(bugs).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })

  test('handles all bugs', () => {
    const findings = [
      mockFinding({ severity: 'bug' }),
      mockFinding({ severity: 'bug' }),
    ]
    const { bugs, warnings } = splitFindings(findings)
    expect(bugs).toHaveLength(2)
    expect(warnings).toHaveLength(0)
  })

  test('handles all warnings', () => {
    const findings = [
      mockFinding({ severity: 'warning' }),
      mockFinding({ severity: 'warning' }),
    ]
    const { bugs, warnings } = splitFindings(findings)
    expect(bugs).toHaveLength(0)
    expect(warnings).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// findingsLevel
// ---------------------------------------------------------------------------

describe('findingsLevel', () => {
  test('returns bug when any bug present', () => {
    expect(findingsLevel({ bugs: [mockFinding({ severity: 'bug' })], warnings: [] })).toBe('bug')
    expect(
      findingsLevel({ bugs: [mockFinding({ severity: 'bug' })], warnings: [mockFinding({ severity: 'warning' })] }),
    ).toBe('bug')
  })

  test('returns warn when only warnings present', () => {
    expect(findingsLevel({ bugs: [], warnings: [mockFinding({ severity: 'warning' })] })).toBe('warn')
  })

  test('returns clean when no findings', () => {
    expect(findingsLevel({ bugs: [], warnings: [] })).toBe('clean')
  })
})

// ---------------------------------------------------------------------------
// formatFindingCount
// ---------------------------------------------------------------------------

describe('formatFindingCount', () => {
  test('singular for count of 1', () => {
    expect(formatFindingCount(1, 'bug')).toBe('1 bug')
    expect(formatFindingCount(1, 'warning')).toBe('1 warning')
  })

  test('plural for counts other than 1', () => {
    expect(formatFindingCount(0, 'bug')).toBe('0 bugs')
    expect(formatFindingCount(2, 'warning')).toBe('2 warnings')
  })
})

// ---------------------------------------------------------------------------
// clampPercent
// ---------------------------------------------------------------------------

describe('clampPercent', () => {
  test('returns 0 for non-positive or missing total', () => {
    expect(clampPercent(3, 0)).toBe(0)
    expect(clampPercent(3, -5)).toBe(0)
    expect(clampPercent(3, NaN)).toBe(0)
  })

  test('computes percentage within range', () => {
    expect(clampPercent(1, 4)).toBe(25)
    expect(clampPercent(0, 10)).toBe(0)
  })

  test('clamps to 0–100 when out of range', () => {
    expect(clampPercent(10, 5)).toBe(100)
    expect(clampPercent(-2, 5)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatFinding
// ---------------------------------------------------------------------------

describe('formatFinding', () => {
  test('formats with file:line — description', () => {
    const f = mockFinding({ file: 'src/util.ts', line: 15, description: 'Unused variable', scenario: null })
    expect(formatFinding(f)).toBe('src/util.ts:15 — Unused variable')
  })

  test('includes scenario in parentheses when present', () => {
    const f = mockFinding({ file: 'src/app.ts', line: 99, description: 'Memory leak', scenario: 'when data > 1MB' })
    expect(formatFinding(f)).toBe('src/app.ts:99 — Memory leak (when data > 1MB)')
  })

  test('handles line number 0', () => {
    const f = mockFinding({ file: 'config.ts', line: 0, description: 'Syntax error', scenario: null })
    expect(formatFinding(f)).toBe('config.ts:0 — Syntax error')
  })
})

// ---------------------------------------------------------------------------
// formatModelUsage
// ---------------------------------------------------------------------------

describe('formatModelUsage', () => {
  const modelData: NonNullable<DashboardLoop['usage']>['byModel'][string] = {
    cost: 0.987654,
    inputTokens: 200,
    outputTokens: 75,
    reasoningTokens: 15,
    cacheReadTokens: 30,
    cacheWriteTokens: 8,
    messageCount: 5,
  }

  test('includes model name and cost with 6 decimals', () => {
    const result = formatModelUsage('gpt-4', modelData)
    expect(result).toMatch(/^\s+gpt-4:\s+\$0\.987654/)
  })

  test('includes token breakdown', () => {
    const result = formatModelUsage('gpt-4', modelData)
    expect(result).toContain('200 in / 75 out')
    expect(result).toContain('reasoning: 15')
    expect(result).toContain('cache R: 30')
    expect(result).toContain('W: 8')
  })

  test('includes message count', () => {
    const result = formatModelUsage('gpt-4', modelData)
    expect(result).toContain('messages: 5')
  })
})

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe('formatTokenCount', () => {
  test('returns "0" for zero or negative', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })

  test('returns raw number below 1000', () => {
    expect(formatTokenCount(999)).toBe('999')
  })

  test('formats thousands with k suffix', () => {
    expect(formatTokenCount(12345)).toBe('12.3k')
    expect(formatTokenCount(2000)).toBe('2k')
  })

  test('formats millions with M suffix', () => {
    expect(formatTokenCount(3_400_000)).toBe('3.4M')
    expect(formatTokenCount(1_000_000)).toBe('1M')
  })
})

// ---------------------------------------------------------------------------
// formatUsageCost
// ---------------------------------------------------------------------------

describe('formatUsageCost', () => {
  test('returns "$0" for zero or negative', () => {
    expect(formatUsageCost(0)).toBe('$0')
    expect(formatUsageCost(-1)).toBe('$0')
  })

  test('keeps 4 decimals below $1', () => {
    expect(formatUsageCost(0.1234)).toBe('$0.1234')
  })

  test('rounds to cents at or above $1', () => {
    expect(formatUsageCost(12.3456)).toBe('$12.35')
    expect(formatUsageCost(1)).toBe('$1.00')
  })
})

// ---------------------------------------------------------------------------
// tokenBreakdownSegments
// ---------------------------------------------------------------------------

describe('tokenBreakdownSegments', () => {
  const usage: NonNullable<DashboardLoop['usage']> = {
    loopName: 'test-loop',
    totalCost: 1,
    totalInputTokens: 50,
    totalOutputTokens: 30,
    totalReasoningTokens: 10,
    totalCacheReadTokens: 8,
    totalCacheWriteTokens: 2,
    totalMessageCount: 4,
    byModel: {},
    byRole: {},
  }

  test('returns five labeled segments', () => {
    const segs = tokenBreakdownSegments(usage)
    expect(segs.map(s => s.label)).toEqual(['Input', 'Output', 'Reasoning', 'Cache R', 'Cache W'])
  })

  test('percentages are share of total and sum to 100', () => {
    const segs = tokenBreakdownSegments(usage)
    // total = 100, so pct equals the raw value
    expect(segs[0].pct).toBeCloseTo(50)
    expect(segs[1].pct).toBeCloseTo(30)
    const sum = segs.reduce((acc, s) => acc + s.pct, 0)
    expect(sum).toBeCloseTo(100)
  })

  test('all-zero usage yields zero-width segments (no divide by zero)', () => {
    const zero = { ...usage, totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 }
    const segs = tokenBreakdownSegments(zero)
    expect(segs.every(s => s.pct === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// modelUsageBars
// ---------------------------------------------------------------------------

describe('modelUsageBars', () => {
  const usage: NonNullable<DashboardLoop['usage']> = {
    loopName: 'test-loop',
    totalCost: 3,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalMessageCount: 0,
    byModel: {
      'cheap-model': { cost: 0.5, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
      'pricey-model': { cost: 2, inputTokens: 400, outputTokens: 80, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
    },
    byRole: {},
  }

  test('sorts by cost descending', () => {
    const bars = modelUsageBars(usage)
    expect(bars.map(b => b.model)).toEqual(['pricey-model', 'cheap-model'])
  })

  test('pct is relative to the most expensive model', () => {
    const bars = modelUsageBars(usage)
    expect(bars[0].pct).toBeCloseTo(100)
    expect(bars[1].pct).toBeCloseTo(25)
  })

  test('returns empty array when no models', () => {
    expect(modelUsageBars({ ...usage, byModel: {} })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// roleUsageBars
// ---------------------------------------------------------------------------

describe('roleUsageBars', () => {
  const usage: NonNullable<DashboardLoop['usage']> = {
    loopName: 'test-loop',
    totalCost: 3,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalMessageCount: 8,
    byModel: {
      'exec-model': { cost: 2, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
      'audit-model': { cost: 1, inputTokens: 50, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
    },
    byRole: {
      code: { cost: 2, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
      auditor: { cost: 1, inputTokens: 50, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
    },
  }

  test('splits cost into execution and auditor roles by recorded role', () => {
    const bars = roleUsageBars(usage)
    expect(bars).toHaveLength(2)
    const exec = bars.find(b => b.role === 'execution')!
    const audit = bars.find(b => b.role === 'auditor')!
    expect(exec.cost).toBeCloseTo(2)
    expect(audit.cost).toBeCloseTo(1)
    expect(exec.messageCount).toBe(6)
    expect(audit.messageCount).toBe(2)
  })

  test('pct is relative to the larger role cost', () => {
    const bars = roleUsageBars(usage)
    const exec = bars.find(b => b.role === 'execution')!
    const audit = bars.find(b => b.role === 'auditor')!
    expect(exec.pct).toBeCloseTo(100)
    expect(audit.pct).toBeCloseTo(50)
  })

  test('unknown roles land in an other bar so the split reconciles with total cost', () => {
    const extra: NonNullable<DashboardLoop['usage']> = {
      ...usage,
      byRole: {
        ...usage.byRole,
        unknown: { cost: 0.5, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
      },
    }
    const bars = roleUsageBars(extra)
    const exec = bars.find(b => b.role === 'execution')!
    const audit = bars.find(b => b.role === 'auditor')!
    const other = bars.find(b => b.role === 'other')!
    expect(exec.cost).toBeCloseTo(2)
    expect(audit.cost).toBeCloseTo(1)
    expect(exec.messageCount).toBe(6)
    expect(audit.messageCount).toBe(2)
    expect(other.cost).toBeCloseTo(0.5)
    expect(other.messageCount).toBe(1)
    expect(bars).toHaveLength(3)
    expect(bars.reduce((sum, b) => sum + b.cost, 0)).toBeCloseTo(3.5)
  })

  test('an other bar is omitted when every role is known', () => {
    expect(roleUsageBars(usage).map(b => b.role)).toEqual(['execution', 'auditor'])
  })

  test('zero-cost usage yields zero-width bars', () => {
    const zero: NonNullable<DashboardLoop['usage']> = {
      ...usage,
      byRole: {
        code: { cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 0 },
        auditor: { cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 0 },
      },
    }
    const bars = roleUsageBars(zero)
    expect(bars.every(b => b.pct === 0)).toBe(true)
  })

  test('identical execution and auditor models keep their actual role costs', () => {
    const sameModel: NonNullable<DashboardLoop['usage']> = {
      loopName: 'same-model-loop',
      totalCost: 3,
      totalInputTokens: 150,
      totalOutputTokens: 30,
      totalReasoningTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalMessageCount: 8,
      byModel: {
        'shared-model': { cost: 3, inputTokens: 150, outputTokens: 30, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 8 },
      },
      byRole: {
        code: { cost: 2, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
        auditor: { cost: 1, inputTokens: 50, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
      },
    }
    const bars = roleUsageBars(sameModel)
    const exec = bars.find(b => b.role === 'execution')!
    const audit = bars.find(b => b.role === 'auditor')!
    expect(exec.cost).toBeCloseTo(2)
    expect(audit.cost).toBeCloseTo(1)
    expect(exec.messageCount).toBe(6)
    expect(audit.messageCount).toBe(2)
    expect(exec.pct).toBeCloseTo(100)
    expect(audit.pct).toBeCloseTo(50)
  })

  test('role bars sum input, output and reasoning tokens per role', () => {
    const withTokens: NonNullable<DashboardLoop['usage']> = {
      ...usage,
      byRole: {
        code: { cost: 2, inputTokens: 4000, outputTokens: 2000, reasoningTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 160, messageCount: 6 },
        auditor: { cost: 1, inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 40, messageCount: 2 },
      },
    }
    const bars = roleUsageBars(withTokens)
    const exec = bars.find(b => b.role === 'execution')!
    const audit = bars.find(b => b.role === 'auditor')!
    // tokens field sums input + output + reasoning only.
    expect(exec.tokens).toBe(4000 + 2000 + 400)
    expect(audit.tokens).toBe(1000 + 500 + 100)
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  const markedBackup = (globalThis as { marked?: unknown }).marked

  beforeEach(() => {
    // Restore between tests
    delete (globalThis as { marked?: unknown }).marked
  })

  afterAll(() => {
    ;(globalThis as { marked?: unknown }).marked = markedBackup
  })

  test('returns empty string when marked is not available', () => {
    expect(renderMarkdown('# Hello')).toBe('')
  })

  test('delegates to globalThis.marked.parse when available', () => {
    const parse = vi.fn((src: string) => '<p>' + src + '</p>')
    ;(globalThis as { marked?: { parse: typeof parse } }).marked = { parse }
    const result = renderMarkdown('# Hello')
    expect(parse).toHaveBeenCalledWith('# Hello')
    expect(result).toBe('<p># Hello</p>')
  })

  test('returns empty string for empty input when marked is available', () => {
    const parse = vi.fn((src: string) => '')
    ;(globalThis as { marked?: { parse: typeof parse } }).marked = { parse }
    expect(renderMarkdown('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// computePhaseSpans / summarizePhaseTotals
// ---------------------------------------------------------------------------

describe('computePhaseSpans', () => {
  function makeTransition(overrides: Partial<LoopTransitionRow> = {}): LoopTransitionRow {
    return {
      id: 1,
      projectId: 'p1',
      loopName: 'loop-a',
      eventType: 'phase',
      transitionKind: 'phase',
      fromPhase: 'coding',
      toPhase: 'auditing',
      status: null,
      reason: null,
      iteration: 1,
      sectionIndex: null,
      createdAt: 0,
      ...overrides,
    }
  }

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

  test('a single coding → auditing transition on a running loop yields a closed coding span and an open auditing span', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 500, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, now)
    expect(spans).toHaveLength(2)
    expect(spans[0].phase).toBe('coding')
    expect(spans[0].open).toBe(false)
    expect(spans[0].durationMs).toBe(500)
    expect(spans[0].endedAt).toBe(t1.createdAt)
    expect(spans[1].phase).toBe('auditing')
    expect(spans[1].open).toBe(true)
    expect(spans[1].durationMs).toBe(now - t1.createdAt)
    expect(truncated).toBe(false)
  })

  test('a terminal transition closes the prior span and emits no trailing span', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 500, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, startedAt + 9000)
    expect(spans).toHaveLength(1)
    expect(spans.every(s => !s.open)).toBe(true)
    expect(spans[0].phase).toBe('coding')
    expect(spans[0].endedAt).toBe(t1.createdAt)
    expect(truncated).toBe(false)
  })

  test('three transitions with a terminal last yield three spans summing to total elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate' })
    const { spans } = computePhaseSpans([t1, t2, t3], startedAt, null, startedAt + 9000)
    expect(spans).toHaveLength(3)
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBe(t3.createdAt - startedAt)
  })

  test('duplicate timestamps clamp to a zero-duration span with no negative value', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 2000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 5000)
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    expect(spans[1].durationMs).toBe(0)
  })

  test('out-of-order timestamps clamp to non-negative durations', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    // t2 has a createdAt earlier than t1 — would produce a negative raw duration.
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, startedAt + 7000)
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    expect(spans[1].durationMs).toBe(0)
  })

  test('truncated is true when the first transition landed more than one second after startedAt', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 5000 })
    const { truncated } = computePhaseSpans([t1], startedAt, null, startedAt + 10000)
    expect(truncated).toBe(true)
  })

  test('truncated is false when the first transition lands within one second of startedAt', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ createdAt: startedAt + 500 })
    const { truncated } = computePhaseSpans([t1], startedAt, null, startedAt + 10000)
    expect(truncated).toBe(false)
  })

  test('summarizePhaseTotals folds repeated visits to the same phase into one total', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'auditing', toPhase: 'coding' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'coding', toPhase: 'auditing' })
    const { spans } = computePhaseSpans([t1, t2, t3], startedAt, null, startedAt + 8000)
    const totals = summarizePhaseTotals(spans)
    // coding visited twice: span0 (1000ms) + span2 (4000ms) = 5000ms.
    expect(totals['coding']).toBe(5000)
    // auditing visited twice: span1 (1000ms) + trailing open span (2000ms) = 3000ms.
    expect(totals['auditing']).toBe(3000)
  })

  test('a truncated run marks the leading unknown span with an empty phase', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 8000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const now = startedAt + 12000
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, now)
    expect(truncated).toBe(true)
    expect(spans).toHaveLength(3)
    // The leading span covers unknown pre-window history; its phase is cleared
    // so consumers can drop it from bars and totals without misattribution.
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
    const now = startedAt + 12000
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, now)
    const totals = summarizePhaseTotals(spans)
    // coding only appears in the unknown leading span, so it must not be totalled.
    expect(totals['coding']).toBeUndefined()
    // Known spans: auditing (3000ms) + final_auditing open (4000ms).
    expect(totals['auditing']).toBe(3000)
    expect(totals['final_auditing']).toBe(4000)
    const known = spans.filter(s => s.phase !== '').reduce((acc, s) => acc + s.durationMs, 0)
    expect(known).toBe(now - t1.createdAt)
  })

  test('a terminal row followed by a restart continues processing and excludes inactive downtime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 500, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 15000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const completedAt = startedAt + 20000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, completedAt, completedAt + 1000)
    // Pre-restart coding (500ms) + restart fromPhase zero at t2 + auditing (5s) + trailing final_auditing (5s).
    expect(spans).toHaveLength(4)
    expect(spans.every(s => !s.open)).toBe(true)
    expect(spans.map(s => s.phase)).toEqual(['coding', 'coding', 'auditing', 'final_auditing'])
    expect(truncated).toBe(false)
    // Restart fromPhase span begins at t2.createdAt and closes immediately.
    expect(spans[1].startedAt).toBe(t2.createdAt)
    expect(spans[1].endedAt).toBe(t2.createdAt)
    expect(spans[1].durationMs).toBe(0)
    // Total represented duration excludes the ~9.5s inactive gap.
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBe(10500)
  })

  test('out-of-order timestamps keep effective boundaries monotonic and totals within the lifetime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const now = startedAt + 7000
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, now)
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    expect(spans.filter(s => !s.open).every(s => s.startedAt <= s.endedAt!)).toBe(true)
    // Out-of-order t2 must not move currentStart backwards: the auditing span
    // starts at t1.createdAt (the effective boundary) and is zero-duration.
    expect(spans[1].phase).toBe('auditing')
    expect(spans[1].startedAt).toBe(t1.createdAt)
    expect(spans[1].endedAt).toBe(t1.createdAt)
    // Total cannot exceed the represented elapsed lifetime.
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBeLessThanOrEqual(now - startedAt)
  })

  test('a terminal row followed by an out-of-order restart stays within the represented lifetime', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 7000
    const { spans } = computePhaseSpans([t1, t2], startedAt, null, now)
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    expect(spans.filter(s => !s.open).every(s => s.startedAt <= s.endedAt!)).toBe(true)
    // The resumed coding span must clamp against the terminal's effective
    // boundary (t1.createdAt) rather than jump back to t2.createdAt.
    expect(spans[1].phase).toBe('coding')
    expect(spans[1].startedAt).toBe(t1.createdAt)
    expect(spans[1].endedAt).toBe(t1.createdAt)
    expect(spans[1].durationMs).toBe(0)
    // Boundaries stay monotonic: every closed span ends no later than the next
    // span starts, and the trailing open span starts at the prior boundary.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].startedAt).toBeGreaterThanOrEqual(spans[i - 1].startedAt)
    }
    // Summed duration cannot exceed the represented active lifetime.
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBeLessThanOrEqual(now - startedAt)
    expect(total).toBe(now - startedAt)
  })

  test('a same-phase restarted running loop emits an open current-phase span from the new startedAt', () => {
    // Restart preserves the loop phase (final_auditing) and writes a new
    // startedAt; the prior terminal row from the dead lifecycle survives in
    // transition history with createdAt < startedAt. No restart row is
    // recorded because the phase did not change.
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1], startedAt, null, now, 'final_auditing')
    expect(truncated).toBe(false)
    expect(spans).toHaveLength(1)
    expect(spans[0].phase).toBe('final_auditing')
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].endedAt).toBeNull()
    expect(spans[0].durationMs).toBe(10000)
    expect(spans[0].open).toBe(true)
  })

  test('a same-phase restart with subsequent current-lifecycle transitions excludes inactive downtime', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 2000, fromPhase: 'final_auditing', toPhase: 'coding' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'coding', toPhase: 'final_auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, null, now, 'final_auditing')
    expect(truncated).toBe(false)
    expect(spans.map(s => s.phase)).toEqual(['final_auditing', 'coding', 'final_auditing'])
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    // The 5s pre-restart downtime is excluded; only current-lifecycle elapsed
    // time is represented.
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBe(10000)
    expect(spans[2].open).toBe(true)
    expect(spans[0].startedAt).toBe(startedAt)
  })

  test('a phase-changing restart records a current-lifecycle row that overrides the prior terminal', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'auditing', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const now = startedAt + 8000
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, now, 'coding')
    expect(truncated).toBe(false)
    // The restart row is a lifecycle-boundary marker, not a transition in the
    // new lifecycle: the loop was already persisted as 'coding' at the new
    // startedAt before the row landed. The current lifecycle begins at
    // startedAt in the destination phase with no old-phase span.
    expect(spans.map(s => s.phase)).toEqual(['coding'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].open).toBe(true)
    expect(spans[0].durationMs).toBe(8000)
  })

  test('a phase-changing restart row recorded after startedAt still begins the current lifecycle in the destination phase', () => {
    // Realistic timing: the loop row is restored (persisting the new phase and
    // a fresh startedAt) BEFORE the restart transition row is recorded, so the
    // row lands a few ms after startedAt. The current lifecycle must begin at
    // startedAt in 'coding'; no 'final_audit_fix' span may be emitted for the
    // post-startedAt window between startedAt and the restart row.
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, null, now, 'coding')
    expect(truncated).toBe(false)
    expect(spans.map(s => s.phase)).toEqual(['coding', 'auditing'])
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    // No span is attributed to the pre-restart phase after startedAt.
    expect(spans.some(s => s.phase === 'final_audit_fix')).toBe(false)
    // The coding span begins at startedAt (not at t2.createdAt) and runs to
    // the next transition; the trailing auditing span is open.
    expect(spans[0].phase).toBe('coding')
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].endedAt).toBe(t3.createdAt)
    expect(spans[0].durationMs).toBe(5000)
    expect(spans[1].phase).toBe('auditing')
    expect(spans[1].open).toBe(true)
    expect(spans[1].durationMs).toBe(now - t3.createdAt)
    // Totals reflect only the current lifecycle, with no old-phase duration.
    const totals = summarizePhaseTotals(spans)
    expect(totals['final_audit_fix']).toBeUndefined()
    expect(totals['coding']).toBe(5000)
    expect(totals['auditing']).toBe(now - t3.createdAt)
  })

  test('a normal transitioned loop derives the initial phase from the first transition, not the persisted latest phase', () => {
    // The loop row persists the latest phase (`final_auditing`), but the loop
    // actually started in `coding`. Using the persisted phase as the initial
    // phase mislabels the first span and drops coding time from totals.
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 4000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, now, 'final_auditing')
    expect(truncated).toBe(false)
    expect(spans.map(s => s.phase)).toEqual(['coding', 'auditing', 'final_auditing'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].endedAt).toBe(t1.createdAt)
    expect(spans[0].durationMs).toBe(1000)
    expect(spans[1].durationMs).toBe(t2.createdAt - t1.createdAt)
    expect(spans[2].open).toBe(true)
    expect(spans[2].durationMs).toBe(now - t2.createdAt)
    const totals = summarizePhaseTotals(spans)
    expect(totals['coding']).toBe(1000)
    expect(totals['auditing']).toBe(3000)
    expect(totals['final_auditing']).toBe(now - t2.createdAt)
  })

  test('a phase-changing restart derives the initial phase from the restart toPhase even when persisted phase advanced past it', () => {
    // The loop row persists the latest phase. After later transitions, the
    // persisted phase is `auditing` (post-restart); the restart marker still
    // records `final_audit_fix → coding`. The current lifecycle must begin in
    // `coding` (the restart destination), not `auditing` (the persisted value).
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2, t3], startedAt, null, now, 'auditing')
    expect(truncated).toBe(false)
    expect(spans.map(s => s.phase)).toEqual(['coding', 'auditing'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].durationMs).toBe(t3.createdAt - startedAt)
    expect(spans[1].open).toBe(true)
    expect(spans[1].durationMs).toBe(now - t3.createdAt)
  })

  test('a phase-changing restart with no later transitions opens the destination phase from startedAt regardless of persisted phase', () => {
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const now = startedAt + 10000
    const { spans, truncated } = computePhaseSpans([t1, t2], startedAt, null, now, 'auditing')
    expect(truncated).toBe(false)
    expect(spans.map(s => s.phase)).toEqual(['coding'])
    expect(spans[0].startedAt).toBe(startedAt)
    expect(spans[0].open).toBe(true)
    expect(spans[0].durationMs).toBe(now - startedAt)
  })

  test('a failed inactive restart after completion does not extend spans past the restored completedAt', () => {
    // Mirrors the inactive-loop prompt-failure rollback sequence in
    // test/services/execution-restart.test.ts: a stalled loop completed
    // hours ago, an inactive restart writes a `restart` phase row plus a
    // `restart_prompt_failed` rollback row, and the loop row is restored to
    // its original startedAt/completedAt. Spans must stay bounded to the
    // restored lifecycle and not attribute the inactive downtime or original
    // lifetime to the failed restart's coding phase.
    const startedAt = 1700000000000
    const completedAt = startedAt + 8000
    const restartAt = completedAt + 3_600_000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: completedAt, fromPhase: 'auditing', toPhase: null, transitionKind: 'terminate' })
    const t3 = makeTransition({ id: 3, createdAt: restartAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const t4 = makeTransition({ id: 4, createdAt: restartAt + 50, fromPhase: 'coding', toPhase: 'auditing', eventType: 'restart_prompt_failed', transitionKind: 'rollback' })
    const { spans, truncated } = computePhaseSpans([t1, t2, t3, t4], startedAt, completedAt, restartAt + 1000, 'auditing')
    expect(truncated).toBe(false)
    expect(spans.every(s => !s.open)).toBe(true)
    expect(spans.every(s => s.durationMs >= 0)).toBe(true)
    for (const s of spans) {
      expect(s.startedAt).toBeGreaterThanOrEqual(startedAt)
      expect(s.endedAt!).toBeLessThanOrEqual(completedAt)
    }
    expect(spans.map(s => s.phase)).toEqual(['coding', 'auditing'])
    const total = spans.reduce((acc, s) => acc + s.durationMs, 0)
    expect(total).toBe(completedAt - startedAt)
    expect(spans.some(s => s.phase === 'coding' && s.startedAt >= restartAt)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeTimelineEvents
// ---------------------------------------------------------------------------

describe('computeTimelineEvents', () => {
  function makeTransition(overrides: Partial<LoopTransitionRow> = {}): LoopTransitionRow {
    return {
      id: 1,
      projectId: 'p1',
      loopName: 'loop-a',
      eventType: 'phase',
      transitionKind: 'phase',
      fromPhase: 'coding',
      toPhase: 'auditing',
      status: null,
      reason: null,
      iteration: 1,
      sectionIndex: null,
      createdAt: 0,
      ...overrides,
    }
  }

  test('returns events newest first', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000 })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000 })
    const events = computeTimelineEvents([t1, t2], startedAt, false)
    expect(events.map(e => e.transition.id)).toEqual([2, 1])
  })

  test('a contiguous chain retains correct elapsed values per row', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'final_auditing', toPhase: null })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBe(t2.createdAt - t1.createdAt)
    expect(events[2].transition.id).toBe(1)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
  })

  test('the oldest row of a truncated window has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 13000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2], startedAt, true)
    // Newest first: t2, t1. t1 is the oldest row and its prior boundary is
    // omitted history, so its elapsed must be null rather than 10s.
    expect(events[1].transition.id).toBe(1)
    expect(events[1].elapsedMs).toBeNull()
    // t2 still has a known contiguous boundary at t1.
    expect(events[0].transition.id).toBe(2)
    expect(events[0].elapsedMs).toBe(t2.createdAt - t1.createdAt)
  })

  test('the oldest row being a restart marker has null elapsed regardless of startedAt proximity', () => {
    // A restart marker is a lifecycle boundary, not a real transition in the
    // current lifecycle: its predecessor phase predates the new startedAt, so
    // measuring elapsed from startedAt would attribute time to a phase that
    // had already ended. The boundary is unavailable.
    const startedAt = 1700000100000
    const restart = makeTransition({ id: 1, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const next = makeTransition({ id: 2, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([restart, next], startedAt, false)
    // Newest first: next, restart.
    expect(events[0].transition.id).toBe(2)
    expect(events[0].elapsedMs).toBe(next.createdAt - startedAt)
    expect(events[1].transition.id).toBe(1)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a row following a terminal transition has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 500, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 15000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    // t1 is the oldest row, not truncated, so its elapsed is t1 - startedAt.
    expect(events[2].transition.id).toBe(1)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
    // t2 follows a terminal row: the loop was inactive, elapsed unavailable.
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
    // t3 follows a normal contiguous boundary at t2.
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a preserved pre-restart oldest row predating startedAt has null elapsed, and the first same-phase transition uses startedAt', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 4000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    // Not truncated (only 3 rows fit well under the cap), but t1 predates
    // the restarted loop's startedAt; its boundary is unavailable.
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[2].transition.id).toBe(1)
    expect(events[2].elapsedMs).toBeNull()
    // t2 follows a terminal row predating startedAt, but the loop restarted
    // in the same phase (coding) at startedAt, so startedAt is the known
    // phase boundary for the current lifecycle.
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBe(t2.createdAt - startedAt)
    // t3 follows a contiguous boundary at t2.
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a same-phase restart followed by a transition uses startedAt, not the terminal createdAt', () => {
    // Loop terminates in final_auditing, restarts in that same phase (no
    // restart row emitted because the phase did not change), then transitions
    // ten minutes later. The transition's elapsed must be measured from the
    // current lifecycle's startedAt, not display as unavailable.
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 600000, fromPhase: 'final_auditing', toPhase: 'coding' })
    const events = computeTimelineEvents([t1, t2], startedAt, false)
    // Newest first: t2, t1.
    expect(events[0].transition.id).toBe(2)
    expect(events[0].elapsedMs).toBe(t2.createdAt - startedAt)
    expect(events[1].transition.id).toBe(1)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a transition following a post-startedAt terminal still has null elapsed', () => {
    // A terminal that lands within the current lifecycle (after startedAt)
    // is not a same-phase restart boundary; the next transition's prior
    // boundary is unavailable.
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 500, fromPhase: 'coding', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 10000, fromPhase: 'coding', toPhase: 'auditing' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 15000, fromPhase: 'auditing', toPhase: 'final_auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[2].transition.id).toBe(1)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a phase-changing restart row keeps its elapsed null rather than treating the terminal as the boundary', () => {
    // The restart row itself follows a pre-lifecycle terminal, but it is a
    // lifecycle-boundary marker, not a real transition; its elapsed must
    // remain unavailable.
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'auditing', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt, fromPhase: 'auditing', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
  })

  test('a transition following a phase-changing restart marker measures elapsed from startedAt, not the marker timestamp', () => {
    // Realistic timing: the loop row is restored (persisting the new phase and
    // a fresh startedAt) BEFORE the restart transition row is recorded, so the
    // marker lands a few ms after startedAt. The successor transition's
    // elapsed must be measured from startedAt, not the marker timestamp;
    // otherwise the window between startedAt and the marker is silently lost.
    const startedAt = 1700000100000
    const t1 = makeTransition({ id: 1, createdAt: startedAt - 5000, fromPhase: 'final_audit_fix', toPhase: null, transitionKind: 'terminate' })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - startedAt)
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
  })

  test('a historical restart marker predating startedAt measures its successor from the marker boundary, not startedAt', () => {
    // After multiple restarts, an older restart marker and its successor can
    // both predate the latest startedAt. Measuring the successor's elapsed
    // from startedAt would underflow and clamp to a fabricated 0s; the
    // contiguous marker boundary is the correct reference instead.
    const startedAt = 1700000100000
    const oldRestart = makeTransition({ id: 1, createdAt: startedAt - 100000, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const oldSuccessor = makeTransition({ id: 2, createdAt: startedAt - 50000, fromPhase: 'coding', toPhase: 'auditing' })
    const restart = makeTransition({ id: 3, createdAt: startedAt + 100, fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase' })
    const successor = makeTransition({ id: 4, createdAt: startedAt + 5000, fromPhase: 'coding', toPhase: 'auditing' })
    const events = computeTimelineEvents([oldRestart, oldSuccessor, restart, successor], startedAt, false)
    // Newest first: 4, 3, 2, 1.
    const byId = new Map(events.map(e => [e.transition.id, e.elapsedMs]))
    expect(byId.get(4)).toBe(successor.createdAt - startedAt)
    expect(byId.get(3)).toBeNull()
    expect(byId.get(2)).toBe(oldSuccessor.createdAt - oldRestart.createdAt)
    expect(byId.get(1)).toBeNull()
  })

  test('a row whose predecessor flowed into a different phase has null elapsed', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 1000, fromPhase: 'coding', toPhase: 'auditing' })
    // t2 claims a fromPhase that t1 did not flow into (missing row).
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 3000, fromPhase: 'final_auditing', toPhase: 'plan' })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 6000, fromPhase: 'plan', toPhase: null })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    // Newest first: t3, t2, t1.
    expect(events[0].transition.id).toBe(3)
    expect(events[0].elapsedMs).toBe(t3.createdAt - t2.createdAt)
    expect(events[1].transition.id).toBe(2)
    expect(events[1].elapsedMs).toBeNull()
    expect(events[2].transition.id).toBe(1)
    expect(events[2].elapsedMs).toBe(t1.createdAt - startedAt)
  })

  test('no event ever carries a negative elapsed value', () => {
    const startedAt = 1700000000000
    const t1 = makeTransition({ id: 1, createdAt: startedAt + 5000 })
    const t2 = makeTransition({ id: 2, createdAt: startedAt + 1000 })
    const t3 = makeTransition({ id: 3, createdAt: startedAt + 4000 })
    const events = computeTimelineEvents([t1, t2, t3], startedAt, false)
    for (const e of events) {
      expect(e.elapsedMs === null || e.elapsedMs >= 0).toBe(true)
    }
  })

  test('empty transitions yield an empty event list', () => {
    expect(computeTimelineEvents([], 1700000000000, false)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// capList
// ---------------------------------------------------------------------------

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
