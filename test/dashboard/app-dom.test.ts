// @vitest-environment happy-dom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'solid-js/web'
import { App } from '../../src/dashboard/app/app'
import { fmtTime, MAX_RENDERED_LOOP_ROWS, MAX_RENDERED_FINDING_ROWS, MAX_RENDERED_PICKER_OPTIONS } from '../../src/dashboard/app/helpers'

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
  const dashLoop = {
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
  return {
    ...dashLoop,
    hasPlan: over.hasPlan ?? !!dashLoop.plan,
    sectionCount: over.sectionCount ?? dashLoop.sections.length,
    bugCount: over.bugCount ?? dashLoop.findings.filter((f: any) => f.severity === 'bug').length,
  }
}

function makePayload(over: Record<string, any> = {}): any {
  const loopOver = over.loop || {}
  const dashLoopOver = over.dashLoop || {}
  // `loops` lets tests supply an explicit array (multi-loop scenarios);
  // otherwise the single-loop default applies. The project carries `id`
  // for keyed reconcile.
  const loops = over.loops
  delete over.loops
  const groups = over.groups ?? []
  delete over.groups
  return {
    generatedAt: Date.now(),
    projects: [
      {
        id: 'p1',
        projectId: 'p1',
        projectDir: '/proj/p1',
        loops: loops ?? [makeLoop({ ...dashLoopOver, loop: loopOver })],
        groups,
      },
    ],
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
  ;(globalThis as any).marked = {
    parse: (s: string) => s.split('\n').map(line => {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)
      if (m) { const lvl = m[1].length; return `<h${lvl}>${m[2]}</h${lvl}>` }
      return `<p>${line}</p>`
    }).join('\n'),
  }
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

  test('each loop row tags its cells with a column key', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const table = container.querySelector('table.loop-table') as HTMLElement
    expect(table).toBeTruthy()
    const cols = ['status', 'loop', 'phase', 'span', 'iter', 'sections', 'findings', 'cost', 'duration', 'updated']
    const ths = Array.from(table.querySelectorAll('thead th')) as HTMLElement[]
    expect(ths.map(th => th.getAttribute('data-col'))).toEqual(cols)
    const row = table.querySelector('tr.lt-row') as HTMLElement
    expect(row).toBeTruthy()
    const tds = Array.from(row.querySelectorAll('td')) as HTMLElement[]
    expect(tds.map(td => td.getAttribute('data-col'))).toEqual(cols)
  })

  test('the phase cell renders a coloured chip carrying the phase token', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const chip = container.querySelector('td[data-col="phase"] .lt-phase-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('data-phase')).toBe('coding')
    expect(chip.textContent).toBe('Coding')
  })

  test('a completed loop row shows an em dash instead of a stale phase chip', async () => {
    window.location.hash = '#p1'
    payload = makePayload({ loop: { status: 'completed', completedAt: 1700000500000, phase: 'post_action' } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const cell = container.querySelector('td[data-col="phase"]') as HTMLElement
    expect(cell.querySelector('.lt-phase-chip')).toBeNull()
    expect(cell.textContent?.trim()).toBe('—')
  })
})

describe('dashboard App fine-grained reactivity', () => {
  test('renders the loop detail with markdown after initial load', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.markdown-body')
    expect(body).toBeTruthy()
    expect(container.querySelector('.markdown-content')?.innerHTML).toContain('PLAN ONE')
  })

  test('markdown content updates in place when plan changes on a poll', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body1 = container.querySelector('.markdown-body') as HTMLElement
    expect(body1).toBeTruthy()
    ;(body1 as any).__id = 'orig'

    await poll(makePayload({ dashLoop: { plan: 'PLAN TWO' } }))

    const body2 = container.querySelector('.markdown-body') as HTMLElement
    // Same DOM node => collapse state and page scroll anchor preserved
    expect(body2).toBe(body1)
    expect((body2 as any).__id).toBe('orig')
    // ...and the content reflects the new plan
    expect(container.querySelector('.markdown-content')?.innerHTML).toContain('PLAN TWO')
  })

  test('status change keeps the markdown node (no full subtree rebuild) and updates the badge', async () => {
    // The status badge lives in the Overview tab body (LoopDetailHeader);
    // the markdown body lives in the Plan tab body. Activate Plan after
    // mounting so both lazy bodies coexist in the DOM.
    window.location.hash = '#p1/loop/loop-a'
    dispose = render(() => App() as unknown as Element, container)
    await flush()
    ;(container.querySelector('.tab-item[data-tab="plan"]') as HTMLElement).click()
    await flush()

    const body1 = container.querySelector('.markdown-body') as HTMLElement
    ;(body1 as any).__id = 'orig'
    expect(container.querySelector('.loop-detail-header .status-badge')?.textContent).toBe('running')

    await poll(
      makePayload({
        loop: { status: 'completed', completedAt: 1700000500000 },
      }),
    )

    const body2 = container.querySelector('.markdown-body') as HTMLElement
    expect(body2).toBe(body1)
    expect((body2 as any).__id).toBe('orig')
    expect(container.querySelector('.loop-detail-header .status-badge')?.textContent).toBe('completed')
  })

  test('a markdown section collapses and expands, keeps Copy available, and survives a poll', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const section = container.querySelector('.markdown-section') as HTMLElement
    const toggle = section.querySelector('.markdown-toggle') as HTMLElement
    const body = section.querySelector('.markdown-body') as HTMLElement
    expect(body.style.display).toBe('block')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(section.querySelector('.markdown-caret')!.textContent).toBe('▾')

    toggle.click()
    await flush()
    expect(body.style.display).toBe('none')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(section.querySelector('.markdown-caret')!.textContent).toBe('▸')
    // Copy stays reachable while collapsed.
    expect(section.querySelector('.copy-btn')).toBeTruthy()

    // A poll must not silently re-expand the section.
    await poll(makePayload({ dashLoop: { plan: 'PLAN TWO' } }))
    expect(container.querySelector('.markdown-body')).toBe(body)
    expect(body.style.display).toBe('none')

    toggle.click()
    await flush()
    expect(body.style.display).toBe('block')
    expect(container.querySelector('.markdown-content')?.innerHTML).toContain('PLAN TWO')
  })

  test('renders a floating table of contents when the plan has multiple headings', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = makePayload({
      dashLoop: { plan: '# Goal\n\nIntro paragraph.\n\n## Step One\n\nDo thing.\n\n## Step Two\n\nDo more.' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const toc = container.querySelector('.markdown-toc') as HTMLElement
    expect(toc).toBeTruthy()
    const items = toc.querySelectorAll('.markdown-toc-item')
    expect(items.length).toBe(3)
    expect(Array.from(items).map(i => i.className)).toEqual([
      'markdown-toc-item markdown-toc-depth-1',
      'markdown-toc-item markdown-toc-depth-2',
      'markdown-toc-item markdown-toc-depth-2',
    ])
    const links = Array.from(toc.querySelectorAll('a')).map(a => (a as HTMLAnchorElement).getAttribute('href'))
    expect(links).toEqual(['#goal', '#step-one', '#step-two'])

    const content = container.querySelector('.markdown-content') as HTMLElement
    expect(content.querySelector('#goal')).toBeTruthy()
    expect(content.querySelector('#step-one')).toBeTruthy()
    expect(content.querySelector('#step-two')).toBeTruthy()
    // h4 inside markdown-content uses the accent color.
    const tocItem = toc.querySelector('.markdown-toc-item a') as HTMLElement
    expect(tocItem.textContent).toBe('Goal')
  })

  // Heading ids are slugs, so two markdown sections sharing a heading produce
  // the same id twice in the document — and hidden tab bodies keep their DOM
  // once activated. A toc jump must resolve inside its own section, not the
  // first document match.
  test('a toc jump resolves the heading in its own markdown section', async () => {
    const shared = '# Shared\n\ntext\n\n## Verification\n\ntext'
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = makePayload({
      dashLoop: { plan: shared, lastAuditResult: shared, postActionReport: shared },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Plan is the active tab on mount, so its body is built lazily. Activate
    // Overview to mount its report/audit markdown bodies too, then return to
    // Plan. Both bodies now coexist in the DOM with colliding heading ids.
    const activateTab = async (tab: string) => {
      ;(container.querySelector(`.tab-item[data-tab="${tab}"]`) as HTMLElement).click()
      await flush()
    }
    await activateTab('overview')
    await activateTab('plan')

    const bodies = Array.from(container.querySelectorAll('.markdown-body')) as HTMLElement[]
    expect(bodies.length).toBeGreaterThan(1)
    // Every section injected the same ids, so getElementById would be ambiguous.
    expect(container.querySelectorAll('#verification').length).toBe(bodies.length)

    const planBody = bodies[bodies.length - 1]
    const target = planBody.querySelector('#verification') as HTMLElement
    let scrolled: HTMLElement | null = null
    for (const el of Array.from(container.querySelectorAll('#verification')) as HTMLElement[]) {
      el.scrollIntoView = () => { scrolled = el }
    }

    const link = Array.from(planBody.querySelectorAll('.markdown-toc-item a')).find(
      a => a.getAttribute('href') === '#verification',
    ) as HTMLElement
    link.click()
    await flush()

    expect(scrolled).toBe(target)
  })

  test('does not render a table of contents when the plan has fewer than two h1-h3 headings', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = makePayload({ dashLoop: { plan: 'PLAN ONE' } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.markdown-toc')).toBeFalsy()
    expect(container.querySelector('.markdown-body')).toBeTruthy()
  })


  test('section drill-in: click a row to open details, back returns to list', async () => {
    window.location.hash = '#p1/loop/loop-a/sections'
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
    expect(container.querySelector('.markdown-body .markdown-content')!.innerHTML).toContain('SECTION PLAN BODY')

    // Node identity preserved across a data poll that mutates section title
    const body1 = container.querySelector('.markdown-body') as HTMLElement
    expect(body1).toBeTruthy()
    ;(body1 as any).__id = 'drill'

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

    const body2 = container.querySelector('.markdown-body') as HTMLElement
    expect(body2).toBe(body1)
    expect((body2 as any).__id).toBe('drill')
    // Title reflects the edit
    expect(container.querySelector('.section-drill-title .section-title')!.textContent).toContain('(edited)')

    // Click back → list restored, .section-body absent
    ;(container.querySelector('.back-to-sections') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.section-list-row')).toBeTruthy()
    expect(container.querySelector('.section-body')).toBeFalsy()
  })

  test('renders usage graphs (stacked token bar + per-model cost bars)', async () => {
    window.location.hash = '#p1/loop/loop-a/usage'
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
          byRole: {
            code: { cost: 1.5, inputTokens: 50, outputTokens: 30, reasoningTokens: 10, cacheReadTokens: 8, cacheWriteTokens: 2, messageCount: 4 },
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
    const modelBlock = Array.from(container.querySelectorAll('.usage-block')).find(b =>
      b.querySelector('.usage-block-title')?.textContent === 'Cost by model')! as HTMLElement
    const fills = Array.from(modelBlock.querySelectorAll('.usage-model-fill')) as HTMLElement[]
    expect(fills.length).toBe(2)
    expect(fills[0].style.width).toBe('100%')
    expect(fills[1].style.width).toBe('50%')

    const names = Array.from(modelBlock.querySelectorAll('.usage-model-name')).map(n => n.textContent)
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
          byRole: {
            code: { cost: 0.42, inputTokens: 5000, outputTokens: 3000, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 7 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Findings banner sits in the header title row (still the single
    // .ldh-findings element in the header).
    const banner = container.querySelector('.loop-detail-header .ldh-findings') as HTMLElement
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('1 bug')
    expect(banner.textContent).toContain('1 warning')
    expect(banner.classList.contains('ldh-findings-bug')).toBe(true)

    // Grouped stat grids keep the scalar facts (Messages) but no longer
    // duplicate token/cost numbers now centralized in the usage graphs.
    const stats = Array.from(container.querySelectorAll('.loop-detail-header .ldh-stats'))
      .map(el => el.textContent ?? '').join(' ')
    expect(stats).toContain('Messages')
    expect(stats).not.toContain('Total Tokens')
    expect(stats).not.toContain('$')

    // Usage graphs (token composition + cost by model) live inside the Usage
    // tab body, which on first paint is built only when the user activates
    // the tab.
    const usageTab = container.querySelector('.tab-item[data-tab="usage"]') as HTMLElement
    usageTab.click()
    await flush()
    const usage = container.querySelector('.tab-body[data-tab="usage"] .usage-group')!
    expect(usage).toBeTruthy()
    expect(usage.querySelector('.usage-stack')).toBeTruthy()
    expect(usage.querySelector('.usage-legend')).toBeTruthy()
    expect(usage.querySelector('.usage-model-fill')).toBeTruthy()
    expect(usage.textContent).toContain('$')
    // No standalone Usage block remains a direct child of .loop-detail.
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

  test('filter bar reflects updated per-repo counts after a poll', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.filter-bar')?.textContent).toContain('Running: 1')

    await poll(makePayload({ loop: { status: 'completed' } }))

    expect(container.querySelector('.filter-bar')?.textContent).toContain('Running: 0')
    expect(container.querySelector('.filter-bar')?.textContent).toContain('Completed: 1')
  })
})

describe('dashboard App machine graph', () => {
  beforeEach(() => {
    // The machine graph lives in the Timeline tab body, which is built lazily
    // on first activation. Deep-link to the Timeline tab so each test mounts
    // the graph on first paint.
    window.location.hash = '#p1/loop/loop-a/timeline'
  })

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

  test('renders graph elements in the SVG namespace', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const svg = container.querySelector('svg.mg-svg')
    expect(svg).toBeTruthy()
    for (const element of svg!.querySelectorAll('g, path, rect, text')) {
      expect(element.namespaceURI).toBe('http://www.w3.org/2000/svg')
    }
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
    // Mount on Overview (so the LoopDetailHeader in the Overview body is
    // built) and then activate the Timeline tab to build the machine graph
    // body lazily; both bodies stay mounted for the lifetime of loop-a.
    window.location.hash = '#p1/loop/loop-a'
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
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()
    ;(container.querySelector('.tab-item[data-tab="timeline"]') as HTMLElement).click()
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
  beforeEach(() => {
    // Amendments are rendered inside the Plan tab body, which is built lazily
    // on first activation. Deep-link to the Plan tab so each test mounts it
    // on first paint.
    window.location.hash = '#p1/loop/loop-a/plan'
  })

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

  test('the loop header calls out that the plan was adjusted', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        amendments: [
          amendRow({ id: 1, createdAt: Date.now() - 3600000, appliedAtSection: 0 }),
          amendRow({ id: 2, createdAt: Date.now() - 1800000, appliedAtSection: 2 }),
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const callout = container.querySelector('.loop-detail-header .ldh-amendments') as HTMLElement
    expect(callout).toBeTruthy()
    // Count, relative timestamp of the newest amendment, and its 1-based section.
    expect(callout.textContent).toContain('2')
    expect(callout.textContent).toMatch(/\d+[smhd] ago/)
    expect(callout.textContent).toContain('section 3')
  })

  test('the header shows no adjustment callout when the plan was never adjusted', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        amendments: [],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.ldh-amendments')).toBeNull()
  })

  test('clicking the adjustment callout opens the Plan tab', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        amendments: [amendRow()],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const callout = container.querySelector('.ldh-amendments') as HTMLElement
    expect(callout).toBeTruthy()
    callout.click()
    await flush()

    expect(container.querySelector('.tab-item[data-tab="plan"]')?.classList.contains('tab-active')).toBe(true)
    expect((container.querySelector('.tab-body[data-tab="plan"]') as HTMLElement).style.display).not.toBe('none')
    expect(location.hash.endsWith('/plan')).toBe(true)
  })

  test('plan adjustments appear as distinct rows interleaved in the timeline', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: [
          { id: 1, projectId: 'p1', loopName: 'loop-a', eventType: 'phase', transitionKind: 'phase', fromPhase: 'coding', toPhase: 'auditing', status: null, reason: null, iteration: 1, sectionIndex: null, createdAt: startedAt + 1000 },
          { id: 2, projectId: 'p1', loopName: 'loop-a', eventType: 'phase', transitionKind: 'phase', fromPhase: 'auditing', toPhase: 'final_auditing', status: null, reason: null, iteration: 1, sectionIndex: null, createdAt: startedAt + 3000 },
        ],
        amendments: [
          amendRow({ id: 5, createdAt: startedAt + 2000, appliedAtSection: 1 }),
        ],
      },
      loop: { startedAt },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.timeline-events > .tl-event, .timeline-events > .tl-amendment')) as HTMLElement[]
    // Newest-first: transition at +3000, amendment at +2000, transition at +1000.
    expect(rows.length).toBe(3)
    expect(rows[0].classList.contains('tl-event')).toBe(true)
    expect(rows[1].classList.contains('tl-amendment')).toBe(true)
    expect(rows[2].classList.contains('tl-event')).toBe(true)
    expect(rows[1].querySelector('.tl-amendment-kind')!.textContent).toBe('plan adjusted')
    expect(rows[1].textContent).toContain('section 2')
    expect(rows[1].textContent).toContain('adjust plan for missing section')
  })

  test('a section whose plan was adjusted is flagged in the section list', async () => {
    window.location.hash = '#p1/loop/loop-a/sections'
    const section = (sectionIndex: number, title: string): any => ({
      projectId: 'p1',
      loopName: 'loop-a',
      sectionIndex,
      title,
      content: 'SECTION PLAN BODY',
      status: 'completed',
      attempts: 1,
      summaryDone: 'did it',
      summaryDeviations: null,
      summaryFollowUps: null,
      startedAt: 1700000000000,
      completedAt: 1700000500000,
      createdAt: 1700000000000,
    })
    payload = makePayload({
      dashLoop: {
        sections: [section(0, 'Section A'), section(1, 'Section B'), section(2, 'Section C')],
        amendments: [amendRow({ appliedAtSection: 1 })],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.section-list-row')) as HTMLElement[]
    expect(rows.length).toBe(3)
    const flagged = rows.filter(r => r.querySelector('.section-adjusted'))
    expect(flagged.length).toBe(1)
    expect(flagged[0].querySelector('.section-index')!.textContent).toBe('#1')
    expect(flagged[0].querySelector('.section-adjusted')!.textContent).toBe('adjusted')
  })
})

describe('dashboard App three-level shell', () => {
  test('level 0 shows repo-menu and no section-nav', async () => {
    window.location.hash = ''
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.repo-menu')).toBeTruthy()
    expect(container.querySelector('.section-nav')).toBeFalsy()
  })

  test('level 1 shows section-nav and no repo-menu', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.section-nav')).toBeTruthy()
    expect(container.querySelector('.repo-menu')).toBeFalsy()
  })

  test('level 2 hides the repo section-nav, leaving only the loop tabs', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.loop-detail-header')).toBeTruthy()
    expect(container.querySelector('.section-nav')).toBeFalsy()
    expect(container.querySelector('.tab-bar')).toBeTruthy()

    // Backing out to the repo restores it.
    ;(container.querySelector('.breadcrumb-back') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.section-nav')).toBeTruthy()
  })

  test('breadcrumb-path shows the full projectDir at level 1', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.breadcrumb-path')!.textContent).toBe('/proj/p1')
  })

  test('breadcrumb label is the short basename, not the full path', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.breadcrumb-label')!.textContent).toBe('p1')
  })

  test('clicking a repo-menu-item at level 0 sets the hash and removes the menu', async () => {
    window.location.hash = ''
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.repo-menu')).toBeTruthy()
    ;(container.querySelector('.repo-menu-item') as HTMLElement).click()
    await flush()

    expect(location.hash).toBe('#p1')
    expect(container.querySelector('.repo-menu')).toBeFalsy()
  })

  test('breadcrumb back link returns to level 0 and restores the repo-menu', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.repo-menu')).toBeFalsy()
    ;(container.querySelector('.breadcrumb-back') as HTMLElement).click()
    await flush()

    expect(container.querySelector('.repo-menu')).toBeTruthy()
    expect(container.querySelector('.breadcrumb')).toBeFalsy()
  })

  test('loop-table node identity survives a status-change poll at level 1', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const table1 = container.querySelector('table.loop-table') as HTMLElement
    expect(table1).toBeTruthy()
    ;(table1 as any).__id = 'orig'
    expect(table1.querySelector('.status-badge')!.textContent).toBe('running')

    await poll(
      makePayload({
        loop: { status: 'completed', completedAt: 1700000500000 },
      }),
    )

    const table2 = container.querySelector('table.loop-table') as HTMLElement
    expect(table2).toBe(table1)
    expect((table2 as any).__id).toBe('orig')
    expect(table2.querySelector('.status-badge')!.textContent).toBe('completed')
  })

  test('two projects sharing a basename show disambiguated labels in repo-menu', async () => {
    payload = {
      generatedAt: Date.now(),
      projects: [
        {
          id: 'p1',
          projectId: 'p1',
          projectDir: '/a/p1',
          loops: [
            makeLoop({
              loop: {
                projectId: 'p1',
                projectDir: '/a/p1',
                loopName: 'loop-a',
                status: 'running',
              },
            }),
          ],
        },
        {
          id: 'p2',
          projectId: 'p2',
          projectDir: '/b/p1',
          loops: [
            makeLoop({
              loop: {
                projectId: 'p2',
                projectDir: '/b/p1',
                loopName: 'loop-b',
                status: 'completed',
                completedAt: 1700000500000,
              },
            }),
          ],
        },
      ],
    }
    window.location.hash = ''
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const names = Array.from(container.querySelectorAll('.repo-menu-name')).map(
      n => n.textContent,
    )
    expect(names).toContain('a/p1')
    expect(names).toContain('b/p1')
    // The raw six-segment path must not leak into the visible labels.
    expect(names.some(n => n!.startsWith('/'))).toBe(false)
  })

  test('poll at level 0 updates the running count, summary, and running card without remount', async () => {
    // Two loops in one repo: one running (renders a running card), one
    // completed. The level-0 index pane must recompute its running count,
    // bug count, running card list, and recent activity when the underlying
    // loop data changes via reconciled poll — without unmounting the pane.
    payload = makePayload({
      loops: [
        makeLoop({
          loop: {
            loopName: 'loop-a',
            status: 'running',
            phase: 'coding',
            startedAt: 1700000000000,
          },
          findings: [{ id: 'f1', severity: 'bug', description: 'b1', sectionIndex: 0, createdAt: 1700000000000 }],
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
    })
    window.location.hash = ''
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const pane = container.querySelector('.repo-index-pane') as HTMLElement
    expect(pane).toBeTruthy()
    ;(pane as any).__id = 'orig'
    expect(container.querySelector('.repo-index-summary')!.textContent).toBe('1 running · 2 loops · 1 open bugs')
    expect(container.querySelectorAll('.repo-running-card').length).toBe(1)
    expect(container.querySelector('.repo-running-name')!.textContent).toBe('loop-a')

    // Poll: the running loop completes (no running card), takes on a bug
    // finding, and the recent row reflects its new status.
    await poll(
      makePayload({
        loops: [
          makeLoop({
            loop: {
              loopName: 'loop-a',
              status: 'completed',
              phase: 'post_action',
              startedAt: 1700000000000,
              completedAt: 1700000500000,
            },
            findings: [
              { id: 'f1', severity: 'bug', description: 'b1', sectionIndex: 0, createdAt: 1700000000000 },
              { id: 'f2', severity: 'bug', description: 'b2', sectionIndex: 1, createdAt: 1700000100000 },
            ],
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
      }),
    )

    // Same pane node — no subtree teardown.
    const pane2 = container.querySelector('.repo-index-pane') as HTMLElement
    expect(pane2).toBe(pane)
    expect((pane2 as any).__id).toBe('orig')
    // Counts and card list reactively updated.
    expect(container.querySelector('.repo-index-summary')!.textContent).toBe('0 running · 2 loops · 2 open bugs')
    expect(container.querySelectorAll('.repo-running-card').length).toBe(0)
    // Recent activity still renders both loops; loop-a's status row updated.
    const recentNames = Array.from(container.querySelectorAll('.repo-recent-name')).map(n => n.textContent)
    expect(recentNames).toContain('loop-a')
    expect(recentNames).toContain('loop-b')
  })

  test('the app bar holds the home link, breadcrumb, and last-updated stamp in one row', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const bar = container.querySelector('.app-bar') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.querySelectorAll('.forge-home')).toHaveLength(1)
    expect(bar.querySelector('.breadcrumb')).toBeTruthy()
    const stamp = bar.querySelector('.timestamp') as HTMLElement
    expect(stamp).toBeTruthy()
    expect(stamp.textContent).toContain('Last updated')
    // The old stacked summary row is gone entirely.
    expect(container.querySelector('.dashboard-summary')).toBeNull()
  })

  test('the app bar renders without a breadcrumb at the repo index', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // At level 1 the bar carries the repo breadcrumb.
    const bar = container.querySelector('.app-bar') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.querySelector('.forge-home')).toBeTruthy()
    expect(bar.querySelector('.breadcrumb')).toBeTruthy()

    // Clearing to the repo index keeps the bar mounted and empties the slot.
    ;(container.querySelector('.breadcrumb-back') as HTMLElement).click()
    await flush()
    expect(location.hash).toBe('')
    expect(container.querySelector('.app-bar .forge-home')).toBeTruthy()
    expect(container.querySelector('.app-bar .breadcrumb')).toBeNull()
  })

  test('the app bar timestamp stays empty before the first payload and after a failed fetch', async () => {
    window.location.hash = '#p1/loop/loop-a'
    ;(globalThis as any).fetch = vi.fn(async () => {
      throw new Error('boom')
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // No payload yet: the bar is mounted but must not advertise an epoch stamp.
    const stamp = container.querySelector('.app-bar .timestamp') as HTMLElement
    expect(stamp).toBeTruthy()
    expect(stamp.textContent).toBe('')
    expect(stamp.textContent).not.toContain('1970')
    expect(container.querySelector('.error-text')).toBeTruthy()

    // A successful poll populates the stamp with the real value.
    ;(globalThis as any).fetch = vi.fn(async () => ({ json: async () => payload }))
    await intervalFn?.()
    await flush()
    expect(container.querySelector('.app-bar .timestamp')!.textContent).toContain('Last updated')
    expect(container.querySelector('.app-bar .timestamp')!.textContent).not.toContain('1970')
    expect(container.querySelector('.error-text')).toBeNull()
  })
})

describe('dashboard App status filters and search', () => {
  function multiLoopPayload(): any {
    return {
      generatedAt: Date.now(),
      projects: [
        {
          id: 'p1',
          projectId: 'p1',
          projectDir: '/proj/p1',
          loops: [
            makeLoop({
              loop: { loopName: 'loop-running', status: 'running', startedAt: 1700000000000 },
            }),
            makeLoop({
              loop: { loopName: 'loop-errored', status: 'errored', startedAt: 1700000100000 },
            }),
          ],
        },
      ],
    }
  }

  async function clickChip(status: string): Promise<void> {
    const chips = Array.from(container.querySelectorAll('.filter-bar .badge-filter')) as HTMLElement[]
    const chip = chips.find(c => c.textContent?.toLowerCase().startsWith(status))
    expect(chip).toBeTruthy()
    chip!.click()
    await flush()
  }

  test('at level 1, clicking the errored status chip writes ?status=errored and filters the table', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)

    await clickChip('errored')

    expect(location.hash).toBe('#p1?status=errored')
    const rows = Array.from(container.querySelectorAll('tr.lt-row')) as HTMLElement[]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('loop-errored')
  })

  test('clicking an active chip clears it and the hash returns to #p1', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    await clickChip('errored')
    expect(location.hash).toBe('#p1?status=errored')

    await clickChip('errored')
    expect(location.hash).toBe('#p1')
    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)
  })

  test('loading directly at ?status=running,errored renders both chips active on first paint', async () => {
    window.location.hash = '#p1?status=running,errored'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const active = Array.from(container.querySelectorAll('.filter-bar .badge-active')) as HTMLElement[]
    const activeLabels = active.map(a => a.textContent?.toLowerCase() ?? '')
    expect(activeLabels.some(l => l.startsWith('running'))).toBe(true)
    expect(activeLabels.some(l => l.startsWith('errored'))).toBe(true)
    // Both loops match the union filter.
    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)
  })

  test('filter chips are absent at level 0 and level 2', async () => {
    // Level 0: no project selected.
    window.location.hash = ''
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()
    expect(container.querySelector('.filter-bar')).toBeFalsy()

    // Level 2: a loop is open.
    window.location.hash = '#p1'
    dispose?.()
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    dispose = render(() => App() as unknown as Element, container)
    await flush()
    ;(container.querySelector('tr.lt-row') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.filter-bar')).toBeFalsy()
  })

  test('a poll arriving while a status filter is active does not reset the filter', async () => {
    window.location.hash = '#p1?status=errored'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(location.hash).toBe('#p1?status=errored')
    expect(container.querySelectorAll('tr.lt-row').length).toBe(1)

    // Poll with updated data; the route is unaffected, so the filter persists.
    await poll(multiLoopPayload())

    expect(location.hash).toBe('#p1?status=errored')
    expect(container.querySelectorAll('tr.lt-row').length).toBe(1)
    // Active chip still reflects the errored filter.
    const active = Array.from(container.querySelectorAll('.filter-bar .badge-active')) as HTMLElement[]
    expect(active.some(a => (a.textContent ?? '').toLowerCase().startsWith('errored'))).toBe(true)
  })

  test('a filter with zero matching loops keeps the repo shell mounted at level 1', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Search for a substring matching neither loop name, branch, nor label.
    let input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = 'nomatch-xyz'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Wait past the 250ms debounce trailing edge, then settle effects.
    await new Promise((r) => setTimeout(r, 350))
    await flush()

    // The hash carries the query and we stay at level 1.
    expect(location.hash).toBe('#p1?q=nomatch-xyz')
    // Level-1 shell remains fully mounted: filter bar, breadcrumb, section nav.
    expect(container.querySelector('.filter-bar')).toBeTruthy()
    expect(container.querySelector('.breadcrumb')).toBeTruthy()
    expect(container.querySelector('.section-nav')).toBeTruthy()
    // Level 0 menu is NOT shown.
    expect(container.querySelector('.repo-menu')).toBeFalsy()
    // No loop rows match; the in-repo empty state is rendered.
    expect(container.querySelectorAll('tr.lt-row').length).toBe(0)
    expect(container.querySelector('.empty-state')).toBeTruthy()

    // Clearing the filter restores the loop list without leaving level 1.
    // (Re-query the input: the debounce commit recreates FilterBar.)
    input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 350))
    await flush()

    expect(location.hash).toBe('#p1')
    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)
    expect(container.querySelector('.empty-state')).toBeFalsy()
  })

  test('returning to repositories clears repo-scoped filters from memory', async () => {
    window.location.hash = '#p1?status=errored'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(location.hash).toBe('#p1?status=errored')
    expect(container.querySelector('.filter-bar')).toBeTruthy()
    expect(container.querySelectorAll('tr.lt-row').length).toBe(1)

    // Back to repositories — filters must be cleared from the route.
    ;(container.querySelector('.breadcrumb-back') as HTMLElement).click()
    await flush()

    expect(container.querySelector('.repo-menu')).toBeTruthy()
    expect(location.hash).toBe('')

    // Select the same repo again — it must start unfiltered.
    ;(container.querySelector('.repo-menu-item') as HTMLElement).click()
    await flush()

    expect(location.hash).toBe('#p1')
    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)
    expect(container.querySelectorAll('.filter-bar .badge-active').length).toBe(0)
  })

  test('a count-changing poll during the debounce window does not discard the pending query', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = 'loop-running'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Within the 250ms window, a count-changing poll arrives. FilterBar must
    // persist rather than be recreated, so its pending debounce survives.
    await poll(
      makePayload({
        loops: [
          makeLoop({ loop: { loopName: 'loop-running', status: 'running', startedAt: 1700000000000 } }),
          makeLoop({ loop: { loopName: 'loop-errored', status: 'errored', startedAt: 1700000100000 } }),
          makeLoop({ loop: { loopName: 'loop-completed', status: 'completed', startedAt: 1700000200000 } }),
        ],
      }),
    )

    // The input retains the typed text despite the count update.
    expect((container.querySelector('#loop-search') as HTMLInputElement).value).toBe('loop-running')

    // Wait past the 250ms debounce trailing edge, then settle effects.
    await new Promise((r) => setTimeout(r, 350))
    await flush()

    // The pending query reached the hash despite the intervening poll.
    expect(location.hash).toBe('#p1?q=loop-running')
    const rows = Array.from(container.querySelectorAll('tr.lt-row')) as HTMLElement[]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('loop-running')
  })

  test('typing a query then toggling a status within the debounce window still commits the query', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelectorAll('tr.lt-row').length).toBe(2)

    const input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = 'loop-running'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Within the 250ms window, toggle a status chip. FilterBar must persist
    // so its pending debounce timer survives the reactive update.
    await clickChip('running')

    // The status toggle lands immediately; the query is still pending commit.
    expect(location.hash).toBe('#p1?status=running')
    // The input retains the typed text — no reset from the status update.
    expect((container.querySelector('#loop-search') as HTMLInputElement).value).toBe('loop-running')

    // Wait past the 250ms debounce trailing edge, then settle effects.
    await new Promise((r) => setTimeout(r, 350))
    await flush()

    // The typed query reaches the hash despite the intervening status toggle.
    expect(location.hash).toBe('#p1?status=running&q=loop-running')
    const rows = Array.from(container.querySelectorAll('tr.lt-row')) as HTMLElement[]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('loop-running')
  })

  test('filter bar cancels pending search debounce when disposed before the trailing edge', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Type a query — schedules the debounce timer but does not navigate yet.
    const input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = 'nomatch-xyz'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Within the 250ms window, open a loop (disposing the filter bar).
    ;(container.querySelector('tr.lt-row') as HTMLElement).click()
    await flush()

    // Navigated to the loop route; no query yet.
    expect(location.hash).toBe('#p1/loop/loop-running')

    // Wait well past the debounce trailing edge.
    await new Promise((r) => setTimeout(r, 350))
    await flush()

    // The stale timer was cancelled on disposal — the discarded query never
    // landed in the hash.
    expect(location.hash).toBe('#p1/loop/loop-running')
    expect(location.hash).not.toContain('q=')
  })

  test('external hash navigation during the debounce window cancels the pending query commit', async () => {
    window.location.hash = '#p1'
    payload = multiLoopPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('#loop-search') as HTMLInputElement
    input.value = 'stale-query'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    window.location.hash = '#p1?status=running'
    window.dispatchEvent(new Event('hashchange'))
    await flush()

    expect(location.hash).toBe('#p1?status=running')
    expect((container.querySelector('#loop-search') as HTMLInputElement).value).toBe('')

    await new Promise((r) => setTimeout(r, 350))
    await flush()

    expect(location.hash).toBe('#p1?status=running')
    expect(location.hash).not.toContain('q=stale-query')
  })
})

describe('dashboard App loop detail tabs', () => {
  async function clickTab(tab: string): Promise<void> {
    const item = container.querySelector(`.tab-item[data-tab="${tab}"]`) as HTMLElement
    expect(item).toBeTruthy()
    item.click()
    await flush()
  }

  function planLoopFixture(): any {
    return makePayload({
      dashLoop: {
        plan: 'PLAN BODY',
        sections: [
          {
            projectId: 'p1',
            loopName: 'loop-a',
            sectionIndex: 0,
            title: 'Section A',
            content: 'SECTION PLAN BODY',
            status: 'completed',
            attempts: 1,
            summaryDone: 'did it',
            summaryDeviations: null,
            summaryFollowUps: null,
            startedAt: 1700000000000,
            completedAt: 1700000500000,
            createdAt: 1700000000000,
          },
        ],
      },
    })
  }

  function goalLoopFixture(): any {
    return makePayload({
      dashLoop: {
        goal: 'GOAL TEXT',
        plan: null,
        sections: [],
        loop: { kind: 'goal', totalSections: 0 },
      },
    })
  }

  test('opening a plan loop builds only the active tab body and builds Usage on first activation', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = planLoopFixture()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const items = Array.from(container.querySelectorAll('.tab-item')) as HTMLElement[]
    expect(items.length).toBe(6)
    expect(items.map(i => i.dataset.tab)).toEqual(['overview', 'timeline', 'sections', 'findings', 'plan', 'usage'])

    // Every tab-body host exists on first paint with the active tab visible
    // and the rest hidden. Only the active (Overview) host has been populated;
    // the Usage host is empty until the user opens it.
    const usageHost = container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement
    expect(usageHost).toBeTruthy()
    expect(usageHost.style.display).toBe('none')
    expect(usageHost.querySelector('.usage-tab')).toBeNull()
    expect((container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement).querySelector('.overview-tab, .markdown-section')).toBeTruthy()

    await clickTab('usage')
    expect(usageHost.querySelector('.usage-tab')).toBeTruthy()
    expect(usageHost.style.display).toBe('block')
  })

  test('the timeline machine graph is not built until the Timeline tab is activated', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = planLoopFixture()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // The machine graph (~70-node SVG) lives inside the Timeline tab body. On
    // first paint with Overview active it must not be built.
    expect(container.querySelector('.mg-graph')).toBeNull()

    await clickTab('timeline')
    const graph = container.querySelector('.mg-graph') as HTMLElement
    expect(graph).toBeTruthy()
    expect(graph.querySelectorAll('g.mg-node').length).toBe(5)
  })

  test('a lazily built tab body keeps its node identity across a hide/show cycle and a poll', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = planLoopFixture()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Plan is not the active tab on mount; activate it to build its body.
    await clickTab('plan')
    const planBody = container.querySelector('.tab-body[data-tab="plan"]') as HTMLElement
    const planMd = planBody.querySelector('.markdown-content') as HTMLElement
    expect(planMd).toBeTruthy()
    ;(planMd as any).__id = 'plan-orig'

    // Switch to Overview (Plan body is hidden but kept) and back; the node
    // identity must be preserved on the lazy path, just as it is on the eager
    // path tested above.
    await clickTab('overview')
    expect(planBody.style.display).toBe('none')
    await clickTab('plan')

    const planMd2 = planBody.querySelector('.markdown-content') as HTMLElement
    expect(planMd2).toBe(planMd)
    expect((planMd2 as any).__id).toBe('plan-orig')

    // A poll that mutates the plan content must update the same DOM node in
    // place, not rebuild it.
    await poll(makePayload({ dashLoop: { plan: 'PLAN TWO' } }))
    const planMd3 = planBody.querySelector('.markdown-content') as HTMLElement
    expect(planMd3).toBe(planMd)
    expect(planMd3.innerHTML).toContain('PLAN TWO')
  })

  test('opening a goal loop renders no Sections tab and its Overview contains the goal text', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = goalLoopFixture()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const tabs = Array.from(container.querySelectorAll('.tab-item')).map((i: HTMLElement) => i.dataset.tab)
    expect(tabs).not.toContain('sections')
    // Overview is active and its body contains the goal markdown.
    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    expect(overviewBody.style.display).not.toBe('none')
    expect(overviewBody.querySelector('.markdown-content')?.innerHTML).toContain('GOAL TEXT')
  })

  test('clicking the Usage tab writes #p1/loop/loop-a/usage and shows the usage body', async () => {
    window.location.hash = '#p1/loop/loop-a'
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
          },
          byRole: {
            code: { cost: 1.5, inputTokens: 50, outputTokens: 30, reasoningTokens: 10, cacheReadTokens: 8, cacheWriteTokens: 2, messageCount: 4 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    await clickTab('usage')

    expect(location.hash).toBe('#p1/loop/loop-a/usage')
    const usageBody = container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement
    expect(usageBody.style.display).not.toBe('none')
    expect(usageBody.querySelector('.usage-group')).toBeTruthy()
    // Overview is now hidden.
    expect((container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement).style.display).toBe('none')
  })

  test('loading directly at #p1/loop/loop-a/usage opens on the Usage tab on first paint', async () => {
    window.location.hash = '#p1/loop/loop-a/usage'
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 0.4,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 1,
          byModel: {
            'model-a': { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
          byRole: {
            code: { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('usage')
    expect((container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement).style.display).not.toBe('none')
    expect((container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement).style.display).toBe('none')
  })

  test('tab identity is preserved across tab switch: Plan collapse state survives hide/show', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = planLoopFixture()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const planTab = () => container.querySelector('.tab-body[data-tab="plan"]') as HTMLElement
    const planMd = planTab().querySelector('.markdown-body') as HTMLElement
    expect(planMd).toBeTruthy()
    ;(planMd as any).__id = 'plan-orig'
    ;(planTab().querySelector('.markdown-toggle') as HTMLElement).click()
    await flush()
    expect(planMd.style.display).toBe('none')

    await clickTab('usage')
    expect(planTab().style.display).toBe('none')

    await clickTab('plan')
    const planMd2 = planTab().querySelector('.markdown-body') as HTMLElement
    expect(planMd2).toBe(planMd)
    expect((planMd2 as any).__id).toBe('plan-orig')
    // Still collapsed: the node was hidden, not rebuilt.
    expect(planMd2.style.display).toBe('none')
  })

  test('a poll changing loop status while on the Usage tab leaves the active tab unchanged', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 0.4,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 1,
          byModel: {
            'model-a': { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
          byRole: {
            code: { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    await clickTab('usage')
    expect(location.hash).toBe('#p1/loop/loop-a/usage')

    await poll(makePayload({
      loop: { status: 'completed', completedAt: 1700000500000 },
    }))

    expect(location.hash).toBe('#p1/loop/loop-a/usage')
    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('usage')
    expect((container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement).style.display).not.toBe('none')
  })

  test('Findings tab groups four findings under sect 1 and two under cross-section', async () => {
    window.location.hash = '#p1/loop/loop-a/findings'
    payload = makePayload({
      dashLoop: {
        findings: [
          { severity: 'bug', file: 'a.ts', line: 1, description: 'b1', scenario: null, sectionIndex: 0, createdAt: 100 },
          { severity: 'bug', file: 'b.ts', line: 2, description: 'b2', scenario: null, sectionIndex: 0, createdAt: 200 },
          { severity: 'warning', file: 'c.ts', line: 3, description: 'w1', scenario: null, sectionIndex: 0, createdAt: 300 },
          { severity: 'warning', file: 'd.ts', line: 4, description: 'w2', scenario: null, sectionIndex: 0, createdAt: 400 },
          { severity: 'bug', file: 'e.ts', line: 5, description: 'b3', scenario: null, sectionIndex: null, createdAt: 500 },
          { severity: 'warning', file: 'f.ts', line: 6, description: 'w3', scenario: null, sectionIndex: null, createdAt: 600 },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const findingsBody = container.querySelector('.tab-body[data-tab="findings"]') as HTMLElement
    expect(findingsBody.style.display).not.toBe('none')

    const groups = Array.from(findingsBody.querySelectorAll('.findings-group')) as HTMLElement[]
    expect(groups.length).toBe(2)
    const labels = groups.map(g => g.querySelector('.findings-group-label')?.textContent)
    expect(labels).toContain('sect 1')
    expect(labels).toContain('cross-section')
    const sectGroup = groups.find(g => g.querySelector('.findings-group-label')?.textContent === 'sect 1')!
    expect(sectGroup.querySelectorAll('.finding').length).toBe(4)
    const crossGroup = groups.find(g => g.querySelector('.findings-group-label')?.textContent === 'cross-section')!
    expect(crossGroup.querySelectorAll('.finding').length).toBe(2)
  })

  test('prev/next navigation preserves the active tab when the next loop supports it', async () => {
    // Two loops, both plan loops with sections+plan (so all six tabs are
    // supported on each). Switch to the Timeline tab on loop-a, then step
    // forward to loop-b: the active tab must stay on Timeline, not reset to
    // Overview. Unsupported tabs canonicalize separately, so any tab the
    // next loop renders is fine. loop-a is the more recent loop, so it sits
    // first in the recency-ordered pager and loop-b is its "next".
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loops: [
        makeLoop({
          loop: { loopName: 'loop-a', status: 'running', phase: 'coding', startedAt: 1700000100000 },
          sections: [{ index: 0, title: 's0', status: 'in_progress', startedAt: 1700000100000, completedAt: null, durationMs: null, iteration: 0, auditCount: 0, errorCount: 0, completionSummary: null }],
          plan: 'PLAN A',
        }),
        makeLoop({
          loop: { loopName: 'loop-b', status: 'running', phase: 'coding', startedAt: 1700000000000 },
          sections: [{ index: 0, title: 's0', status: 'in_progress', startedAt: 1700000000000, completedAt: null, durationMs: null, iteration: 0, auditCount: 0, errorCount: 0, completionSummary: null }],
          plan: 'PLAN B',
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    await clickTab('timeline')
    expect(location.hash).toBe('#p1/loop/loop-a/timeline')

    const next = container.querySelector('.loopnav-next') as HTMLElement
    expect(next).toBeTruthy()
    next.click()
    await flush()

    // Moved to loop-b while preserving the Timeline tab.
    expect(location.hash).toBe('#p1/loop/loop-b/timeline')
    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('timeline')
    expect((container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement).style.display).not.toBe('none')
    // The breadcrumb reflects loop-b as the current loop.
    expect((container.querySelector('.breadcrumb-loop') as HTMLInputElement).value).toBe('loop-b')
  })

  test('opening a loop from the loops table resets the active tab to overview', async () => {
    // Switching tabs to timeline, then clicking a different loop's table row
    // must return to Overview — entry points from lists/cards are the explicit
    // reset points, in contrast to prev/next which preserve the tab.
    window.location.hash = '#p1/loop/loop-a/timeline'
    payload = makePayload({
      loops: [
        makeLoop({
          loop: { loopName: 'loop-a', status: 'running', phase: 'coding', startedAt: 1700000000000 },
          sections: [{ index: 0, title: 's0', status: 'in_progress', startedAt: 1700000000000, completedAt: null, durationMs: null, iteration: 0, auditCount: 0, errorCount: 0, completionSummary: null }],
          plan: 'PLAN A',
        }),
        makeLoop({
          loop: { loopName: 'loop-b', status: 'running', phase: 'coding', startedAt: 1700000100000 },
          sections: [{ index: 0, title: 's0', status: 'in_progress', startedAt: 1700000100000, completedAt: null, durationMs: null, iteration: 0, auditCount: 0, errorCount: 0, completionSummary: null }],
          plan: 'PLAN B',
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Back out to the loops list (loopName null) and open loop-b via the row.
    window.location.hash = '#p1'
    await flush()
    const rows = Array.from(container.querySelectorAll('table.loop-table tbody tr')) as HTMLElement[]
    const loopBRow = rows.find(r => (r.querySelector('.lt-name') as HTMLElement)?.textContent === 'loop-b')!
    expect(loopBRow).toBeTruthy()
    loopBRow.click()
    await flush()

    expect(location.hash).toBe('#p1/loop/loop-b')
    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('overview')
  })
})

describe('dashboard App scoped poll', () => {
  async function clickTab(tab: string): Promise<void> {
    const item = container.querySelector(`.tab-item[data-tab="${tab}"]`) as HTMLElement
    expect(item).toBeTruthy()
    item.click()
    await flush()
  }

  function fetchCalls(): string[] {
    return (globalThis.fetch as any).mock.calls.map((c: any[]) => c[0] as string)
  }

  test('the initial poll requests /api/data scoped to the deep-linked project and loop', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls()[0]).toBe('/api/data?project=p1&loop=loop-a')
  })

  test('the repo index polls /api/data with no scope', async () => {
    window.location.hash = ''
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls()[0]).toBe('/api/data')
  })

  test('mounting a deep-linked loop issues exactly one fetch (scope effect defers on first run)', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls().length).toBe(1)
    expect(fetchCalls()[0]).toBe('/api/data?project=p1&loop=loop-a')
  })

  test('mounting at the repo index issues exactly one fetch', async () => {
    window.location.hash = ''
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls().length).toBe(1)
    expect(fetchCalls()[0]).toBe('/api/data')
  })

  test('an out-of-order scoped response cannot clobber a newer scoped response', async () => {
    // Two loops exist; mount on loop-a. An in-flight interval poll for loop-a
    // (request gen N) is superseded by a scoped navigation to loop-b (request
    // gen N+1). Resolving the newer response first, then the older one, must
    // not let the stale loop-a payload overwrite the loop-b detail.
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running', startedAt: 1700000100000 } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Fresh payload (newer): server scoped to loop-b; still contains both
    // loops so the route canonicalization effect does not bounce off loop-b.
    const freshPayload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running', startedAt: 1700000100000 }, plan: 'FRESH' }),
      ],
    })
    // Stale payload (older): server scoped to loop-a; carries only loop-a.
    // If applied after the fresh payload, reconcile drops loop-b from the
    // project and the route canonicalizes away from loop-b's detail.
    const stalePayload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
      ],
    })

    const fetchMock = globalThis.fetch as any
    let resolveStale!: () => void
    let resolveFresh!: () => void
    const stalePromise = new Promise<void>((r) => { resolveStale = r })
    const freshPromise = new Promise<void>((r) => { resolveFresh = r })
    fetchMock.mockImplementationOnce(async () => ({
      json: async () => { await stalePromise; return stalePayload },
    }))
    fetchMock.mockImplementationOnce(async () => ({
      json: async () => { await freshPromise; return freshPayload },
    }))

    // Trigger the older in-flight poll, then navigate to loop-b which fires
    // the newest scoped request.
    void intervalFn!()
    window.location.hash = '#p1/loop/loop-b'
    window.dispatchEvent(new Event('hashchange'))
    await flush()

    // Resolve the newer request first; loop-b detail is rendered.
    resolveFresh()
    await flush()
    expect(container.querySelector('.ldh-name')?.textContent).toBe('loop-b')

    // Resolve the older stale request; loop-b detail must remain (the stale
    // loop-a response was discarded by request generation).
    resolveStale()
    await flush()
    expect(container.querySelector('.ldh-name')?.textContent).toBe('loop-b')
    // The Plan tab body is built lazily; activate it to mount its markdown so
    // the FRESH plan content carried by the loop-b payload is observable.
    ;(container.querySelector('.tab-item[data-tab="plan"]') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.tab-body[data-tab="plan"] .markdown-content')?.textContent).toContain('FRESH')
  })

  test('a slow same-scope poll survives interval ticks and still renders', async () => {
    // Mount on loop-a; the initial load resolves with the default payload.
    // Then an interval tick fires a slow same-scope poll whose response takes
    // longer than one interval. A subsequent interval tick must NOT supersede
    // it (no generation bump, no second fetch issued); the slow response must
    // still be accepted and update the UI when it resolves.
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const slowPayload = makePayload({ dashLoop: { plan: 'PLAN TWO' } })
    const fetchMock = globalThis.fetch as any
    let resolveSlow!: () => void
    const slowPromise = new Promise<void>((r) => { resolveSlow = r })
    fetchMock.mockImplementationOnce(async () => ({
      json: async () => { await slowPromise; return slowPayload },
    }))

    // Start the slow same-scope poll.
    void intervalFn!()
    await flush()
    const callsAfterStart = fetchCalls()

    // While it is pending, another interval tick must coalesce rather than
    // issue a competing fetch (no new fetch URL recorded).
    void intervalFn!()
    await flush()
    expect(fetchCalls()).toEqual(callsAfterStart)

    // Resolving the slow response updates the UI even though an interval tick
    // occurred while it was in flight.
    resolveSlow()
    await flush()
    ;(container.querySelector('.tab-item[data-tab="plan"]') as HTMLElement).click()
    await flush()
    expect(container.querySelector('.tab-body[data-tab="plan"] .markdown-content')?.textContent).toContain('PLAN TWO')
  })

  test('selecting a loop from the table triggers an immediate scoped refetch', async () => {
    window.location.hash = '#p1'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const before = fetchCalls().length
    ;(container.querySelector('tr.lt-row') as HTMLElement).click()
    await flush()

    const calls = fetchCalls()
    expect(calls.length).toBe(before + 1)
    expect(calls[calls.length - 1]).toBe('/api/data?project=p1&loop=loop-a')
  })

  test('switching tabs does not trigger a refetch', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 0.4,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 1,
          byModel: {
            'model-a': { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
          byRole: {
            code: { cost: 0.4, inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const before = fetchCalls().length
    await clickTab('usage')
    expect(fetchCalls().length).toBe(before)
  })

  test('a loop whose plan content has not arrived still offers the Plan tab', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = makePayload({ dashLoop: { hasPlan: true, plan: null } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.tab-item[data-tab="plan"]')).toBeTruthy()
    const planBody = container.querySelector('.tab-body[data-tab="plan"]') as HTMLElement
    expect(planBody).toBeTruthy()
    expect(planBody.textContent).not.toContain('No plan recorded for this loop.')
  })

  test('opening a loop directly from the repo index issues a single scoped fetch', async () => {
    // Mount at the global repo index (projectId=null), then click a running
    // loop card. The click navigates projectId and loopName together; without
    // batching the scopeKey effect would fire twice — once for the project
    // scope and once for the project+loop scope.
    window.location.hash = ''
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls()).toEqual(['/api/data'])

    const card = container.querySelector('.repo-running-card') as HTMLElement
    expect(card).toBeTruthy()
    card.click()
    await flush()

    expect(fetchCalls()).toEqual(['/api/data', '/api/data?project=p1&loop=loop-a'])
  })

  test('a multi-field external hash navigation issues a single scoped fetch', async () => {
    // Preload both projects so the route-canonicalisation effect does not
    // bounce the new project out before its fetch resolves. Mount on a loop in
    // p1, then an external hashchange lands on a loop in p2. Both projectId and
    // loopName change in one applyRoute call; without batching the scopeKey
    // effect would fire for the intermediate state (project=p2, loop=loop-a)
    // and issue a stale /api/data?project=p2&loop=loop-a before the final
    // project+loop request.
    function twoProjectPayload(): any {
      const p2 = makePayload({
        loops: [
          makeLoop({ loop: { loopName: 'loop-b', status: 'running', startedAt: 1700000000000 } }),
        ],
      })
      p2.projects[0].id = 'p2'
      p2.projects[0].projectId = 'p2'
      p2.projects[0].projectDir = '/proj/p2'
      p2.projects[0].loops[0].id = 'loop-b'
      p2.projects[0].loops[0].loop.projectId = 'p2'

      const base = makePayload({
        loops: [
          makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
        ],
      })
      base.projects.push(p2.projects[0])
      return base
    }
    window.location.hash = '#p1/loop/loop-a'
    payload = twoProjectPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(fetchCalls()).toEqual(['/api/data?project=p1&loop=loop-a'])

    // External hash navigation moves both projectId and loopName together.
    const beforeCount = fetchCalls().length
    window.location.hash = '#p2/loop/loop-b'
    window.dispatchEvent(new Event('hashchange'))
    await flush()

    // Exactly one new fetch, scoped to the final route — not an intermediate
    // /api/data?project=p2&loop=loop-a.
    expect(fetchCalls().length).toBe(beforeCount + 1)
    expect(fetchCalls()[fetchCalls().length - 1]).toBe('/api/data?project=p2&loop=loop-b')
    expect(fetchCalls()).not.toContain('/api/data?project=p2&loop=loop-a')
  })
})

describe('dashboard App breadcrumb loop picker', () => {
  // completedAt || startedAt drives recency: beta-loop (running, 1700009000000),
  // gamma-run (1700004000000), alpha-loop (1700000600000).
  function pickerPayload(): any {
    return makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'alpha-loop', status: 'completed', startedAt: 1700000000000, completedAt: 1700000600000 } }),
        makeLoop({ loop: { loopName: 'beta-loop', status: 'running', startedAt: 1700009000000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'gamma-run', status: 'completed', startedAt: 1700003000000, completedAt: 1700004000000 } }),
      ],
    })
  }

  function optionNames(menu: HTMLElement): (string | null)[] {
    return Array.from(menu.querySelectorAll('.loop-picker-option-name')).map(n => n.textContent)
  }

  test('lists every repo loop most recent first with a timestamp, and opens the clicked loop', async () => {
    window.location.hash = '#p1/loop/alpha-loop'
    payload = pickerPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    expect(input.value).toBe('alpha-loop')
    const menu = container.querySelector('.loop-picker-menu') as HTMLElement
    expect(menu.style.display).toBe('none')

    input.focus()
    await flush()
    expect(menu.style.display).toBe('block')

    expect(optionNames(menu)).toEqual(['beta-loop', 'gamma-run', 'alpha-loop'])
    expect(Array.from(menu.querySelectorAll('.loop-picker-option-when')).map(n => n.textContent)).toEqual([
      fmtTime(1700009000000),
      fmtTime(1700004000000),
      fmtTime(1700000600000),
    ])
    const options = Array.from(menu.querySelectorAll('.loop-picker-option')) as HTMLElement[]
    expect(options[2].classList.contains('loop-picker-option-current')).toBe(true)
    // The pager count covers the same list the picker offers.
    expect(container.querySelector('.loopnav-count')!.textContent).toBe('3 of 3')

    options[0].click()
    await flush()
    expect(location.hash).toBe('#p1/loop/beta-loop')
    expect((container.querySelector('.breadcrumb-loop') as HTMLInputElement).value).toBe('beta-loop')
  })

  test('typing filters the options and Enter opens the highlighted loop', async () => {
    window.location.hash = '#p1/loop/alpha-loop'
    payload = pickerPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    input.focus()
    await flush()
    input.value = 'gam'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    const menu = container.querySelector('.loop-picker-menu') as HTMLElement
    expect(optionNames(menu)).toEqual(['gamma-run'])

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()

    expect(location.hash).toBe('#p1/loop/gamma-run')
    expect((container.querySelector('.breadcrumb-loop') as HTMLInputElement).value).toBe('gamma-run')
  })

  test('a query with no match shows the empty row and Enter is a no-op', async () => {
    window.location.hash = '#p1/loop/alpha-loop'
    payload = pickerPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    input.focus()
    await flush()
    input.value = 'nope'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    const menu = container.querySelector('.loop-picker-menu') as HTMLElement
    expect(optionNames(menu)).toEqual([])
    expect(menu.querySelector('.loop-picker-empty')).toBeTruthy()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(location.hash).toBe('#p1/loop/alpha-loop')
  })

  test('an open picker survives a poll that updates loop data', async () => {
    window.location.hash = '#p1/loop/alpha-loop'
    payload = pickerPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    input.focus()
    await flush()
    const menu = container.querySelector('.loop-picker-menu') as HTMLElement
    expect(menu.style.display).toBe('block')

    const next = pickerPayload()
    next.projects[0].loops[1].loop.iteration = 7
    await poll(next)

    expect(container.querySelector('.loop-picker-menu')).toBe(menu)
    expect(menu.style.display).toBe('block')
  })
})

describe('dashboard App overview tab content', () => {
  test('overview renders a metadata strip with models, branch, sandbox, kind, audits, and errors', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: {
        executionModel: 'exec-m',
        auditorModel: 'audit-m',
        worktreeBranch: 'feat/branch-x',
        sandbox: true,
        kind: 'goal',
        auditCount: 3,
        errorCount: 2,
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    expect(overviewBody.style.display).not.toBe('none')

    // The flat .ldh-stats grid is now split into labelled groups; aggregate
    // their text to keep the same coverage as the original strip assertion.
    const header = overviewBody.querySelector('.loop-detail-header') as HTMLElement
    const groupText = Array.from(header.querySelectorAll('.ldh-group'))
      .map(g => g.textContent ?? '').join(' ')
    expect(groupText).toContain('exec-m')
    expect(groupText).toContain('audit-m')
    expect(groupText).toContain('feat/branch-x')
    expect(groupText).toContain('on')
    expect(groupText).toContain('goal')
    expect(groupText).toContain('Audits')
    expect(groupText).toContain('3')
    expect(groupText).toContain('Errors')
    expect(groupText).toContain('2')
  })

  test('the loop header leads with a primary metric strip', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 1.5,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 4,
          byModel: {},
          byRole: {},
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const primary = container.querySelector('.loop-detail-header .ldh-primary') as HTMLElement
    expect(primary).toBeTruthy()
    expect(Array.from(primary.querySelectorAll('.ldh-metric-label')).map(l => l.textContent))
      .toEqual(['Duration', 'Cost', 'Iterations', 'Sections', 'Findings'])

    // The Sections metric is absent when the loop has no section breakdown.
    await poll(makePayload({ loop: { totalSections: 0 } }))
    expect(Array.from(primary.querySelectorAll('.ldh-metric-label')).map(l => l.textContent))
      .toEqual(['Duration', 'Cost', 'Iterations', 'Findings'])
  })

  test('secondary loop facts are organised into labelled groups', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: {
        executionModel: 'exec-m',
        auditorModel: 'audit-m',
        worktreeBranch: 'feat/branch-x',
        sandbox: true,
        kind: 'goal',
        auditCount: 3,
        errorCount: 2,
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const header = container.querySelector('.loop-detail-header') as HTMLElement
    const groups = Array.from(header.querySelectorAll('.ldh-group')) as HTMLElement[]
    expect(groups).toHaveLength(3)
    expect(Array.from(header.querySelectorAll('.ldh-group-label')).map(l => l.textContent))
      .toEqual(['Timing', 'Models', 'Environment'])

    const models = groups[1]
    expect(models.textContent).toContain('exec-m')
    expect(models.textContent).toContain('audit-m')

    const env = groups[2]
    expect(env.textContent).toContain('feat/branch-x')
    expect(env.textContent).toContain('on')
    expect(env.textContent).toContain('goal')
    expect(env.textContent).toContain('Audits')
    expect(env.textContent).toContain('3')
    expect(env.textContent).toContain('Errors')
    expect(env.textContent).toContain('2')
  })

  test('a long model name is not clipped and exposes its full value', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({ loop: { executionModel: 'GreatScott/GLM-4.7-turbo-preview-2026' } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const header = container.querySelector('.loop-detail-header') as HTMLElement
    const modelStat = Array.from(header.querySelectorAll('.ldh-stat')).find(s =>
      s.querySelector('.ldh-stat-label')?.textContent === 'Execution model') as HTMLElement
    const value = modelStat.querySelector('.ldh-stat-value') as HTMLElement
    expect(value.textContent).toBe('GreatScott/GLM-4.7-turbo-preview-2026')
    expect(value.title).toBe('GreatScott/GLM-4.7-turbo-preview-2026')
  })

  // The overview summarises findings exactly once, through the styled
  // .ldh-findings badge in LoopDetailHeader.
  test('overview summarises findings once with bug and warning counts', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        findings: [
          { severity: 'bug', file: 'a.ts', line: 1, description: 'b1', scenario: null, createdAt: 100 },
          { severity: 'bug', file: 'b.ts', line: 2, description: 'b2', scenario: null, createdAt: 200 },
          { severity: 'warning', file: 'c.ts', line: 3, description: 'w1', scenario: null, createdAt: 300 },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const badges = Array.from(overviewBody.querySelectorAll('.ldh-findings')) as HTMLElement[]
    expect(badges).toHaveLength(1)
    expect(badges[0].classList.contains('ldh-findings-bug')).toBe(true)
    expect(badges[0].textContent).toContain('2 bugs')
    expect(badges[0].textContent).toContain('1 warning')
  })

  test('overview with no findings renders a clean findings badge', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({ findings: [] })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const badges = Array.from(overviewBody.querySelectorAll('.ldh-findings')) as HTMLElement[]
    expect(badges).toHaveLength(1)
    expect(badges[0].classList.contains('ldh-findings-clean')).toBe(true)
    expect(badges[0].textContent).toContain('No findings')
  })

  test('overview with warnings only renders the warning count and no bug count', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: {
        findings: [
          { severity: 'warning', file: 'c.ts', line: 3, description: 'w1', scenario: null, createdAt: 300 },
        ],
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const badge = overviewBody.querySelector('.ldh-findings') as HTMLElement
    expect(badge.classList.contains('ldh-findings-warn')).toBe(true)
    expect(badge.textContent).toContain('1 warning')
    expect(overviewBody.textContent).not.toContain('0 bug')
  })

  test('overview goal markdown renders before the loop-detail-header', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { goal: 'GOAL TEXT', plan: null, sections: [], loop: { kind: 'goal', totalSections: 0 } },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const goalSection = Array.from(overviewBody.querySelectorAll('.markdown-section'))
      .find(s => s.querySelector('.section-label')?.textContent === 'Goal') as HTMLElement
    const header = overviewBody.querySelector('.loop-detail-header') as HTMLElement
    expect(goalSection).toBeTruthy()
    expect(header).toBeTruthy()
    // The goal section precedes the header in document order.
    const pos = goalSection.compareDocumentPosition(header)
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('overview renders postActionReport when present, taking precedence over completionSummary', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { postActionReport: 'PAR BODY' },
      loop: { completionSummary: 'COMPLETION BODY', status: 'completed', completedAt: 1700000500000 },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const labels = Array.from(overviewBody.querySelectorAll('.markdown-section .section-label')).map(l => l.textContent)
    expect(labels).toContain('Post-Action Report')
    expect(labels).not.toContain('Completion Summary')
    expect(overviewBody.textContent).toContain('PAR BODY')
    expect(overviewBody.textContent).not.toContain('COMPLETION BODY')
  })

  test('overview falls back to completionSummary when postActionReport is absent', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { postActionReport: null },
      loop: { completionSummary: 'COMPLETION BODY', status: 'completed', completedAt: 1700000500000 },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const labels = Array.from(overviewBody.querySelectorAll('.markdown-section .section-label')).map(l => l.textContent)
    expect(labels).toContain('Completion Summary')
    expect(overviewBody.textContent).toContain('COMPLETION BODY')
  })

  test('polling from completionSummary to postActionReport updates the heading and body', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { postActionReport: null },
      loop: { completionSummary: 'COMPLETION BODY', status: 'completed', completedAt: 1700000500000 },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    let labels = Array.from(overviewBody.querySelectorAll('.markdown-section .section-label')).map(l => l.textContent)
    expect(labels).toContain('Completion Summary')
    expect(overviewBody.textContent).toContain('COMPLETION BODY')

    await poll(makePayload({
      dashLoop: { postActionReport: 'PAR BODY' },
      loop: { completionSummary: 'COMPLETION BODY', status: 'completed', completedAt: 1700000500000 },
    }))

    labels = Array.from(overviewBody.querySelectorAll('.markdown-section .section-label')).map(l => l.textContent)
    expect(labels).toContain('Post-Action Report')
    expect(labels).not.toContain('Completion Summary')
    expect(overviewBody.textContent).toContain('PAR BODY')
    expect(overviewBody.textContent).not.toContain('COMPLETION BODY')
  })

  test('overview exposes lastAuditResult as its own markdown section', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { lastAuditResult: 'AUDIT BODY' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const labels = Array.from(overviewBody.querySelectorAll('.markdown-section .section-label')).map(l => l.textContent)
    expect(labels).toContain('Last Audit Result')
    expect(overviewBody.textContent).toContain('AUDIT BODY')
  })

  test('usage tab renders a role split bar with execution and auditor rows', async () => {
    window.location.hash = '#p1/loop/loop-a/usage'
    payload = makePayload({
      loop: { executionModel: 'exec-m', auditorModel: 'audit-m' },
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 3,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 8,
          byModel: {
            'exec-m': { cost: 2, inputTokens: 80, outputTokens: 15, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
            'audit-m': { cost: 1, inputTokens: 20, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
          },
          byRole: {
            code: { cost: 2, inputTokens: 80, outputTokens: 15, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
            auditor: { cost: 1, inputTokens: 20, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const usageBody = container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement
    const roleBlock = Array.from(usageBody.querySelectorAll('.usage-block')).find(b =>
      b.querySelector('.usage-block-title')?.textContent === 'Role split')! as HTMLElement
    const rows = Array.from(roleBlock.querySelectorAll('.usage-model-row')) as HTMLElement[]
    expect(rows.length).toBe(2)
    const names = rows.map(r => r.querySelector('.usage-model-name')?.textContent)
    expect(names).toContain('execution')
    expect(names).toContain('auditor')
    // Wider bar = larger role. Execution cost (2) > auditor cost (1).
    const execRow = rows.find(r => r.querySelector('.usage-model-name')?.textContent === 'execution')!
    const auditRow = rows.find(r => r.querySelector('.usage-model-name')?.textContent === 'auditor')!
    // Role bars reuse the styled model track/fill classes so they remain visible.
    expect(execRow.querySelector('.usage-model-track')).toBeTruthy()
    expect(execRow.querySelector('.usage-model-fill')).toBeTruthy()
    const execFill = (execRow.querySelector('.usage-model-fill') as HTMLElement).style.width
    const auditFill = (auditRow.querySelector('.usage-model-fill') as HTMLElement).style.width
    expect(execFill).toBe('100%')
    expect(auditFill).toBe('50%')
    // Cost labels expose the dollar amounts.
    expect(execRow.querySelector('.usage-model-cost')?.textContent).toBe('$2.00')
    expect(auditRow.querySelector('.usage-model-cost')?.textContent).toBe('$1.00')
  })

  test('usage role split uses recorded roles when execution and auditor share a model', async () => {
    window.location.hash = '#p1/loop/loop-a/usage'
    payload = makePayload({
      loop: { executionModel: 'shared-m', auditorModel: 'shared-m' },
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 3,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 8,
          byModel: {
            'shared-m': { cost: 3, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 8 },
          },
          byRole: {
            code: { cost: 2, inputTokens: 80, outputTokens: 15, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
            auditor: { cost: 1, inputTokens: 20, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const usageBody = container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement
    const roleBlock = Array.from(usageBody.querySelectorAll('.usage-block')).find(b =>
      b.querySelector('.usage-block-title')?.textContent === 'Role split')! as HTMLElement
    const rows = Array.from(roleBlock.querySelectorAll('.usage-model-row')) as HTMLElement[]
    const execRow = rows.find(r => r.querySelector('.usage-model-name')?.textContent === 'execution')!
    const auditRow = rows.find(r => r.querySelector('.usage-model-name')?.textContent === 'auditor')!
    expect(execRow.querySelector('.usage-model-cost')?.textContent).toBe('$2.00')
    expect(auditRow.querySelector('.usage-model-cost')?.textContent).toBe('$1.00')
    expect((execRow.querySelector('.usage-model-fill') as HTMLElement).style.width).toBe('100%')
    expect((auditRow.querySelector('.usage-model-fill') as HTMLElement).style.width).toBe('50%')
  })

  test('a goal loop loaded at /plan canonicalizes the hash to overview', async () => {
    window.location.hash = '#p1/loop/loop-a/plan'
    payload = makePayload({
      dashLoop: { goal: 'GOAL TEXT', plan: null, sections: [], loop: { kind: 'goal', totalSections: 0 } },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Plan tab is unavailable for a goal loop with no plan; URL canonicalizes
    // to the loop route (overview is the default and omitted from the hash).
    expect(location.hash).toBe('#p1/loop/loop-a')
    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('overview')
    expect(container.querySelector('.tab-item[data-tab="plan"]')).toBeFalsy()
  })

  test('a poll that removes the active conditional tab canonicalizes back to overview', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      dashLoop: { plan: 'PLAN BODY' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const planTab = container.querySelector('.tab-item[data-tab="plan"]') as HTMLElement
    expect(planTab).toBeTruthy()
    planTab.click()
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-a/plan')

    // Poll mutates the loop so plan becomes null → plan tab disappears while
    // the route still says /plan. The canonicalization effect must revert the
    // route to overview and rewrite the hash.
    await poll(makePayload({ dashLoop: { plan: null } }))

    expect(location.hash).toBe('#p1/loop/loop-a')
    const active = container.querySelector('.tab-item.tab-active') as HTMLElement
    expect(active?.dataset.tab).toBe('overview')
    expect(container.querySelector('.tab-item[data-tab="plan"]')).toBeFalsy()
  })

  test('a completed loop shows no live phase pill', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: { status: 'completed', completedAt: 1700000500000, phase: 'final_auditing' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // A terminal loop's outcome is carried by the status badge; the stale
    // persisted phase must not be advertised as a live phase pill.
    expect(container.querySelector('.loop-detail-header .ldh-phase')).toBeNull()
    expect(container.querySelector('.loop-detail-header .status-badge')?.textContent).toBe('completed')
  })

  test('a running loop shows the live phase pill with a human label', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: { phase: 'final_audit_fix' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const pill = container.querySelector('.loop-detail-header .ldh-phase')
    expect(pill).toBeTruthy()
    expect(pill!.textContent).toBe('Final audit fix')
  })

  test('a termination reason that only repeats the status renders no banner', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: { status: 'completed', completedAt: 1700000500000, terminationReason: 'completed' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.loop-detail-header .ldh-banner')).toBeNull()
  })

  test('a substantive termination reason still renders a status-tinted banner', async () => {
    window.location.hash = '#p1/loop/loop-a'
    payload = makePayload({
      loop: { status: 'errored', terminationReason: 'max iterations reached' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const banner = container.querySelector('.loop-detail-header .ldh-banner')
    expect(banner).toBeTruthy()
    expect(banner!.classList.contains('ldh-banner-errored')).toBe(true)
    expect(banner!.textContent).toContain('max iterations reached')
  })
})

describe('dashboard App timeline tab', () => {
  function transitionFixture(over: Record<string, any>[] = []): any[] {
    return over.map((t, i) => ({
      id: i + 1,
      projectId: 'p1',
      loopName: 'loop-a',
      eventType: 'evt-' + i,
      transitionKind: 'phase',
      fromPhase: 'coding',
      toPhase: 'auditing',
      status: null,
      reason: null,
      iteration: 1,
      sectionIndex: null,
      createdAt: 1700000010000 + i * 1000,
      ...t,
    }))
  }

  test('timeline renders one .phase-seg per span, each carrying data-phase', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: 1700000000500 },
          { fromPhase: 'auditing', toPhase: 'final_auditing', createdAt: 1700000001500 },
        ]),
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const segs = Array.from(body.querySelectorAll('.phase-seg')) as HTMLElement[]
    expect(segs.length).toBeGreaterThan(0)
    expect(segs.every(s => s.dataset.phase !== '')).toBe(true)
    // Two spans closed by transitions plus one open trailing span.
    expect(segs.map(s => s.dataset.phase)).toEqual(['coding', 'auditing', 'final_auditing'])
  })

  test('a running loop\'s final .phase-seg carries the phase-seg-open class', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: 1700000000500 },
        ]),
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const segs = Array.from(body.querySelectorAll('.phase-seg')) as HTMLElement[]
    expect(segs.length).toBe(2)
    expect(segs[segs.length - 1].classList.contains('phase-seg-open')).toBe(true)
  })

  test('a same-phase restarted loop displays its open current-phase span', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    // The loop row carries the new restart startedAt and the preserved phase
    // (final_auditing). The prior terminal row from the dead lifecycle sits
    // before the new startedAt; no restart row was recorded because the phase
    // was preserved.
    const restartStartedAt = 1700000100000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate', createdAt: restartStartedAt - 5000 },
        ]),
      },
      loop: { startedAt: restartStartedAt, phase: 'final_auditing' },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const segs = Array.from(body.querySelectorAll('.phase-seg')) as HTMLElement[]
    // One open current-phase span from the new startedAt; no closed span is
    // attributed to the dead lifecycle.
    expect(segs.length).toBe(1)
    expect(segs[0].dataset.phase).toBe('final_auditing')
    expect(segs[0].classList.contains('phase-seg-open')).toBe(true)
    // Truncation indicator must not appear: the prior terminal proves the
    // pre-startedAt history exists, not that it was dropped.
    expect(body.querySelector('.phase-truncated')).toBeNull()
    const legendItems = Array.from(body.querySelectorAll('.phase-legend-item')) as HTMLElement[]
    expect(legendItems.length).toBe(1)
    expect(legendItems[0].querySelector('.phase-totals-dot')?.getAttribute('data-phase')).toBe('final_auditing')
  })

  test('timeline event list renders 20 rows plus an expander when 100 transitions are present', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const transitions: any[] = []
    for (let i = 0; i < 100; i++) {
      transitions.push({
        id: i + 1,
        projectId: 'p1',
        loopName: 'loop-a',
        eventType: 'evt-' + i,
        transitionKind: 'phase',
        fromPhase: 'coding',
        toPhase: 'auditing',
        status: null,
        reason: null,
        iteration: i + 1,
        sectionIndex: null,
        createdAt: 1700000010000 + i * 1000,
      })
    }
    payload = makePayload({ dashLoop: { transitions } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const rows = body.querySelectorAll('.tl-event')
    expect(rows.length).toBe(20)
    const expander = body.querySelector('.tl-event-expand') as HTMLElement
    expect(expander).toBeTruthy()
    expect(expander.textContent).toContain('80 earlier events')

    expander.click()
    await flush()
    expect(body.querySelectorAll('.tl-event').length).toBe(100)
    expect(body.querySelector('.tl-event-expand')).toBeNull()
  })

  test('the machine graph renders unhidden at the top of the Timeline tab with five phase nodes', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    payload = makePayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    // No disclosure wrapper: the graph is always visible.
    expect(body.querySelector('details')).toBeNull()

    const graph = body.querySelector('.mg-graph') as HTMLElement
    expect(graph).toBeTruthy()
    expect(graph.querySelectorAll('g.mg-node').length).toBe(5)

    // It is the first child of the timeline tab, above the phase bar.
    const timeline = body.querySelector('.timeline-tab') as HTMLElement
    expect(timeline.firstElementChild).toBe(graph)
    const phaseBar = timeline.querySelector('.phase-bar, .phase-legend') as HTMLElement
    expect(graph.compareDocumentPosition(phaseBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('the SVG root survives a poll that changes the active phase', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    payload = makePayload({ loop: { phase: 'coding', status: 'running' } })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const svg1 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg1).toBeTruthy()
    ;(svg1 as any).__id = 'orig'

    await poll(makePayload({ loop: { phase: 'auditing', status: 'running' } }))

    const svg2 = container.querySelector('svg.mg-svg') as SVGElement
    expect(svg2).toBe(svg1)
    expect((svg2 as any).__id).toBe('orig')
  })

  test('advancing the dashboard clock during an unchanged poll updates the open phase duration', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000000000
    const initialNow = startedAt + 8000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 3000 },
        ]),
      },
      loop: { startedAt, phase: 'auditing', status: 'running', completedAt: null },
    })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(initialNow)
    try {
      dispose = render(() => App() as unknown as Element, container)
      await flush()

      const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
      const valueBefore = (body.querySelector('.phase-legend-value') as HTMLElement)?.textContent ?? ''
      // Open auditing span = 8s - 3s = 5s.
      expect(valueBefore).toContain('5s')

      const svgBefore = container.querySelector('svg.mg-svg') as SVGElement
      expect(svgBefore).toBeTruthy()

      // Advance the dashboard clock by 10s with no payload changes; the poll
      // would normally be skipped because dataHash is unchanged, but the
      // shared reactive clock must still drive phase-bar recomputation.
      spy.mockReturnValue(startedAt + 18000)
      await poll(payload)

      const valueAfter = (body.querySelector('.phase-legend-value') as HTMLElement)?.textContent ?? ''
      // Open auditing span now = 18s - 3s = 15s.
      expect(valueAfter).toContain('15s')
      expect(valueAfter).not.toBe(valueBefore)

      const svgAfter = container.querySelector('svg.mg-svg') as SVGElement
      expect(svgAfter).toBe(svgBefore)
    } finally {
      spy.mockRestore()
    }
  })

  test('a truncated loop marks the timeline bar and excludes the unknown leading span from totals and segs', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 5000 },
          { fromPhase: 'auditing', toPhase: 'final_auditing', createdAt: startedAt + 8000 },
        ]),
      },
      loop: { startedAt, phase: 'final_auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement

    // The truncation warning is shown.
    expect(body.querySelector('.phase-truncated')).toBeTruthy()

    // The phase bar carries the truncation indicator and a marker glyph.
    const bar = body.querySelector('.phase-bar') as HTMLElement
    expect(bar.classList.contains('phase-bar-trunc')).toBe(true)
    expect(bar.dataset.truncated).toBe('true')
    expect(bar.querySelector('.phase-bar-trunc-mark')).toBeTruthy()

    // Only the two known spans are rendered as segs; the unknown leading
    // coding interval is not attributed to the coding phase.
    const segs = Array.from(body.querySelectorAll('.phase-seg')) as HTMLElement[]
    expect(segs.map(s => s.dataset.phase)).toEqual(['auditing', 'final_auditing'])
    expect(segs.every(s => s.dataset.phase !== '' && s.dataset.phase !== 'coding')).toBe(true)

    // Totals exclude coding entirely: the only rows are auditing and final_auditing,
    // rendered with their human labels.
    const totalLabels = Array.from(body.querySelectorAll('.phase-legend-label')).map(el => el.textContent?.trim() ?? '')
    expect(totalLabels).not.toContain('coding')
    expect(totalLabels).toContain('Auditing')
    expect(totalLabels).toContain('Final audit')
  })

  test('the overview phase bar is accompanied by a legend naming each phase', async () => {
    window.location.hash = '#p1/loop/loop-a/overview'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 500 },
        ]),
      },
      loop: { startedAt, phase: 'auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const legend = body.querySelector('.phase-legend') as HTMLElement
    expect(legend).toBeTruthy()
    // The legend immediately follows the phase bar, rendering one row per phase.
    const bar = body.querySelector('.phase-bar') as HTMLElement
    expect(bar.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const items = Array.from(body.querySelectorAll('.phase-legend-item')) as HTMLElement[]
    expect(items).toHaveLength(2)
    const labels = items.map(el => (el.querySelector('.phase-legend-label') as HTMLElement)?.textContent?.trim() ?? '')
    expect(labels).toEqual(expect.arrayContaining(['Coding', 'Auditing']))
    // Longest phase first: the open auditing span outlasts the closed coding span.
    expect(labels[0]).toBe('Auditing')
    // Each item still carries the phase key on its dot for the color rule.
    expect(items.map(el => (el.querySelector('.phase-totals-dot') as HTMLElement)?.dataset.phase))
      .toEqual(['auditing', 'coding'])
  })

  test('each phase segment exposes a hover title naming its phase', async () => {
    window.location.hash = '#p1/loop/loop-a/overview'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 500 },
        ]),
      },
      loop: { startedAt, phase: 'auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const segs = Array.from(body.querySelectorAll('.phase-seg')) as HTMLElement[]
    expect(segs.length).toBeGreaterThan(0)
    for (const seg of segs) {
      const title = seg.title
      expect(title.length).toBeGreaterThan(0)
      expect(title).toMatch(/^(Coding|Auditing|Final audit|Final audit fix|Post-action) ·/)
    }
  })

  test('a truncated loop shows the truncation indicator on the overview and table phase bars', async () => {
    window.location.hash = '#p1/loop/loop-a/overview'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 5000 },
          { fromPhase: 'auditing', toPhase: 'final_auditing', createdAt: startedAt + 8000 },
        ]),
      },
      loop: { startedAt, phase: 'final_auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Overview bar marks truncation and excludes the unknown leading span.
    const overviewBody = container.querySelector('.tab-body[data-tab="overview"]') as HTMLElement
    const overviewBar = overviewBody.querySelector('.phase-bar') as HTMLElement
    expect(overviewBar.classList.contains('phase-bar-trunc')).toBe(true)
    expect(Array.from(overviewBar.querySelectorAll('.phase-seg')).map(s => (s as HTMLElement).dataset.phase))
      .toEqual(['auditing', 'final_auditing'])

    // Back at level 1, the loop-table row's compact bar also marks truncation.
    window.location.hash = '#p1'
    await flush()
    const table = container.querySelector('table.loop-table') as HTMLElement
    const rowBar = table.querySelector('.phase-bar') as HTMLElement
    expect(rowBar).toBeTruthy()
    expect(rowBar.classList.contains('phase-bar-trunc')).toBe(true)
    expect(Array.from(rowBar.querySelectorAll('.phase-seg')).map(s => (s as HTMLElement).dataset.phase))
      .toEqual(['auditing', 'final_auditing'])
  })

  test('event elapsed renders unavailable for truncated oldest and post-terminal rows', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: null, transitionKind: 'terminate', createdAt: startedAt + 500 },
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 10000 },
          { fromPhase: 'auditing', toPhase: 'final_auditing', createdAt: startedAt + 15000 },
        ]),
      },
      loop: { startedAt, phase: 'final_auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const rows = Array.from(body.querySelectorAll('.tl-event')) as HTMLElement[]
    // Newest first: t3 (final_auditing), t2 (auditing), t1 (terminal coding).
    expect(rows).toHaveLength(3)
    const elapsed = rows.map(r => (r.querySelector('.tl-event-elapsed') as HTMLElement)?.textContent?.trim() ?? '')
    // t3 follows a contiguous boundary at t2 → 5s.
    expect(elapsed[0]).toBe('5s')
    // t2 follows a terminal row → unavailable.
    expect(elapsed[1]).toBe('—')
    // t1 is the oldest row; not truncated (first transition < 1s after start)
    // → 500ms in coding before terminating.
    expect(elapsed[2]).toBe('0s')
  })

  test('event elapsed renders unavailable for the oldest row of a truncated window', async () => {
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000000000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 5000 },
          { fromPhase: 'auditing', toPhase: 'final_auditing', createdAt: startedAt + 8000 },
        ]),
      },
      loop: { startedAt, phase: 'final_auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const rows = Array.from(body.querySelectorAll('.tl-event')) as HTMLElement[]
    // Newest first: t2 (auditing→final_auditing), t1 (coding→auditing).
    expect(rows).toHaveLength(2)
    const elapsed = rows.map(r => (r.querySelector('.tl-event-elapsed') as HTMLElement)?.textContent?.trim() ?? '')
    // t2 follows a contiguous boundary at t1 → 3s.
    expect(elapsed[0]).toBe('3s')
    // t1 is the oldest row of a truncated window → unavailable.
    expect(elapsed[1]).toBe('—')
  })

  test('a same-phase restart followed by a transition renders startedAt-relative elapsed', async () => {
    // Loop terminates in final_auditing, restarts in that same phase (no
    // restart row emitted because the phase did not change), then transitions
    // ten minutes later. The first current-lifecycle transition's elapsed
    // must be measured from the new startedAt, not rendered as unavailable.
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000100000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'final_auditing', toPhase: null, transitionKind: 'terminate', createdAt: startedAt - 5000 },
          { fromPhase: 'final_auditing', toPhase: 'coding', createdAt: startedAt + 600000 },
        ]),
      },
      loop: { startedAt, phase: 'coding', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const rows = Array.from(body.querySelectorAll('.tl-event')) as HTMLElement[]
    // Newest first: t2 (final_auditing → coding), t1 (terminal).
    expect(rows).toHaveLength(2)
    const elapsed = rows.map(r => (r.querySelector('.tl-event-elapsed') as HTMLElement)?.textContent?.trim() ?? '')
    // t2's elapsed is measured from the current lifecycle's startedAt: 10m.
    expect(elapsed[0]).toBe('10m 0s')
    // t1 is the oldest row predating startedAt; unavailable.
    expect(elapsed[1]).toBe('—')
  })

  test('a transition after a phase-changing restart marker renders startedAt-relative elapsed, not marker-relative', async () => {
    // Realistic timing: the loop row restores the new phase and a fresh
    // startedAt BEFORE the restart transition row is recorded, so the marker
    // lands 100ms after startedAt. The successor transition at 5s must render
    // its elapsed from startedAt (5s), not from the marker timestamp (4.9s).
    window.location.hash = '#p1/loop/loop-a/timeline'
    const startedAt = 1700000100000
    payload = makePayload({
      dashLoop: {
        transitions: transitionFixture([
          { fromPhase: 'final_audit_fix', toPhase: null, transitionKind: 'terminate', createdAt: startedAt - 5000 },
          { fromPhase: 'final_audit_fix', toPhase: 'coding', eventType: 'restart', transitionKind: 'phase', createdAt: startedAt + 100 },
          { fromPhase: 'coding', toPhase: 'auditing', createdAt: startedAt + 5000 },
        ]),
      },
      loop: { startedAt, phase: 'auditing', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const body = container.querySelector('.tab-body[data-tab="timeline"]') as HTMLElement
    const rows = Array.from(body.querySelectorAll('.tl-event')) as HTMLElement[]
    // Newest first: t3 (coding→auditing), t2 (restart), t1 (terminal).
    expect(rows).toHaveLength(3)
    const elapsed = rows.map(r => (r.querySelector('.tl-event-elapsed') as HTMLElement)?.textContent?.trim() ?? '')
    // t3 measures elapsed from the current lifecycle's startedAt: 5s.
    expect(elapsed[0]).toBe('5s')
    // t2 is a restart marker (lifecycle boundary); elapsed unavailable.
    expect(elapsed[1]).toBe('—')
    // t1 predates startedAt; elapsed unavailable.
    expect(elapsed[2]).toBe('—')
  })

  test('a dense compact phase bar preserves zero-duration spans at width:0% without overflowing', async () => {
    // 100 transitions sharing the same createdAt produce one positive closed
    // span (startedAt → burstAt) followed by 99 zero-duration spans and one
    // open trailing span. Zero-duration known spans must render as width:0%
    // segments (one .phase-seg per known span, ordering preserved) without
    // consuming visible width, so the compact 80px table bar cannot clip the
    // open current-phase seg.
    window.location.hash = '#p1'
    const startedAt = 1700000000000
    const burstAt = startedAt + 1000
    const transitions: any[] = []
    for (let i = 0; i < 100; i++) {
      transitions.push({
        id: i + 1,
        projectId: 'p1',
        loopName: 'loop-a',
        eventType: 'evt-' + i,
        transitionKind: 'phase',
        fromPhase: i % 2 === 0 ? 'coding' : 'auditing',
        toPhase: i % 2 === 0 ? 'auditing' : 'coding',
        status: null,
        reason: null,
        iteration: 1,
        sectionIndex: null,
        createdAt: burstAt,
      })
    }
    payload = makePayload({
      dashLoop: { transitions },
      loop: { startedAt, phase: 'coding', status: 'running', completedAt: null },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const table = container.querySelector('table.loop-table') as HTMLElement
    const rowBar = table.querySelector('.phase-bar') as HTMLElement
    expect(rowBar).toBeTruthy()
    const segs = Array.from(rowBar.querySelectorAll('.phase-seg')) as HTMLElement[]
    // 101 known spans render: one positive coding span (startedAt → burstAt),
    // 99 closed zero-duration spans (alternating auditing/coding), and one
    // open trailing coding span. Only the unknown truncated-history marker
    // (empty phase) is excluded; none exists here.
    expect(segs.length).toBe(101)
    expect(segs.every(s => s.style.width.endsWith('%'))).toBe(true)
    // Zero-duration known spans render at width:0% so they consume no bar
    // width; the positive and open spans carry the only nonzero widths.
    const widths = segs.map(s => parseFloat(s.style.width))
    expect(widths[0]).toBeGreaterThan(0)
    expect(widths[widths.length - 1]).toBeGreaterThan(0)
    for (let i = 1; i < widths.length - 1; i++) {
      expect(widths[i]).toBe(0)
    }
    expect(segs[0].dataset.phase).toBe('coding')
    expect(segs[0].classList.contains('phase-seg-open')).toBe(false)
    expect(segs[segs.length - 1].dataset.phase).toBe('coding')
    expect(segs[segs.length - 1].classList.contains('phase-seg-open')).toBe(true)
    // Rendered widths sum to 100% (zero-duration segs contribute nothing) and
    // the bar does not grow wider than its 80px column.
    const totalPct = widths.reduce((acc, w) => acc + w, 0)
    expect(totalPct).toBeCloseTo(100, 5)
    const barRect = rowBar.getBoundingClientRect()
    expect(barRect.width).toBeLessThanOrEqual(80)
  })
})

describe('dashboard App groups section', () => {
  function makeGroup(over: Record<string, any> = {}): any {
    const groupOver = over.group || {}
    delete over.group
    return {
      id: groupOver.groupId ?? 'g-abc',
      group: {
        projectId: 'p1',
        groupId: 'g-abc',
        title: 'Group ABC',
        status: 'running',
        maxConcurrent: 3,
        executionModel: null,
        auditorModel: null,
        splitterSessionId: null,
        hostSessionId: null,
        error: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        completedAt: null,
        prdPreview: null,
        ...groupOver,
      },
      features: [],
      ...over,
    }
  }

  function makeFeature(over: Record<string, any> = {}): any {
    return {
      projectId: 'p1',
      groupId: 'g-abc',
      featureIndex: 0,
      title: 'Feature',
      description: 'd',
      stage: 'pending',
      architectSessionId: null,
      loopName: null,
      error: null,
      attempts: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      ...over,
    }
  }

  test('#p1/groups renders one .group-row per group with a features meter', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({ group: { groupId: 'g-a', title: 'A' } }),
        makeGroup({ group: { groupId: 'g-b', title: 'B' } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.group-row')) as HTMLElement[]
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.querySelector('.lt-meter-cell'))).toBe(true)
    // Loop table is hidden on the groups section.
    expect(container.querySelector('table.loop-table')).toBeFalsy()
  })

  test('#p1/groups/g-abc renders one .feature-row per feature', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'F0' }),
            makeFeature({ featureIndex: 1, title: 'F1' }),
            makeFeature({ featureIndex: 2, title: 'F2' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.feature-row')) as HTMLElement[]
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.querySelector('.feature-index')?.textContent)).toEqual(['#0', '#1', '#2'])
  })

  test('a feature with a loopName in the payload renders a link; one without renders its stage as text', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-linked', status: 'running' } }),
      ],
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'Linked', stage: 'running', loopName: 'loop-linked' }),
            makeFeature({ featureIndex: 1, title: 'Pending', stage: 'pending' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.feature-row')) as HTMLElement[]
    expect(rows.length).toBe(2)
    const linked = rows[0]
    const pending = rows[1]
    expect(linked.querySelector('.feature-loop-link')).toBeTruthy()
    expect(linked.querySelector('.feature-loop-link')!.textContent).toBe('loop-linked')
    // The anchor targets the canonical project-aware loop hash, not the index.
    expect(linked.querySelector('.feature-loop-link')!.getAttribute('href')).toBe('#p1/loop/loop-linked')
    // Pending feature has no loop link, but renders its stage as a stage badge.
    expect(pending.querySelector('.feature-loop-link')).toBeFalsy()
    expect(pending.querySelector('.feature-stage')!.textContent).toBe('pending')
  })

  test('a feature loop link encodes its loop name and primary clicks still navigate', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop with space/Slash', status: 'running' } }),
      ],
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'Linked', stage: 'running', loopName: 'loop with space/Slash' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const anchor = container.querySelector('.feature-loop-link') as HTMLAnchorElement
    expect(anchor).toBeTruthy()
    expect(anchor.getAttribute('href')).toBe('#p1/loop/loop%20with%20space%2FSlash')
    // Primary click navigates via the SPA handler without a full reload.
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()
    expect(location.hash).toBe('#p1/loop/loop%20with%20space%2FSlash')
  })

  test('modified primary clicks on a feature loop link preserve native anchor behavior', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-linked', status: 'running' } }),
      ],
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'Linked', stage: 'running', loopName: 'loop-linked' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const anchor = container.querySelector('.feature-loop-link') as HTMLAnchorElement
    expect(anchor).toBeTruthy()
    // Unmodified primary click → SPA intercepts and prevents the anchor default.
    const primaryEvt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    anchor.dispatchEvent(primaryEvt)
    await flush()
    expect(primaryEvt.defaultPrevented).toBe(true)
    expect(location.hash).toBe('#p1/loop/loop-linked')

    // Restore the group route before verifying modified clicks.
    window.location.hash = '#p1/groups/g-abc'
    await flush()
    for (const init of [
      { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
    ]) {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
      anchor.dispatchEvent(evt)
      await flush()
      // SPA handler must not intercept; the browser keeps native anchor behavior.
      expect(evt.defaultPrevented).toBe(false)
    }
  })

  test('a feature with stage failed renders its error text', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'Boom', stage: 'failed', error: 'explosion' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.feature-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.querySelector('.feature-error')?.textContent).toContain('explosion')
  })

  test('a completed group row exposes both created and completed timestamps; an active row exposes only created', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({ id: 'g-active', group: { groupId: 'g-active', title: 'Active', status: 'running', createdAt: 1700000000000 } }),
        makeGroup({ id: 'g-done', group: { groupId: 'g-done', title: 'Completed', status: 'completed', createdAt: 1700000000000, completedAt: 1700000500000 } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.group-row')) as HTMLElement[]
    const active = rows.find(r => r.querySelector('.group-row-title')?.textContent === 'Active')!
    const completed = rows.find(r => r.querySelector('.group-row-title')?.textContent === 'Completed')!
    expect(active).toBeTruthy()
    expect(completed).toBeTruthy()
    expect(active.querySelector('.group-row-created')).toBeTruthy()
    expect(active.querySelector('.group-row-completed')).toBeFalsy()
    expect(completed.querySelector('.group-row-created')).toBeTruthy()
    expect(completed.querySelector('.group-row-completed')).toBeTruthy()
  })

  test('an interrupted group carries a distinct class from a completed one', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({ id: 'g-int', group: { groupId: 'g-int', title: 'Interrupted', status: 'interrupted' } }),
        makeGroup({ id: 'g-done', group: { groupId: 'g-done', title: 'Completed', status: 'completed', completedAt: 1700000500000 } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = Array.from(container.querySelectorAll('.group-row')) as HTMLElement[]
    expect(rows.length).toBe(2)
    const interrupted = rows.find(r => r.querySelector('.group-row-title')?.textContent === 'Interrupted')!
    const completed = rows.find(r => r.querySelector('.group-row-title')?.textContent === 'Completed')!
    expect(interrupted).toBeTruthy()
    expect(completed).toBeTruthy()
    // Distinct classes: interrupted carries group-row-active (not terminal),
    // completed carries group-row-terminal; status is reflected on data attr.
    expect(interrupted.classList.contains('group-row-terminal')).toBe(false)
    expect(completed.classList.contains('group-row-terminal')).toBe(true)
    expect(interrupted.getAttribute('data-group-status')).toBe('interrupted')
    expect(completed.getAttribute('data-group-status')).toBe('completed')
  })

  test('the Groups count in .section-nav matches the number of groups', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({ id: 'g-a', group: { groupId: 'g-a', title: 'A' } }),
        makeGroup({ id: 'g-b', group: { groupId: 'g-b', title: 'B' } }),
        makeGroup({ id: 'g-c', group: { groupId: 'g-c', title: 'C' } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const navItems = Array.from(container.querySelectorAll('.section-nav-item')) as HTMLElement[]
    const groupsItem = navItems.find(i => i.textContent?.startsWith('Groups'))!
    expect(groupsItem).toBeTruthy()
    expect(groupsItem.querySelector('.section-nav-count')?.textContent).toBe('3')
  })

  test('the Groups count stays at the project total when loop filters match zero loops', async () => {
    window.location.hash = '#p1/groups?q=nomatch-xyz'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running' } }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'completed' } }),
      ],
      groups: [
        makeGroup({ id: 'g-a', group: { groupId: 'g-a', title: 'A' } }),
        makeGroup({ id: 'g-b', group: { groupId: 'g-b', title: 'B' } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // The hash carries the query (matching no loops), but the Groups count
    // reflects the full project, not the filtered loop set.
    expect(location.hash).toBe('#p1/groups?q=nomatch-xyz')
    const navItems = Array.from(container.querySelectorAll('.section-nav-item')) as HTMLElement[]
    const groupsItem = navItems.find(i => i.textContent?.startsWith('Groups'))!
    expect(groupsItem).toBeTruthy()
    expect(groupsItem.querySelector('.section-nav-count')?.textContent).toBe('2')
    // Group rows still render.
    expect(container.querySelectorAll('.group-row').length).toBe(2)
  })

  test('a project with groups but no loops is discoverable in the repo menu and navigable', async () => {
    window.location.hash = ''
    payload = makePayload({
      loops: [],
      groups: [
        makeGroup({ id: 'g-only', group: { groupId: 'g-only', title: 'GroupOnly' } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // No empty state: the project is discoverable via its group.
    expect(container.querySelector('.repo-menu')).toBeTruthy()
    const menuItems = Array.from(container.querySelectorAll('.repo-menu-item')) as HTMLElement[]
    expect(menuItems.length).toBe(1)

    // Selecting the project navigates to the (empty) loops section.
    menuItems[0].click()
    await flush()
    expect(location.hash.startsWith('#p1/loops') || location.hash.startsWith('#p1')).toBe(true)

    // The Groups section is reachable from the group-only project and renders.
    window.location.hash = '#p1/groups'
    await flush()
    const rows = Array.from(container.querySelectorAll('.group-row')) as HTMLElement[]
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.group-row-title')?.textContent).toBe('GroupOnly')
  })

  test('a PRD preview with embedded HTML event handlers is rendered as inert text', async () => {
    window.location.hash = '#p1/groups/g-abc'
    const malicious = '<img src=x onerror="window.__boom=1">text'
    payload = makePayload({
      groups: [
        makeGroup({ group: { groupId: 'g-abc', prdPreview: malicious } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const preview = container.querySelector('.prd-preview') as HTMLElement
    expect(preview).toBeTruthy()
    // No img element is created from the raw HTML.
    expect(preview.querySelector('img')).toBeNull()
    // The payload is rendered as plain text (escaped), not parsed as HTML.
    expect(preview.textContent).toBe(malicious)
    // The event handler never executes.
    expect((window as unknown as { __boom?: number }).__boom).toBeUndefined()
  })

  test('polling a feature completion updates the groups meter without rebuilding rows', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Metered' },
          features: [
            makeFeature({ featureIndex: 0, stage: 'completed' }),
            makeFeature({ featureIndex: 1, stage: 'running' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.group-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.querySelector('.lt-meter-text')!.textContent).toBe('1/2')
    const fillBefore = row.querySelector('.lt-meter-fill') as HTMLElement
    expect(fillBefore.getAttribute('style')).toContain('50%')

    // Same group identity, second feature now completed.
    await poll(makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Metered', completedAt: 1700000500000 },
          features: [
            makeFeature({ featureIndex: 0, stage: 'completed' }),
            makeFeature({ featureIndex: 1, stage: 'completed' }),
          ],
        }),
      ],
    }))

    // Same DOM node (keyed reconcile preserves identity).
    const rowAfter = container.querySelector('.group-row') as HTMLElement
    expect(rowAfter).toBe(row)
    expect(rowAfter.querySelector('.lt-meter-text')!.textContent).toBe('2/2')
    const fillAfter = rowAfter.querySelector('.lt-meter-fill') as HTMLElement
    expect(fillAfter.getAttribute('style')).toContain('100%')
  })

  test('polling a running-to-errored group switches status class and data-group-status', async () => {
    window.location.hash = '#p1/groups'
    payload = makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Boom', status: 'running' },
          features: [
            makeFeature({ featureIndex: 0, stage: 'running' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.group-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.classList.contains('group-row-active')).toBe(true)
    expect(row.classList.contains('group-row-terminal')).toBe(false)
    expect(row.getAttribute('data-group-status')).toBe('running')

    // Same identity, now errored.
    await poll(makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Boom', status: 'errored', error: 'kaboom' },
          features: [
            makeFeature({ featureIndex: 0, stage: 'running' }),
          ],
        }),
      ],
    }))

    const rowAfter = container.querySelector('.group-row') as HTMLElement
    expect(rowAfter).toBe(row)
    expect(rowAfter.classList.contains('group-row-terminal')).toBe(true)
    expect(rowAfter.classList.contains('group-row-active')).toBe(false)
    expect(rowAfter.getAttribute('data-group-status')).toBe('errored')
  })

  test('polling a feature stage and error updates the group detail row in place', async () => {
    window.location.hash = '#p1/groups/g-abc'
    payload = makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Detail' },
          features: [
            makeFeature({ featureIndex: 0, title: 'F0', stage: 'running' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.feature-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.getAttribute('data-stage')).toBe('running')
    expect(row.querySelector('.feature-error')).toBeNull()

    await poll(makePayload({
      groups: [
        makeGroup({
          id: 'g-abc',
          group: { groupId: 'g-abc', title: 'Detail' },
          features: [
            makeFeature({ featureIndex: 0, title: 'F0', stage: 'failed', error: 'crashed' }),
          ],
        }),
      ],
    }))

    const rowAfter = container.querySelector('.feature-row') as HTMLElement
    expect(rowAfter).toBe(row)
    expect(rowAfter.getAttribute('data-stage')).toBe('failed')
    expect(rowAfter.querySelector('.feature-error')?.textContent).toContain('crashed')
  })

  test('primary-clicking a group feature loop link clears filters from the hash', async () => {
    window.location.hash = '#p1/groups/g-abc?status=errored&q=bug'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-linked', status: 'errored' } })],
      groups: [
        makeGroup({
          features: [
            makeFeature({ featureIndex: 0, title: 'Linked', stage: 'running', loopName: 'loop-linked' }),
          ],
        }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const anchor = container.querySelector('.feature-loop-link') as HTMLAnchorElement
    expect(anchor).toBeTruthy()
    expect(anchor.getAttribute('href')).toBe('#p1/loop/loop-linked')
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-linked')
    expect(location.hash).not.toContain('status=')
    expect(location.hash).not.toContain('q=')
  })
})

describe('dashboard App findings and plans sections', () => {
  function makeFinding(over: Record<string, any> = {}): any {
    return {
      projectId: 'p1',
      file: 'a.ts',
      line: 1,
      severity: 'bug',
      description: 'desc',
      scenario: null,
      loopName: 'loop-a',
      sectionIndex: 0,
      createdAt: 1700000000000,
      ...over,
    }
  }

  test('#p1/findings does not render the loops table and renders the findings panel', async () => {
    window.location.hash = '#p1/findings'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, findings: [
          makeFinding({ description: 'a1' }),
          makeFinding({ severity: 'warning', description: 'a2' }),
        ] }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running' } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('table.loop-table')).toBeFalsy()
    expect(container.querySelector('.findings-panel')).toBeTruthy()
    // One block per loop that has findings; loop-b has none so it is omitted.
    const blocks = Array.from(container.querySelectorAll('.findings-loop-block')) as HTMLElement[]
    expect(blocks.length).toBe(1)
    expect(blocks[0].getAttribute('data-loop')).toBe('loop-a')
    expect(blocks[0].querySelectorAll('.finding').length).toBe(2)
    // The panel header count totals findings across loops.
    expect(container.querySelector('.findings-panel-count')?.textContent).toBe('2')
  })

  test('clicking a findings-group loop link navigates to the loop detail', async () => {
    window.location.hash = '#p1/findings'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, findings: [makeFinding()] }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const link = container.querySelector('.findings-loop-link') as HTMLAnchorElement
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('#p1/loop/loop-a')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-a')
    expect(container.querySelector('.loop-detail-header')).toBeTruthy()
  })

  test('#p1/findings with no findings shows an empty state, not the loops table', async () => {
    window.location.hash = '#p1/findings'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'completed' } })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('table.loop-table')).toBeFalsy()
    expect(container.querySelector('.findings-panel')).toBeTruthy()
    expect(container.querySelector('.findings-panel .tab-empty')?.textContent).toContain('No findings')
  })

  test('#p1/plans does not render the loops table and lists loops with plans', async () => {
    window.location.hash = '#p1/plans'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, plan: 'PLAN A' }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running' }, plan: null }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('table.loop-table')).toBeFalsy()
    expect(container.querySelector('.plans-panel')).toBeTruthy()
    const rows = Array.from(container.querySelectorAll('.plan-row')) as HTMLElement[]
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.plan-row-name')?.textContent).toBe('loop-a')
    expect(container.querySelector('.plans-panel-count')?.textContent).toBe('1')
  })

  test('clicking a plan row navigates to the loop detail', async () => {
    window.location.hash = '#p1/plans'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, plan: 'PLAN A' })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.plan-row') as HTMLElement
    expect(row).toBeTruthy()
    row.click()
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-a')
    expect(container.querySelector('.loop-detail-header')).toBeTruthy()
  })

  test('#p1/plans with no plans shows an empty state, not the loops table', async () => {
    window.location.hash = '#p1/plans'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, plan: null })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('table.loop-table')).toBeFalsy()
    expect(container.querySelector('.plans-panel')).toBeTruthy()
    expect(container.querySelector('.plans-panel .tab-empty')?.textContent).toContain('No plans')
  })

  test('navigating from loops to findings via section nav hides the loops table', async () => {
    window.location.hash = '#p1'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'completed' } })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()
    expect(container.querySelector('table.loop-table')).toBeTruthy()

    const navItems = Array.from(container.querySelectorAll('.section-nav-item')) as HTMLElement[]
    const findingsItem = navItems.find(i => i.textContent?.startsWith('Findings'))!
    expect(findingsItem).toBeTruthy()
    findingsItem.click()
    await flush()
    expect(location.hash).toBe('#p1/findings')
    expect(container.querySelector('table.loop-table')).toBeFalsy()
    expect(container.querySelector('.findings-panel')).toBeTruthy()
  })

  test('section-nav findings and plans counts stay at the project total when loop filters match zero', async () => {
    window.location.hash = '#p1/findings?q=nomatch-xyz'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, findings: [makeFinding({ description: 'a1' })], plan: 'PLAN A' }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running' }, findings: [makeFinding({ description: 'b1' }), makeFinding({ description: 'b2' })], plan: 'PLAN B' }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(location.hash).toBe('#p1/findings?q=nomatch-xyz')
    const navItems = Array.from(container.querySelectorAll('.section-nav-item')) as HTMLElement[]
    const findingsItem = navItems.find(i => i.textContent?.startsWith('Findings'))!
    const plansItem = navItems.find(i => i.textContent?.startsWith('Plans'))!
    expect(findingsItem.querySelector('.section-nav-count')?.textContent).toBe('3')
    expect(plansItem.querySelector('.section-nav-count')?.textContent).toBe('2')
    expect(container.querySelectorAll('.findings-loop-block').length).toBe(2)
  })

  test('primary-clicking a findings loop link clears filters from the hash', async () => {
    window.location.hash = '#p1/findings?status=errored&q=bug'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'errored' }, findings: [makeFinding()] })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const link = container.querySelector('.findings-loop-link') as HTMLAnchorElement
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('#p1/loop/loop-a')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-a')
    expect(location.hash).not.toContain('status=')
    expect(location.hash).not.toContain('q=')
    expect(container.querySelector('.loop-detail-header')).toBeTruthy()
  })

  test('primary-clicking a plan row clears filters from the hash', async () => {
    window.location.hash = '#p1/plans?status=completed&q=bug'
    payload = makePayload({
      loops: [makeLoop({ loop: { loopName: 'loop-a', status: 'completed' }, plan: 'PLAN A' })],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const row = container.querySelector('.plan-row') as HTMLElement
    expect(row).toBeTruthy()
    row.click()
    await flush()
    expect(location.hash).toBe('#p1/loop/loop-a')
    expect(location.hash).not.toContain('status=')
    expect(location.hash).not.toContain('q=')
  })

  test('role split surfaces unknown role cost in an other bar', async () => {
    window.location.hash = '#p1/loop/loop-a/usage'
    payload = makePayload({
      dashLoop: {
        usage: {
          loopName: 'loop-a',
          totalCost: 3.5,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalMessageCount: 9,
          byModel: {
            'exec-m': { cost: 2, inputTokens: 80, outputTokens: 15, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 6 },
            'audit-m': { cost: 1, inputTokens: 20, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2 },
            'unknown-m': { cost: 0.5, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
          byRole: {
            code: { cost: 2, inputTokens: 4000, outputTokens: 2000, reasoningTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 160, messageCount: 6 },
            auditor: { cost: 1, inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 40, messageCount: 2 },
            unknown: { cost: 0.5, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 1 },
          },
        },
      },
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const usageBody = container.querySelector('.tab-body[data-tab="usage"]') as HTMLElement
    const roleBlock = Array.from(usageBody.querySelectorAll('.usage-block')).find(b =>
      b.querySelector('.usage-block-title')?.textContent === 'Role split')! as HTMLElement
    const rows = Array.from(roleBlock.querySelectorAll('.usage-model-row')) as HTMLElement[]
    expect(rows.length).toBe(3)
    const names = rows.map(r => r.querySelector('.usage-model-name')?.textContent)
    expect(names).toEqual(['execution', 'auditor', 'other'])
    const costs = rows.map(r => r.querySelector('.usage-model-cost')?.textContent)
    // The three bars reconcile with totalCost ($3.50) — no role's spend is dropped.
    expect(costs).toEqual(['$2.00', '$1.00', '$0.5000'])
    // The execution meta reports both the message count and a token count.
    const execRow = rows.find(r => r.querySelector('.usage-model-name')?.textContent === 'execution')!
    const execMeta = execRow.querySelector('.usage-model-meta')?.textContent ?? ''
    expect(execMeta).toContain('6 msg')
    expect(execMeta).toContain('tok')
    // 4000 + 2000 + 400 = 6400 → "6.4k" via formatTokenCount.
    expect(execMeta).toContain('6.4k tok')
  })
})

describe('dashboard App render-stable node identity', () => {
  function twoRunningLoopsPayload(): any {
    return makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-a', status: 'running', startedAt: 1700000000000 } }),
        makeLoop({ loop: { loopName: 'loop-b', status: 'running', startedAt: 1700000100000 } }),
      ],
    })
  }

  async function clickChip(status: string): Promise<void> {
    const chips = Array.from(container.querySelectorAll('.filter-bar .badge-filter')) as HTMLElement[]
    const chip = chips.find(c => c.textContent?.toLowerCase().startsWith(status))
    expect(chip).toBeTruthy()
    chip!.click()
    await flush()
  }

  async function clickTab(tab: string): Promise<void> {
    const item = container.querySelector(`.tab-item[data-tab="${tab}"]`) as HTMLElement
    expect(item).toBeTruthy()
    item.click()
    await flush()
  }

  test('toggling a status filter off and back on preserves loop-table row node identity', async () => {
    window.location.hash = '#p1'
    payload = twoRunningLoopsPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rowBefore = container.querySelectorAll('.lt-row')[0] as HTMLElement
    expect(rowBefore).toBeTruthy()

    // Both loops are running, so filtering by `running` keeps the same visible
    // set — only the filter value changed. With `sameList` on the visible-loops
    // memo the array reference is stable and LoopTable does not rebuild rows.
    await clickChip('running')
    await clickChip('running')

    const rowAfter = container.querySelectorAll('.lt-row')[0] as HTMLElement
    expect(rowAfter).toBe(rowBefore)
  })

  test('a poll that changes nothing preserves loop-table row node identity', async () => {
    window.location.hash = '#p1'
    payload = twoRunningLoopsPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rowBefore = container.querySelectorAll('.lt-row')[0] as HTMLElement
    expect(rowBefore).toBeTruthy()

    await poll(twoRunningLoopsPayload())

    const rowAfter = container.querySelectorAll('.lt-row')[0] as HTMLElement
    expect(rowAfter).toBe(rowBefore)
  })

  test('switching a loop tab preserves the breadcrumb loop-picker input node', async () => {
    window.location.hash = '#p1/loop/alpha-loop'
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'alpha-loop', status: 'completed', startedAt: 1700000000000, completedAt: 1700000600000 } }),
        makeLoop({ loop: { loopName: 'beta-loop', status: 'running', startedAt: 1700009000000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'gamma-run', status: 'completed', startedAt: 1700003000000, completedAt: 1700004000000 } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const inputBefore = container.querySelector('.loop-picker-input') as HTMLInputElement
    expect(inputBefore).toBeTruthy()

    await clickTab('usage')

    const inputAfter = container.querySelector('.loop-picker-input') as HTMLInputElement
    expect(inputAfter).toBe(inputBefore)
  })

  test('a poll that reorders neighbours keeps loop-nav buttons but targets the current neighbours', async () => {
    // Order (most-recent-first): beta, alpha, gamma. Active loop alpha is at
    // index 1 with total 3; prev targets beta, next targets gamma.
    const initial = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'beta', status: 'running', startedAt: 1700009000000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'alpha', status: 'running', startedAt: 1700005000000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'gamma', status: 'running', startedAt: 1700001000000, completedAt: null } }),
      ],
    })
    window.location.hash = '#p1/loop/alpha'
    payload = initial
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const prevBefore = container.querySelector('.loopnav-prev') as HTMLElement
    const nextBefore = container.querySelector('.loopnav-next') as HTMLElement
    expect(prevBefore).toBeTruthy()
    expect(nextBefore).toBeTruthy()

    // Poll swaps beta and gamma positions; alpha is still at index 1, total 3,
    // so the loopNav memo's equality option preserves the same nav buttons.
    // Their retained callbacks must read the current option set, not the stale
    // one captured when the memo last ran.
    await poll(makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'gamma', status: 'running', startedAt: 1700009500000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'alpha', status: 'running', startedAt: 1700005000000, completedAt: null } }),
        makeLoop({ loop: { loopName: 'beta', status: 'running', startedAt: 1700000500000, completedAt: null } }),
      ],
    }))

    expect(container.querySelector('.loopnav-prev')).toBe(prevBefore)
    expect(container.querySelector('.loopnav-next')).toBe(nextBefore)

    // Current index 2 is now beta (was gamma). A stale closure would open
    // gamma, which is no longer the adjacent loop.
    nextBefore!.click()
    await flush()
    expect(container.querySelector('.ldh-name')?.textContent).toBe('beta')

    // Return to alpha via external hash navigation, then click prev. Current
    // index 0 is now gamma (was beta). A stale closure would open beta.
    window.location.hash = '#p1/loop/alpha'
    window.dispatchEvent(new Event('hashchange'))
    await flush()
    const prevAgain = container.querySelector('.loopnav-prev') as HTMLElement
    expect(prevAgain).toBeTruthy()
    prevAgain!.click()
    await flush()
    expect(container.querySelector('.ldh-name')?.textContent).toBe('gamma')
  })
})

describe('dashboard App bounded list caps', () => {
  function makeCappedLoopsPayload(): any {
    const loops: any[] = []
    for (let i = 0; i < MAX_RENDERED_LOOP_ROWS + 5; i++) {
      loops.push(makeLoop({
        loop: {
          loopName: 'loop-' + i,
          status: 'running',
          startedAt: 1700000000000 + i * 1000,
          completedAt: null,
        },
      }))
    }
    return makePayload({
      loops,
    })
  }

  test('a project with more loops than the cap renders exactly the cap and a notice with the true total', async () => {
    window.location.hash = '#p1'
    payload = makeCappedLoopsPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const rows = container.querySelectorAll('tr.lt-row')
    expect(rows.length).toBe(MAX_RENDERED_LOOP_ROWS)
    const notice = container.querySelector('.list-cap-notice') as HTMLElement
    expect(notice).toBeTruthy()
    const text = notice.querySelector('.list-cap-text')?.textContent ?? ''
    expect(text).toContain(String(MAX_RENDERED_LOOP_ROWS))
    expect(text).toContain(String(MAX_RENDERED_LOOP_ROWS + 5))
    expect(notice.querySelector('.list-cap-show-all')).toBeTruthy()
  })

  test('clicking Show all renders every loop row and removes the notice', async () => {
    window.location.hash = '#p1'
    payload = makeCappedLoopsPayload()
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelectorAll('tr.lt-row').length).toBe(MAX_RENDERED_LOOP_ROWS)

    const showAll = container.querySelector('.list-cap-show-all') as HTMLButtonElement
    expect(showAll).toBeTruthy()
    showAll.click()
    await flush()

    expect(container.querySelectorAll('tr.lt-row').length).toBe(MAX_RENDERED_LOOP_ROWS + 5)
    expect(container.querySelector('.list-cap-notice')).toBeNull()
  })

  test('the findings panel caps total finding rows across loops and reports the true total', async () => {
    window.location.hash = '#p1/findings'
    const loops: any[] = []
    // Two loops, with enough findings together to exceed the cap.
    const perLoop = Math.ceil((MAX_RENDERED_FINDING_ROWS + 10) / 2)
    const total = perLoop * 2
    for (let i = 0; i < 2; i++) {
      const findings: any[] = []
      for (let j = 0; j < perLoop; j++) {
        findings.push({
          projectId: 'p1',
          file: 'a.ts',
          line: 1,
          severity: 'bug',
          description: 'desc',
          scenario: null,
          loopName: 'loop-' + i,
          sectionIndex: 0,
          createdAt: 1700000000000 + j * 1000,
        })
      }
      loops.push(makeLoop({ loop: { loopName: 'loop-' + i, status: 'completed' }, findings }))
    }
    payload = makePayload({ loops })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelectorAll('.finding').length).toBe(MAX_RENDERED_FINDING_ROWS)
    expect(container.querySelector('.findings-panel-count')?.textContent).toBe(String(total))
    const notice = container.querySelector('.findings-panel .list-cap-notice') as HTMLElement
    expect(notice).toBeTruthy()
    expect(notice.querySelector('.list-cap-text')?.textContent ?? '').toContain(String(total))
  })

  test('the loop picker caps rendered options and ArrowUp from the first option wraps to the last rendered one', async () => {
    window.location.hash = '#p1/loop/loop-0'
    const loops: any[] = []
    // loop with the largest startedAt sorts first; give loop-0 the largest so
    // it lands at index 0 of the capped view (initial active = 0).
    for (let i = 0; i < MAX_RENDERED_PICKER_OPTIONS + 20; i++) {
      loops.push(makeLoop({
        loop: {
          loopName: 'loop-' + i,
          // Earlier i gets a later startedAt so 'loop-0' is most recent.
          startedAt: 1700000000000 + (MAX_RENDERED_PICKER_OPTIONS + 20 - i) * 1000,
          completedAt: null,
          status: 'running',
        },
      }))
    }
    payload = makePayload({
      loops,
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    expect(input.value).toBe('loop-0')
    input.focus()
    await flush()

    const menu = container.querySelector('.loop-picker-menu') as HTMLElement
    const options = Array.from(menu.querySelectorAll('.loop-picker-option')) as HTMLElement[]
    expect(options.length).toBe(MAX_RENDERED_PICKER_OPTIONS)
    expect(menu.querySelector('.loop-picker-cap')).toBeTruthy()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await flush()

    const active = menu.querySelector('.loop-picker-option-active') as HTMLElement
    expect(active).toBeTruthy()
    // Wrap landed on the last rendered option.
    expect(active).toBe(options[options.length - 1])
  })

  test('picker option times render from the precomputed label', async () => {
    window.location.hash = '#p1/loop/loop-0'
    const ts = 1700001234000
    payload = makePayload({
      loops: [
        makeLoop({ loop: { loopName: 'loop-0', status: 'running', startedAt: ts, completedAt: null } }),
      ],
    })
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    const input = container.querySelector('.breadcrumb-loop') as HTMLInputElement
    input.focus()
    await flush()

    const when = container.querySelector('.loop-picker-option-when') as HTMLElement
    expect(when).toBeTruthy()
    expect(when.textContent).toBe(fmtTime(ts))
  })
})