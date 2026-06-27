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
  return {
    generatedAt: Date.now(),
    projects: [
      {
        projectId: 'p1',
        projectDir: '/proj/p1',
        loops: [makeLoop({ ...dashLoopOver, loop: loopOver })],
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

  test('section rows show flat status and expand on click to reveal details', async () => {
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

    // Flat status: colored text class, with the status-coded left-border item, no pill background
    const item = container.querySelector('.section-item') as HTMLElement
    expect(item).toBeTruthy()
    expect(item.classList.contains('section-item-completed')).toBe(true)
    const statusEl = container.querySelector('.section-status') as HTMLElement
    expect(statusEl.textContent).toBe('completed')
    // attempts > 0 surfaced; duration computed from started→completed (500s = 8m 20s)
    expect(container.querySelector('.section-attempts')!.textContent).toContain('2 attempts')
    expect(container.querySelector('.section-duration')!.textContent).toBe('8m 20s')

    // Collapsed by default
    expect(container.querySelector('.section-body')).toBeFalsy()

    // Expand
    ;(container.querySelector('.section-head') as HTMLElement).click()
    await flush()

    const body = container.querySelector('.section-body') as HTMLElement
    expect(body).toBeTruthy()
    expect(body.textContent).toContain('Started')
    // Summary parts rendered as markdown; Deviations omitted (null)
    const labels = Array.from(body.querySelectorAll('.section-summary-label')).map(l => l.textContent)
    expect(labels).toEqual(['Done', 'Follow-ups'])
    expect(body.querySelector('.section-summary-part .markdown-content')!.innerHTML).toContain('Did the backend config')
    // Section plan content present (rendered inside the scrollable markdown block)
    expect(body.textContent).toContain('Section Plan')
    expect(container.querySelector('.markdown-scrollable .markdown-content')!.innerHTML).toContain('SECTION PLAN BODY')

    // Open state persists across a data poll that mutates a section field
    const next = makePayload({
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
    })
    await poll(next)
    expect(container.querySelector('.section-body')).toBeTruthy()
    expect(container.querySelector('.section-title')!.textContent).toContain('(edited)')
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

  test('totals bar reflects updated counts after a poll', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 1')

    await poll(makePayload({ loop: { status: 'completed' }, totals: { running: 0, completed: 1 } }))

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 0')
    expect(container.querySelector('.totals')?.textContent).toContain('Completed: 1')
  })
})
