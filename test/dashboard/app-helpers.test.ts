import { describe, test, expect, beforeEach } from 'vitest'
import {
  parseLoopHash,
  buildLoopHash,
  fmtTime,
  statusClass,
  sectionStatusClass,
  loopMatchesFilters,
  dataHash,
  deriveSidebarLabel,
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
  renderMarkdown,
  iterationUsagePoints,
  sectionRetryCounts,
  auditOutcomePoints,
  runComparisonRows,
  chartMax,
} from '../../src/dashboard/app/helpers'
import type { DashboardPayload, DashboardProject, DashboardLoop } from '../../src/dashboard/app/types'
import type { ReviewFindingRow, LoopEventRow, LoopRunRow, SectionPlanRow } from '../../src/storage'

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
    sections: [],
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
// parseLoopHash / buildLoopHash
// ---------------------------------------------------------------------------

describe('parseLoopHash / buildLoopHash', () => {
  test('round-trip with project and loop name', () => {
    const hash = buildLoopHash('/Users/x/proj', 'my-loop')
    expect(hash).toBe('#' + encodeURIComponent('/Users/x/proj') + '/' + encodeURIComponent('my-loop'))
    expect(parseLoopHash(hash)).toEqual({ projectId: '/Users/x/proj', loopName: 'my-loop' })
  })

  test('round-trip with URL-encoded special characters', () => {
    const hash = buildLoopHash('my project', 'loop name')
    expect(parseLoopHash(hash)).toEqual({ projectId: 'my project', loopName: 'loop name' })
  })

  test('empty hash returns null projectId and loopName', () => {
    expect(parseLoopHash('')).toEqual({ projectId: null, loopName: null })
  })

  test('hash with only hash prefix returns null', () => {
    expect(parseLoopHash('#')).toEqual({ projectId: null, loopName: null })
  })

  test('project-only hash (no slash)', () => {
    expect(parseLoopHash('#proj-only')).toEqual({ projectId: 'proj-only', loopName: null })
  })

  test('project with trailing slash but no loop name', () => {
    expect(parseLoopHash('#proj/')).toEqual({ projectId: 'proj', loopName: null })
  })

  test('buildLoopHash with null projectId returns empty string', () => {
    expect(buildLoopHash(null, null)).toBe('')
    expect(buildLoopHash(null, 'loop')).toBe('')
  })

  test('buildLoopHash with empty-string projectId returns empty string', () => {
    expect(buildLoopHash('', 'loop')).toBe('')
  })

  test('buildLoopHash with projectId but no loopName omits trailing slash', () => {
    const hash = buildLoopHash('proj-id', null)
    expect(hash).toBe('#proj-id')
    expect(parseLoopHash(hash)).toEqual({ projectId: 'proj-id', loopName: null })
  })
})

// ---------------------------------------------------------------------------
// deriveSidebarLabel
// ---------------------------------------------------------------------------

describe('deriveSidebarLabel', () => {
  test('returns last segment of a path', () => {
    expect(deriveSidebarLabel('/Users/chris/development/opencode-forge')).toBe('opencode-forge')
  })

  test('returns the input when it has no slashes', () => {
    expect(deriveSidebarLabel('simple-id')).toBe('simple-id')
  })

  test('returns empty string for empty input', () => {
    expect(deriveSidebarLabel('')).toBe('')
  })

  test('handles trailing slash', () => {
    expect(deriveSidebarLabel('/foo/bar/')).toBe('bar')
  })

  test('handles root path — falls back to rawPath when no segments', () => {
    // Original render.ts: rawSegments.length ? last : rawPath
    expect(deriveSidebarLabel('/')).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// loopMatchesFilters
// ---------------------------------------------------------------------------

describe('loopMatchesFilters', () => {
  const loop = mockLoopRow({ status: 'completed', loopName: 'feature-x' })
  const project = mockProject({ projectDir: '/projects/my-app', projectId: 'p1' })

  test('empty activeStatuses matches all loops', () => {
    expect(loopMatchesFilters(loop, project, new Set(), '')).toBe(true)
  })

  test('status membership filter — matching status', () => {
    expect(loopMatchesFilters(loop, project, new Set(['completed']), '')).toBe(true)
  })

  test('status membership filter — non-matching status', () => {
    expect(loopMatchesFilters(loop, project, new Set(['running']), '')).toBe(false)
  })

  test('case-insensitive search matches loopName', () => {
    // searchText must be pre-lowercased (matching original closure behavior)
    expect(loopMatchesFilters(loop, project, new Set(), 'feature')).toBe(true)
  })

  test('case-insensitive search matches projectDir', () => {
    expect(loopMatchesFilters(loop, project, new Set(), 'my-app')).toBe(true)
  })

  test('case-insensitive search matches projectId', () => {
    const projNoDir = mockProject({ projectDir: null, projectId: 'fallback-id' })
    expect(loopMatchesFilters(loop, projNoDir, new Set(), 'fallback')).toBe(true)
  })

  test('non-matching search returns false', () => {
    expect(loopMatchesFilters(loop, project, new Set(), 'nonexistent')).toBe(false)
  })

  test('search AND status filter combine correctly', () => {
    expect(loopMatchesFilters(loop, project, new Set(['running']), 'feature')).toBe(false)
    expect(loopMatchesFilters(loop, project, new Set(['completed']), 'feature')).toBe(true)
  })

  test('loop with null projectDir falls back to projectId for search', () => {
    const projNoDir = mockProject({ projectDir: null, projectId: 'my-project' })
    expect(loopMatchesFilters(loop, projNoDir, new Set(), 'my-project')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// dataHash
// ---------------------------------------------------------------------------

describe('dataHash', () => {
  const emptyPayload: DashboardPayload = {
    generatedAt: 100,
    projects: [],
    totals: { projects: 0, loops: 0, running: 0, completed: 0, cancelled: 0, errored: 0, stalled: 0 },
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
// Loop metric chart helpers
// ---------------------------------------------------------------------------

function makeEventRow(overrides: Partial<LoopEventRow> = {}): LoopEventRow {
  return {
    projectId: 'p1',
    loopName: 'l1',
    runStartedAt: 1000,
    eventType: 'coding_done',
    outcome: 'section_done',
    verdict: null,
    iteration: 1,
    sectionIndex: 0,
    sessionId: 's1',
    role: 'code',
    model: 'claude',
    cost: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 5,
    findingsTotal: null,
    findingsBugs: null,
    detail: null,
    createdAt: 1001,
    ...overrides,
  }
}

function makeSectionRow(overrides: Partial<SectionPlanRow> = {}): SectionPlanRow {
  return {
    projectId: 'p1',
    loopName: 'l1',
    sectionIndex: 0,
    title: 'Section 0',
    content: '',
    status: 'pending',
    attempts: 0,
    summaryDone: null,
    summaryDeviations: null,
    summaryFollowUps: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1000,
    ...overrides,
  }
}

function makeRunRow(overrides: Partial<LoopRunRow> = {}): LoopRunRow {
  return {
    projectId: 'p1',
    loopName: 'l1',
    startedAt: 1000,
    completedAt: 2000,
    status: 'completed',
    terminationReason: null,
    loopKind: 'plan',
    executionModel: 'claude',
    auditorModel: null,
    executionVariant: null,
    auditorVariant: null,
    iterations: 5,
    auditCount: 2,
    errorCount: 0,
    totalSections: 1,
    sectionRetries: 0,
    cleanAudits: 2,
    dirtyAudits: 0,
    cost: 0.5,
    inputTokens: 300,
    outputTokens: 120,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 13,
    durationMs: 1000,
    createdAt: 1000,
    ...overrides,
  }
}

describe('iterationUsagePoints', () => {
  test('aggregates code and audit buckets per iteration, sorted ascending', () => {
    const events: LoopEventRow[] = [
      makeEventRow({ iteration: 2, eventType: 'coding_done', inputTokens: 100, outputTokens: 40, cost: 0.1 }),
      makeEventRow({ iteration: 1, eventType: 'coding_done', inputTokens: 50, outputTokens: 20, cost: 0.05 }),
      makeEventRow({ iteration: 1, eventType: 'audit_done', inputTokens: 30, outputTokens: 10, cost: 0.02 }),
      makeEventRow({ iteration: 2, eventType: 'final_audit_done', inputTokens: 60, outputTokens: 25, cost: 0.03 }),
    ]
    const points = iterationUsagePoints(events)
    expect(points.map(p => p.iteration)).toEqual([1, 2])
    const p1 = points[0]
    expect(p1).toEqual({ iteration: 1, codeInput: 50, codeOutput: 20, auditInput: 30, auditOutput: 10, cost: 0.07 })
    const p2 = points[1]
    expect(p2).toEqual({ iteration: 2, codeInput: 100, codeOutput: 40, auditInput: 60, auditOutput: 25, cost: 0.13 })
  })

  test('skips events with null iteration or loop_terminated type', () => {
    const events: LoopEventRow[] = [
      makeEventRow({ iteration: null, eventType: 'coding_done' }),
      makeEventRow({ iteration: 1, eventType: 'loop_terminated', outcome: 'max_iterations' }),
      makeEventRow({ iteration: 1, eventType: 'coding_done', inputTokens: 10, outputTokens: 5, cost: 0.01 }),
    ]
    const points = iterationUsagePoints(events)
    expect(points).toHaveLength(1)
    expect(points[0].iteration).toBe(1)
    expect(points[0].codeInput).toBe(10)
  })

  test('empty input returns empty array', () => {
    expect(iterationUsagePoints([])).toEqual([])
  })
})

describe('sectionRetryCounts', () => {
  test('counts section_retry outcomes per section with titles, including zero-retry sections', () => {
    const events: LoopEventRow[] = [
      makeEventRow({ eventType: 'audit_done', outcome: 'section_retry', sectionIndex: 1 }),
      makeEventRow({ eventType: 'audit_done', outcome: 'section_retry', sectionIndex: 1 }),
      makeEventRow({ eventType: 'audit_done', outcome: 'clean', sectionIndex: 0 }),
    ]
    const sections: SectionPlanRow[] = [
      makeSectionRow({ sectionIndex: 0, title: 'Setup' }),
      makeSectionRow({ sectionIndex: 1, title: 'Implementation' }),
    ]
    const counts = sectionRetryCounts(events, sections)
    expect(counts).toEqual([
      { sectionIndex: 0, title: 'Setup', retries: 0 },
      { sectionIndex: 1, title: 'Implementation', retries: 2 },
    ])
  })

  test('returns zero-retry rows for all sections when no retry events', () => {
    const sections: SectionPlanRow[] = [
      makeSectionRow({ sectionIndex: 0, title: 'A' }),
      makeSectionRow({ sectionIndex: 1, title: 'B' }),
    ]
    const counts = sectionRetryCounts([], sections)
    expect(counts).toEqual([
      { sectionIndex: 0, title: 'A', retries: 0 },
      { sectionIndex: 1, title: 'B', retries: 0 },
    ])
  })

  test('preserves empty-string titles', () => {
    const sections: SectionPlanRow[] = [makeSectionRow({ sectionIndex: 0, title: '' })]
    const counts = sectionRetryCounts([], sections)
    expect(counts[0].title).toBe('')
    expect(counts[0].retries).toBe(0)
  })
})

describe('auditOutcomePoints', () => {
  test('returns audit_done and final_audit_done rows preserving order and verdicts', () => {
    const events: LoopEventRow[] = [
      makeEventRow({ id: 1, eventType: 'coding_done', iteration: 1, outcome: 'section_done', verdict: null }),
      makeEventRow({ id: 2, eventType: 'audit_done', iteration: 1, outcome: 'dirty', verdict: 'dirty' }),
      makeEventRow({ id: 3, eventType: 'final_audit_done', iteration: null, outcome: 'clean', verdict: 'clean' }),
      makeEventRow({ id: 4, eventType: 'loop_terminated', iteration: null, outcome: 'max_iterations', verdict: null }),
    ]
    const points = auditOutcomePoints(events)
    expect(points).toEqual([
      { iteration: 1, verdict: 'dirty', outcome: 'dirty' },
      { iteration: null, verdict: 'clean', outcome: 'clean' },
    ])
  })

  test('skips non-audit event types', () => {
    const events: LoopEventRow[] = [
      makeEventRow({ eventType: 'coding_done' }),
      makeEventRow({ eventType: 'post_action_done' }),
      makeEventRow({ eventType: 'loop_terminated' }),
    ]
    expect(auditOutcomePoints(events)).toEqual([])
  })

  test('empty input returns empty array', () => {
    expect(auditOutcomePoints([])).toEqual([])
  })
})

describe('runComparisonRows', () => {
  test('derives tokensTotal and costPerIteration and sorts by startedAt desc', () => {
    const runs: LoopRunRow[] = [
      makeRunRow({ startedAt: 1000, iterations: 5, cost: 0.5, inputTokens: 300, outputTokens: 120 }),
      makeRunRow({ startedAt: 3000, iterations: 0, cost: 0.2, inputTokens: 10, outputTokens: 5 }),
      makeRunRow({ startedAt: 2000, iterations: 4, cost: 0.4, inputTokens: 200, outputTokens: 80 }),
    ]
    const rows = runComparisonRows(runs)
    expect(rows.map(r => r.startedAt)).toEqual([3000, 2000, 1000])
    expect(rows[0]).toMatchObject({ tokensTotal: 15, costPerIteration: 0.2 })
    expect(rows[1]).toMatchObject({ tokensTotal: 280, costPerIteration: 0.1 })
    expect(rows[2]).toMatchObject({ tokensTotal: 420, costPerIteration: 0.1 })
  })

  test('costPerIteration equals total cost when iterations is 0', () => {
    const runs: LoopRunRow[] = [makeRunRow({ iterations: 0, cost: 0.42 })]
    expect(runComparisonRows(runs)[0].costPerIteration).toBe(0.42)
  })

  test('preserves all original LoopRunRow fields', () => {
    const runs: LoopRunRow[] = [makeRunRow({ loopName: 'custom', iterations: 2 })]
    const row = runComparisonRows(runs)[0]
    expect(row.loopName).toBe('custom')
    expect(row.iterations).toBe(2)
    expect(row.projectId).toBe('p1')
  })

  test('empty input returns empty array', () => {
    expect(runComparisonRows([])).toEqual([])
  })
})

describe('chartMax', () => {
  test('returns the max of supplied values', () => {
    expect(chartMax([3, 7, 2, 9, 1])).toBe(9)
  })

  test('floors at 1 when all values are smaller', () => {
    expect(chartMax([0, 0, 0])).toBe(1)
    expect(chartMax([0.5])).toBe(1)
  })

  test('empty input returns 1', () => {
    expect(chartMax([])).toBe(1)
  })

  test('handles negative values by flooring at 1', () => {
    expect(chartMax([-5, -10])).toBe(1)
  })
})
