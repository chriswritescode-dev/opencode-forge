// @vitest-environment happy-dom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'solid-js/web'
import { App } from '../../src/dashboard/app/app'

// ---------------------------------------------------------------------------
// Payload builders (minimal runtime shape; tests are not typechecked by tsc)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeLoop(over: Record<string, any> = {}): any {
  const loopOver = over.loop || {}
  delete over.loop
  return {
    loop: {
      projectId: 'p1',
      loopName: 'loop-a',
      status: 'running',
      currentSessionId: null,
      worktree: false,
      worktreeDir: '',
      worktreeBranch: null,
      projectDir: '/proj/p1',
      maxIterations: 10,
      iteration: 1,
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
      currentSectionIndex: 0,
      totalSections: 1,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
      ...loopOver,
    },
    lastAuditResult: null,
    plan: 'PLAN ONE',
    sections: [],
    findings: [],
    usage: null,
    duration: null,
    ...over,
  }
}

function makePayload(over: Record<string, any> = {}): any {
  const loopOver = over.loop || {}
  const dashLoopOver = over.dashLoop || {}
  const totalsOver = over.totals || {}
  const runs = over.runs ?? []
  return {
    generatedAt: Date.now(),
    projects: [
      {
        projectId: 'p1',
        projectDir: '/proj/p1',
        loops: [makeLoop({ ...dashLoopOver, loop: loopOver })],
        runs,
      },
    ],
    totals: {
      projects: 1,
      loops: 1,
      running: 1,
      completed: 0,
      cancelled: 0,
      errored: 0,
      stalled: 0,
      ...totalsOver,
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let payload: any
let intervalFn: (() => void | Promise<void>) | null
let dispose: (() => void) | null
let container: HTMLDivElement

beforeEach(() => {
  payload = makePayload()
  intervalFn = null
  dispose = null
  ;(globalThis as any).marked = { parse: (s: string) => `<p>${s}</p>` }
  vi.stubGlobal('setInterval', ((fn: () => void) => {
    intervalFn = fn
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  vi.stubGlobal('clearInterval', (() => {}) as typeof clearInterval)
  ;(globalThis as any).fetch = vi.fn(async () => ({ json: async () => payload }))
  window.location.hash = '#p1/loop-a'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  dispose?.()
  container.remove()
  window.location.hash = ''
  vi.unstubAllGlobals()
  delete (globalThis as any).marked
  delete (globalThis as any).fetch
})

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

async function poll(next: any): Promise<void> {
  payload = next
  await intervalFn?.()
  await flush()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard App loop list', () => {
  test('renders the project loop list as a table and opens a loop on row click', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const table = container.querySelector('table.loop-table')
    expect(table).toBeTruthy()
    const rows = container.querySelectorAll('tr.lt-row')
    expect(rows.length).toBe(1)

    const row = rows[0] as HTMLElement
    expect(row.textContent).toContain('loop-a')
    expect(row.querySelector('.status-badge')).toBeTruthy()

    ;(container.querySelector('tr.lt-row') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.loop-detail-header')).toBeTruthy()
  })
})

describe('dashboard App fine-grained reactivity', () => {
  test('renders the loop detail with markdown after initial load', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const scrollable = container.querySelector('.markdown-scrollable')
    expect(scrollable).toBeTruthy()
    expect(container.querySelector('.markdown-content')?.innerHTML).toContain('PLAN ONE')
  })

  test('markdown content updates in place when plan changes on a poll', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const scroll1 = container.querySelector('.markdown-scrollable') as HTMLElement
    expect(scroll1).toBeTruthy()
    scroll1.scrollTop = 123
    ;(scroll1 as any).__id = 'orig'

    await poll(makePayload({ dashLoop: { plan: 'PLAN TWO' } }))

    const scroll2 = container.querySelector('.markdown-scrollable') as HTMLElement
    // Same DOM node => scroll position / resize state preserved
    expect(scroll2).toBe(scroll1)
    expect((scroll2 as any).__id).toBe('orig')
    expect(scroll2.scrollTop).toBe(123)
    // ...and the content reflects the new plan
    expect(container.querySelector('.markdown-content')?.innerHTML).toContain('PLAN TWO')
  })

  test('status change keeps the markdown node (no full subtree rebuild) and updates the badge', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const scroll1 = container.querySelector('.markdown-scrollable') as HTMLElement
    scroll1.scrollTop = 77
    ;(scroll1 as any).__id = 'orig'
    expect(container.querySelector('.loop-detail-header .status-badge')?.textContent).toBe('running')

    await poll(
      makePayload({
        loop: { status: 'completed', completedAt: 1700000500000 },
        totals: { running: 0, completed: 1 },
      }),
    )

    const scroll2 = container.querySelector('.markdown-scrollable') as HTMLElement
    expect(scroll2).toBe(scroll1)
    expect((scroll2 as any).__id).toBe('orig')
    expect(scroll2.scrollTop).toBe(77)
    expect(container.querySelector('.loop-detail-header .status-badge')?.textContent).toBe('completed')
  })

  test('section drill-in: click a row to open details, back returns to list', async () => {
    payload = makePayload({
      dashLoop: {
        sections: [
          {
            projectId: 'p1',
            loopName: 'loop-a',
            sectionIndex: 0,
            title: 'Phase 1: Backend config',
            content: 'SECTION PLAN BODY',
            status: 'completed',
            attempts: 2,
            summaryDone: 'Did the backend config',
            summaryDeviations: null,
            summaryFollowUps: 'Follow up on tests',
            startedAt: 1700000000000,
            completedAt: 1700000500000,
            createdAt: 1700000000000,
          },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // List shown by default; .section-body absent
    const row = container.querySelector('.section-list-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.classList.contains('section-item-completed')).toBe(true)
    expect(container.querySelector('.section-body')).toBeFalsy()
    // attempts and duration surfaced
    expect(container.querySelector('.section-attempts')!.textContent).toContain('2 attempts')
    expect(container.querySelector('.section-duration')!.textContent).toBe('8m 20s')

    // Click row → drill-in with .section-body and .back-to-sections
    row.click()
    await flush()

    const body = container.querySelector('.section-body') as HTMLElement
    expect(body).toBeTruthy()
    expect(container.querySelector('.back-to-sections')).toBeTruthy()
    // Summary labels: only Done and Follow-ups (Deviations is null)
    const labels = Array.from(container.querySelectorAll('.section-summary-label')).map(l => l.textContent)
    expect(labels).toEqual(['Done', 'Follow-ups'])
    expect(container.querySelector('.markdown-scrollable .markdown-content')!.innerHTML).toContain('SECTION PLAN BODY')

    // Scroll position preserved across a data poll that mutates section title
    const scroll1 = container.querySelector('.markdown-scrollable') as HTMLElement
    expect(scroll1).toBeTruthy()
    scroll1.scrollTop = 42
    ;(scroll1 as any).__id = 'drill'

    await poll(makePayload({
      dashLoop: {
        sections: [
          {
            projectId: 'p1',
            loopName: 'loop-a',
            sectionIndex: 0,
            title: 'Phase 1: Backend config (edited)',
            content: 'SECTION PLAN BODY',
            status: 'completed',
            attempts: 2,
            summaryDone: 'Did the backend config',
            summaryDeviations: null,
            summaryFollowUps: 'Follow up on tests',
            startedAt: 1700000000000,
            completedAt: 1700000500000,
            createdAt: 1700000000000,
          },
        ],
      },
    }))

    const scroll2 = container.querySelector('.markdown-scrollable') as HTMLElement
    expect(scroll2).toBe(scroll1)
    expect((scroll2 as any).__id).toBe('drill')
    expect(scroll2.scrollTop).toBe(42)
    // Title reflects the edit
    expect(container.querySelector('.section-drill-title .section-title')!.textContent).toContain('(edited)')

    // Click back → list restored, .section-body absent
    ;(container.querySelector('.back-to-sections') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.section-list-row')).toBeTruthy()
    expect(container.querySelector('.section-body')).toBeFalsy()
  })

  test('renders usage graphs (stacked token bar + per-model cost bars)', async () => {
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 1.5,
          totalInputTokens: 50,
          totalOutputTokens: 30,
          totalReasoningTokens: 10,
          totalCacheReadTokens: 8,
          totalCacheWriteTokens: 2,
          totalMessageCount: 4,
          byModel: {
            'model-a': { cost: 1.0, inputTokens: 40, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 3 },
            'model-b': { cost: 0.5, inputTokens: 10, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Stacked token composition bar: one segment per non-zero token type (all 5 here)
    const segs = container.querySelectorAll('.usage-stack-seg')
    expect(segs.length).toBe(5)
    // Input is 50/100 → 50% width
    expect((segs[0] as HTMLElement).style.width).toBe('50%')

    // Legend shows all five types with compact values
    const legend = container.querySelector('.usage-legend')
    expect(legend).toBeTruthy()
    expect(legend!.textContent).toContain('Input')
    expect(legend!.textContent).toContain('Cache W')

    // Per-model bars sorted by cost desc; widest is the most expensive model
    const fills = container.querySelectorAll('.usage-model-fill')
    expect(fills.length).toBe(2)
    expect((fills[0] as HTMLElement).style.width).toBe('100%')
    expect((fills[1] as HTMLElement).style.width).toBe('50%')

    const names = Array.from(container.querySelectorAll('.usage-model-name')).map(n => n.textContent)
    expect(names).toEqual(['model-a', 'model-b'])
  })

  test('loop detail shows findings banner and usage stats at top', async () => {
    payload = makePayload({
      dashLoop: {
        findings: [
          { severity: 'bug', file: 'a.ts', line: 1, description: 'Null check missing', scenario: null },
          { severity: 'warning', file: 'b.ts', line: 5, description: 'Unused var', scenario: null },
        ],
        usage: {
          loopName: 'loop-a',
          totalCost: 0.42,
          totalInputTokens: 5000,
          totalOutputTokens: 3000,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 7,
          byModel: {
            'gpt-4': { cost: 0.3, inputTokens: 3000, outputTokens: 2000, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 4 },
            'gpt-3.5': { cost: 0.12, inputTokens: 2000, outputTokens: 1000, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 3 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Findings banner as first child of .loop-detail-header
    const banner = container.querySelector('.loop-detail-header .ldh-findings') as HTMLElement
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('1 bug')
    expect(banner.textContent).toContain('1 warning')
    expect(banner.classList.contains('ldh-findings-bug')).toBe(true)

    // Header stat grid keeps the scalar facts (Messages) but no longer
    // duplicates token/cost numbers now centralized in the usage graphs.
    const stats = container.querySelector('.loop-detail-header .ldh-stats')!
    expect(stats.textContent).toContain('Messages')
    expect(stats.textContent).not.toContain('Total Tokens')
    expect(stats.textContent).not.toContain('$')

    // Usage graphs (token composition + cost by model) live inside the header,
    // and are the single place token/cost figures are shown.
    const usage = container.querySelector('.loop-detail-header .usage-group')!
    expect(usage).toBeTruthy()
    expect(usage.querySelector('.usage-stack')).toBeTruthy()
    expect(usage.querySelector('.usage-legend')).toBeTruthy()
    expect(usage.querySelector('.usage-model-fill')).toBeTruthy()
    expect(usage.textContent).toContain('$')
    // No standalone Usage block remains outside the header.
    expect(container.querySelector('.loop-detail > .usage-group')).toBeFalsy()
  })

  test('findings banner shows No findings when no findings exist', async () => {
    payload = makePayload({ dashLoop: { findings: [] } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const banner = container.querySelector('.loop-detail-header .ldh-findings') as HTMLElement
    expect(banner).toBeTruthy()
    expect(banner.textContent).toBe('No findings')
    expect(banner.classList.contains('ldh-findings-clean')).toBe(true)
  })

  test('totals bar reflects updated counts after a poll', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 1')

    await poll(makePayload({ loop: { status: 'completed' }, totals: { running: 0, completed: 1 } }))

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 0')
    expect(container.querySelector('.totals')?.textContent).toContain('Completed: 1')
  })
})

// ---------------------------------------------------------------------------
// Loop metrics panel + #metrics runs view
// ---------------------------------------------------------------------------

function loopEvent(over: Record<string, any> = {}): any {
  return {
    projectId: 'p1',
    loopName: 'loop-a',
    runStartedAt: 1700000000000,
    eventType: 'coding_done',
    outcome: null,
    verdict: null,
    iteration: 1,
    sectionIndex: null,
    sessionId: null,
    role: 'code',
    model: null,
    cost: 0.1,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 1,
    findingsTotal: null,
    findingsBugs: null,
    detail: null,
    createdAt: 1700000000000,
    ...over,
  }
}

describe('dashboard App loop metrics panel', () => {
  test('loop detail with events renders the metrics panel charts with correct bar counts', async () => {
    payload = makePayload({
      loop: { totalSections: 1 },
      dashLoop: {
        events: [
          loopEvent({ eventType: 'coding_done', iteration: 1, inputTokens: 100, outputTokens: 50, cost: 0.1 }),
          loopEvent({ eventType: 'coding_done', iteration: 2, inputTokens: 200, outputTokens: 80, cost: 0.2 }),
          loopEvent({ eventType: 'audit_done', iteration: 1, verdict: 'clean', inputTokens: 30, outputTokens: 10, cost: 0.05 }),
          loopEvent({ eventType: 'audit_done', iteration: 2, verdict: 'dirty', inputTokens: 40, outputTokens: 12, cost: 0.07 }),
          loopEvent({ eventType: 'final_audit_done', iteration: 2, verdict: 'clean', inputTokens: 5, outputTokens: 3, cost: 0.01 }),
          loopEvent({ eventType: 'coding_done', iteration: 3, inputTokens: 220, outputTokens: 90, cost: 0.25 }),
          loopEvent({ eventType: 'audit_done', iteration: 3, verdict: 'clean', inputTokens: 35, outputTokens: 11, cost: 0.06 }),
          loopEvent({ eventType: 'loop_terminated', iteration: null, outcome: 'completed', inputTokens: 0, outputTokens: 0, cost: 0 }),
        ],
        sections: [
          {
            projectId: 'p1',
            loopName: 'loop-a',
            sectionIndex: 0,
            title: 'Phase 1',
            content: '',
            status: 'completed',
            attempts: 1,
            startedAt: 1700000000000,
            completedAt: 1700000500000,
          },
        ],
      },
    })
    window.location.hash = '#p1/loop-a'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const panel = container.querySelector('.loop-metrics-panel') as HTMLElement
    expect(panel).toBeTruthy()

    // Three StackedBarCharts: tokens, cost, section retries. Audit is a DotStrip.
    const charts = container.querySelectorAll('.forge-chart')
    expect(charts.length).toBe(3)

    // Tokens chart: 3 iterations x 4 segments = 12 rects, 3 bar groups
    const tokensSvg = charts[0].querySelector('svg.forge-chart-svg') as SVGElement
    expect(tokensSvg).toBeTruthy()
    expect(tokensSvg.querySelectorAll('g').length).toBe(3)
    expect(tokensSvg.querySelectorAll('rect').length).toBe(12)

    // Cost chart: 3 iterations x 1 segment = 3 rects
    const costSvg = charts[1].querySelector('svg.forge-chart-svg') as SVGElement
    expect(costSvg.querySelectorAll('rect').length).toBe(3)

    // Audit outcomes dot strip: 4 audit/final_audit events (3 clean, 1 dirty)
    const dots = container.querySelectorAll('.forge-dot-strip .forge-dot')
    expect(dots.length).toBe(4)
    expect(container.querySelectorAll('.forge-dot-strip .forge-dot-clean').length).toBe(3)
    expect(container.querySelectorAll('.forge-dot-strip .forge-dot-dirty').length).toBe(1)

    // Section retries chart: 1 section, 0 retries → 1 bar with zero height
    const retrySvg = charts[2].querySelector('svg.forge-chart-svg') as SVGElement
    expect(retrySvg.querySelectorAll('g').length).toBe(1)
  })

  test('empty events renders the metrics empty-state note', async () => {
    payload = makePayload({ dashLoop: { events: [] } })
    window.location.hash = '#p1/loop-a'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const panel = container.querySelector('.loop-metrics-panel') as HTMLElement
    expect(panel).toBeTruthy()
    expect(panel.querySelector('.metrics-empty')).toBeTruthy()
    expect(container.querySelector('.forge-chart')).toBeFalsy()
    expect(container.querySelector('.forge-dot-strip')).toBeFalsy()
  })

  test('#metrics route renders the runs table with one row per run', async () => {
    payload = makePayload({
      totals: { running: 0, completed: 1 },
      loop: { status: 'completed', completedAt: 1700000500000 },
      runs: [
        {
          projectId: 'p1',
          loopName: 'loop-a',
          startedAt: 1700000000000,
          completedAt: 1700000500000,
          status: 'completed',
          terminationReason: null,
          loopKind: 'plan',
          executionModel: 'claude-3',
          auditorModel: 'gpt-4',
          executionVariant: null,
          auditorVariant: null,
          iterations: 3,
          auditCount: 2,
          errorCount: 0,
          totalSections: 1,
          sectionRetries: 0,
          cleanAudits: 2,
          dirtyAudits: 0,
          cost: 0.42,
          inputTokens: 1000,
          outputTokens: 600,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          messageCount: 8,
          durationMs: 500000,
          createdAt: 1700000000000,
        },
      ],
    })
    window.location.hash = '#metrics'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.runs-view')).toBeTruthy()
    const rows = container.querySelectorAll('tr.runs-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('loop-a')
    // Cost-per-run chart above the table
    const costChart = container.querySelector('.runs-view .forge-chart svg.forge-chart-svg')
    expect(costChart).toBeTruthy()
  })

  describe('dashboard App metrics navigation regression', () => {
    test('Metrics → Metrics → Back: re-clicking Metrics at #metrics does not suppress the next Back hashchange', async () => {
      // Regression: the previous navigateMetrics() always set the hashchange
      // suppression flag and assigned location.hash = 'metrics', even when the
      // hash was already 'metrics'. Because no hashchange event fires when the
      // hash does not actually change, the flag stayed set, so the next Back
      // navigation was discarded — leaving the metrics view mounted with an empty
      // hash. syncHash only arms the suppression flag when the hash changes.
      payload = makePayload({
        totals: { running: 1, completed: 0 },
        dashLoop: { events: [] },
      })
      window.location.hash = '#metrics'
      dispose = render(() => App() as unknown as Element, container)
      await flush()

      // Mounted on the metrics route.
      const navLink = container.querySelector('.metrics-nav-link') as HTMLElement
      expect(navLink).toBeTruthy()
      expect(container.querySelector('.runs-view')).toBeTruthy()

      // Re-click Metrics while already at #metrics: hash is unchanged so the
      // browser fires no hashchange event. navigateMetrics must NOT arm the
      // suppression flag (the bug left it set).
      navLink.click()
      await flush()
      expect(container.querySelector('.runs-view')).toBeTruthy()

      // Simulate Back: hash becomes empty and the browser fires a hashchange.
      window.location.hash = ''
      window.dispatchEvent(new Event('hashchange'))
      await flush()

      // The metrics view is unmounted; the standard dashboard layout is shown.
      expect(container.querySelector('.runs-view')).toBeFalsy()
      expect(container.querySelector('.dash-layout')).toBeTruthy()
    })
  })
})
