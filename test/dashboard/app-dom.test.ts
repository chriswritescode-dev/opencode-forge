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
  // `id` mirrors `loop.loopName` so the store's keyed reconcile (key='id')
  // preserves the proxy for each loop across polls. Defaults to the default
  // loopName unless overridden.
  const loopName = loopOver.loopName ?? 'loop-a'
  return {
    id: loopName,
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
  // `loops` lets tests supply an explicit array (multi-loop scenarios);
  // otherwise the single-loop default applies. The project carries `id`
  // for keyed reconcile.
  const loops = over.loops
  delete over.loops
  return {
    generatedAt: Date.now(),
    projects: [
      {
        id: 'p1',
        projectId: 'p1',
        projectDir: '/proj/p1',
        loops: loops ?? [makeLoop({ ...dashLoopOver, loop: loopOver })],
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

describe('dashboard App machine graph', () => {
  function phaseNodeByText(phase: string): HTMLElement | null {
    const nodes = container.querySelectorAll('g.mg-node')
    for (const n of nodes) {
      const label = n.querySelector('.mg-node-label')
      if (label?.textContent === phase) return n as HTMLElement
    }
    return null
  }

  test('renders an SVG with five phase nodes and highlights the current phase', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const svg = container.querySelector('svg.mg-svg')
    expect(svg).toBeTruthy()

    // Five phase nodes (terminal is omitted while running).
    const phaseNodes = container.querySelectorAll('g.mg-node')
    expect(phaseNodes.length).toBe(5)
    expect(container.querySelector('g.mg-terminal')).toBeFalsy()

    // Fixture has phase=coding and status=running → coding node is active.
    const coding = phaseNodeByText('coding')
    expect(coding).toBeTruthy()
    expect(coding!.classList.contains('mg-node-active')).toBe(true)
    const auditing = phaseNodeByText('auditing')
    expect(auditing).toBeTruthy()
    expect(auditing!.classList.contains('mg-node-active')).toBe(false)
  })

  test('poll reconciliation preserves the SVG root and moves the active class', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const svg1 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg1).toBeTruthy()
    ;(svg1 as any).__id = 'orig'
    expect(phaseNodeByText('coding')!.classList.contains('mg-node-active')).toBe(true)
    expect(phaseNodeByText('auditing')!.classList.contains('mg-node-active')).toBe(false)

    // Simulate a poll: phase rotates coding → auditing, still running.
    await poll(
      makePayload({
        loop: { phase: 'auditing', status: 'running' },
      }),
    )

    // Same SVG root node → subtree preserved, only class bindings updated.
    const svg2 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg2).toBe(svg1)
    expect((svg2 as any).__id).toBe('orig')
    // Active class moved.
    expect(phaseNodeByText('coding')!.classList.contains('mg-node-active')).toBe(false)
    expect(phaseNodeByText('auditing')!.classList.contains('mg-node-active')).toBe(true)
    // Still five phase nodes (status still running → no terminal).
    expect(container.querySelectorAll('g.mg-node').length).toBe(5)
    expect(container.querySelector('g.mg-terminal')).toBeFalsy()
  })

  test('renders a transition history row for each fixture transition', async () => {
    payload = makePayload({
      dashLoop: {
        transitions: [
          {
            id: 1,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'audit-trigger',
            transitionKind: 'phase',
            fromPhase: 'coding',
            toPhase: 'auditing',
            status: null,
            reason: null,
            iteration: 1,
            sectionIndex: null,
            createdAt: 1700000010000,
          },
          {
            id: 2,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'audit-clear',
            transitionKind: 'phase',
            fromPhase: 'auditing',
            toPhase: 'final_auditing',
            status: null,
            reason: null,
            iteration: 1,
            sectionIndex: null,
            createdAt: 1700000020000,
          },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = container.querySelectorAll('.mg-history-row')
    expect(rows.length).toBe(2)
    // Reversed (latest first): row[0] should carry the audit-clear event.
    expect(rows[0].textContent).toContain('audit-clear')
    expect(rows[0].textContent).toContain('auditing → final_auditing')
    expect(rows[1].textContent).toContain('audit-trigger')
    expect(rows[1].textContent).toContain('coding → auditing')
  })

  test('history latest 20 includes transitions beyond the 100-row cap boundary', async () => {
    // Simulate a payload that already contains 105 persisted transitions
    // (the data layer would have fetched only the newest 100, ending at id 105,
    // but here we feed the full set directly to exercise the graph component's
    // slice(-20).reverse() windowing). The latest-20 history must include
    // transitions beyond row 100 (ids 86-105) and omit rows <= 85.
    const transitions: any[] = []
    for (let i = 1; i <= 105; i++) {
      transitions.push({
        id: i,
        projectId: 'p1',
        loopName: 'loop-a',
        eventType: `evt-${i}`,
        transitionKind: 'phase',
        fromPhase: 'coding',
        toPhase: 'auditing',
        status: null,
        reason: null,
        iteration: i,
        sectionIndex: null,
        createdAt: 1700000000000 + i * 1000,
      })
    }
    payload = makePayload({ dashLoop: { transitions } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = container.querySelectorAll('.mg-history-row')
    expect(rows.length).toBe(20)
    // Latest-first: row[0] is the newest (id 105), row[19] is id 86.
    expect(rows[0].textContent).toContain('evt-105')
    expect(rows[19].textContent).toContain('evt-86')
    // Transitions beyond the cap boundary (id > 100) appear in the window.
    expect(rows[0].textContent).toContain('evt-105')
    expect(rows[1].textContent).toContain('evt-104')
    expect(rows[4].textContent).toContain('evt-101')
    // The oldest overflow row (id 85) is NOT in the latest-20 window.
    for (const row of rows) {
      expect(row.textContent).not.toContain('evt-85')
    }
  })

  test('post-action and terminal transitions render history rows and matching SVG edge counts', async () => {
    payload = makePayload({
      dashLoop: {
        transitions: [
          {
            id: 1,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'audit-clear',
            transitionKind: 'phase',
            fromPhase: 'auditing',
            toPhase: 'post_action',
            status: null,
            reason: null,
            iteration: 4,
            sectionIndex: null,
            createdAt: 1700000010000,
          },
          {
            id: 2,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'completed',
            transitionKind: 'terminate',
            fromPhase: 'post_action',
            toPhase: null,
            status: 'completed',
            reason: null,
            iteration: 4,
            sectionIndex: null,
            createdAt: 1700000020000,
          },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // History shows both persisted transitions; the terminal row keeps its
    // resulting status as the visual flow target.
    const rows = container.querySelectorAll('.mg-history-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('completed')
    expect(rows[0].textContent).toContain('post_action → completed')
    expect(rows[1].textContent).toContain('audit-clear')
    expect(rows[1].textContent).toContain('auditing → post_action')

    // The auditing→post_action phase edge renders its traversal count.
    const auditEdgeLabel = container.querySelector(
      '[data-edge-key="auditing→post_action"] .mg-edge-label',
    )
    expect(auditEdgeLabel).toBeTruthy()
    expect(auditEdgeLabel!.textContent).toBe('1')

    // The terminal row is normalized onto the shared post_action→terminal
    // visual edge, so that edge's count is 1 (not a post_action→completed
    // edge, which does not exist).
    const terminalEdgeLabel = container.querySelector(
      '[data-edge-key="post_action→terminal"] .mg-edge-label',
    )
    expect(terminalEdgeLabel).toBeTruthy()
    expect(terminalEdgeLabel!.textContent).toBe('1')

    // Sanity: a synthetic post_action→completed edge key is never rendered.
    expect(container.querySelector('[data-edge-key="post_action→completed"]')).toBeNull()
  })

  test('recovery edges final_audit_fix↔coding render matching SVG edge counts for persisted rows', async () => {
    payload = makePayload({
      dashLoop: {
        transitions: [
          {
            id: 1,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'final-audit-fix-prompt-error',
            transitionKind: 'error-recovery',
            fromPhase: 'final_audit_fix',
            toPhase: 'coding',
            status: null,
            reason: null,
            iteration: 3,
            sectionIndex: null,
            createdAt: 1700000010000,
          },
          {
            id: 2,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'set-phase',
            transitionKind: 'phase',
            fromPhase: 'coding',
            toPhase: 'final_audit_fix',
            status: null,
            reason: null,
            iteration: 4,
            sectionIndex: null,
            createdAt: 1700000020000,
          },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Both edges exist and carry the persisted transition's count.
    const fafToCoding = container.querySelector(
      '[data-edge-key="final_audit_fix→coding"] .mg-edge-label',
    )
    expect(fafToCoding).toBeTruthy()
    expect(fafToCoding!.textContent).toBe('1')

    const codingToFaf = container.querySelector(
      '[data-edge-key="coding→final_audit_fix"] .mg-edge-label',
    )
    expect(codingToFaf).toBeTruthy()
    expect(codingToFaf!.textContent).toBe('1')

    // History rows reflect the same persisted transitions.
    const rows = container.querySelectorAll('.mg-history-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('set-phase')
    expect(rows[0].textContent).toContain('coding → final_audit_fix')
    expect(rows[1].textContent).toContain('final-audit-fix-prompt-error')
    expect(rows[1].textContent).toContain('final_audit_fix → coding')
  })

  test('final_auditing→coding recovery edge renders a matching SVG count for the persisted row', async () => {
    // `rotateToCodingAfterAuditFailure` (runtime.ts:617-635) records a
    // `final_auditing → coding` row with transitionKind 'error-recovery' when
    // a final audit session aborts (runtime.ts:2094) or errors before any
    // assistant response (runtime.ts:2151). The canvas must surface that
    // edge and count it instead of silently dropping the persisted row.
    payload = makePayload({
      dashLoop: {
        transitions: [
          {
            id: 1,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'final-audit-session-aborted',
            transitionKind: 'error-recovery',
            fromPhase: 'final_auditing',
            toPhase: 'coding',
            status: null,
            reason: 'aborted',
            iteration: 2,
            sectionIndex: null,
            createdAt: 1700000010000,
          },
          {
            id: 2,
            projectId: 'p1',
            loopName: 'loop-a',
            eventType: 'final-audit-session-error',
            transitionKind: 'error-recovery',
            fromPhase: 'final_auditing',
            toPhase: 'coding',
            status: null,
            reason: 'upstream 5xx',
            iteration: 3,
            sectionIndex: null,
            createdAt: 1700000020000,
          },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // The edge is rendered and its count aggregates both persisted rows.
    const recoveryLabel = container.querySelector(
      '[data-edge-key="final_auditing→coding"] .mg-edge-label',
    )
    expect(recoveryLabel).toBeTruthy()
    expect(recoveryLabel!.textContent).toBe('2')

    // Both history rows surface the persisted transitions, latest first.
    const rows = container.querySelectorAll('.mg-history-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('final-audit-session-error')
    expect(rows[0].textContent).toContain('final_auditing → coding')
    expect(rows[1].textContent).toContain('final-audit-session-aborted')
    expect(rows[1].textContent).toContain('final_auditing → coding')
  })

  test('poll reordering of multiple loops preserves the selected loop SVG root identity', async () => {
    // Initial: loop-a running (sorts first), loop-b completed newer.
    // URL hash selects p1/loop-a so the detail view + machine graph render.
    payload = makePayload({
      loops: [
        makeLoop({
          loop: {
            loopName: 'loop-a',
            status: 'running',
            phase: 'coding',
            startedAt: 1700000000000,
          },
        }),
        makeLoop({
          loop: {
            loopName: 'loop-b',
            status: 'completed',
            phase: 'post_action',
            startedAt: 1700000100000,
            completedAt: 1700000200000,
          },
        }),
      ],
      totals: { loops: 2, running: 1, completed: 1 },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Machine graph is mounted for loop-a; coding node is active.
    const svg1 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg1).toBeTruthy()
    ;(svg1 as any).__id = 'orig'
    expect(phaseNodeByText('coding')!.classList.contains('mg-node-active')).toBe(true)
    expect(container.querySelector('g.mg-terminal')).toBeFalsy()

    // Poll: loop-a completes (still older startedAt). Both now completed →
    // sort by startedAt desc → loop-b (newer) sorts ahead of loop-a,
    // reversing the loops array order. Supply the second payload in reversed
    // input order so keyed reconcile has to swap array positions.
    await poll(
      makePayload({
        loops: [
          makeLoop({
            loop: {
              loopName: 'loop-b',
              status: 'completed',
              phase: 'post_action',
              startedAt: 1700000100000,
              completedAt: 1700000200000,
            },
          }),
          makeLoop({
            loop: {
              loopName: 'loop-a',
              status: 'completed',
              phase: 'final_auditing',
              startedAt: 1700000000000,
              completedAt: 1700000300000,
            },
          }),
        ],
        totals: { loops: 2, running: 0, completed: 2 },
      }),
    )

    // The same SVG root node is reused (no subtree teardown despite the
    // loop-a/loop-b position swap in the underlying array).
    const svg2 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg2).toBe(svg1)
    expect((svg2 as any).__id).toBe('orig')
    // loop-a is completed now → no active phase node; terminal renders its
    // persisted status, in place within the preserved SVG root.
    for (const n of container.querySelectorAll('g.mg-node')) {
      expect(n.classList.contains('mg-node-active')).toBe(false)
    }
    const terminal = container.querySelector('g.mg-terminal')
    expect(terminal).toBeTruthy()
    expect(terminal!.querySelector('.mg-terminal-label')?.textContent).toBe('completed')

    // Still viewing loop-a's detail (loop-b's data should NOT have leaked in).
    const header = container.querySelector('.loop-detail-header')
    expect(header).toBeTruthy()
    expect(header!.textContent).toContain('loop-a')
    expect(header!.textContent).not.toContain('loop-b')
  })
})

describe('dashboard App plan amendments panel', () => {
  function amendRow(overrides: Record<string, any> = {}): any {
    return {
      id: 1,
      projectId: 'p1',
      loopName: 'loop-a',
      source: 'auditor',
      rationale: 'adjust plan for missing section',
      appliedAtSection: 4,
      sectionsBefore: JSON.stringify([{ index: 4, title: 'Old Section' }]),
      sectionsAfter: JSON.stringify([{ index: 4, title: 'New Section' }]),
      createdAt: Date.now() - 3600000, // 1 hour ago
      ...overrides,
    }
  }

  test('renders an amendments panel when the loop has amendments', async () => {
    payload = makePayload({
      dashLoop: {
        amendments: [amendRow()],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const panel = container.querySelector('.amendments-panel')
    expect(panel).toBeTruthy()
    expect(panel!.querySelector('.amendments-list')).toBeTruthy()
    expect(container.querySelector('.amendment-head')).toBeTruthy()
    // Rationale is visible in the header (not hidden inside the collapsed body).
    const rationale = container.querySelector('.amendment-head .amendment-rationale')
    expect(rationale!.textContent).toBe('adjust plan for missing section')
    // Body is collapsed initially.
    expect((container.querySelector('.amendment-body') as HTMLElement).style.display).toBe('none')
  })

  test('amendments panel is absent when the loop has no amendments', async () => {
    payload = makePayload({
      dashLoop: {
        amendments: [],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.amendments-panel')).toBeNull()
  })

  test('amendments survive poll reconciliation (panel node identity preserved)', async () => {
    payload = makePayload({
      dashLoop: {
        amendments: [amendRow({ id: 1, createdAt: Date.now() - 3600000 })],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const panel1 = container.querySelector('.amendments-panel') as HTMLElement
    expect(panel1).toBeTruthy()
    ;(panel1 as any).__id = 'orig'

    // Poll with updated data – same amendment, different created_at to force refresh.
    await poll(makePayload({
      dashLoop: {
        amendments: [amendRow({ id: 1, rationale: 'updated rationale', createdAt: Date.now() - 1800000 })],
      },
    }))

    const panel2 = container.querySelector('.amendments-panel') as HTMLElement
    expect(panel2).toBe(panel1)
    expect((panel2 as any).__id).toBe('orig')
    // Content updated in place; rationale is now rendered in the head.
    expect(container.querySelector('.amendment-head .amendment-rationale')!.textContent).toBe('updated rationale')
  })

  test('toggle expand/collapse shows before/after section titles', async () => {
    payload = makePayload({
      dashLoop: {
        amendments: [amendRow({ created_at: 1700000000000, id: 1 })],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Body exists in DOM but is hidden (--no expanded state).
    const body1 = container.querySelector('.amendment-body') as HTMLElement
    expect(body1).toBeTruthy()
    expect(body1.style.display).toBe('none')

    const head = container.querySelector('.amendment-head') as HTMLElement
    head.click()
    await flush()

    expect(body1.style.display).toBe('block')
    // Only before/after section titles in the expanded body; rationale lives in the header.
    expect(body1.querySelector('.amendment-rationale')).toBeNull()
    const items = container.querySelectorAll('.amendment-diff-item')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('4 Old Section')
    expect(items[1].textContent).toContain('4 New Section')
    // Carrot reflects expanded state.
    expect(container.querySelector('.amendment-head .amendment-caret')!.textContent).toBe('▾')
  })
})
