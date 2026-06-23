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
let sessionsPayload: any
let transcriptPayload: any
let intervalFn: (() => void | Promise<void>) | null
let dispose: (() => void) | null
let container: HTMLDivElement

let esOnMessage: ((e: any) => void) | null
let esClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  payload = makePayload()
  sessionsPayload = null
  transcriptPayload = null
  intervalFn = null
  dispose = null
  esOnMessage = null
  esClose = vi.fn()
  ;(globalThis as any).marked = { parse: (s: string) => `<p>${s}</p>` }
  vi.stubGlobal('setInterval', ((fn: () => void) => {
    intervalFn = fn
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  vi.stubGlobal('clearInterval', (() => {}) as typeof clearInterval)
  vi.stubGlobal('EventSource', class {
    url: string
    constructor(url: string) { this.url = url }
    set onmessage(handler: ((e: any) => void) | null) { esOnMessage = handler }
    get onmessage() { return esOnMessage }
    close() { esClose() }
  } as unknown as typeof EventSource)
  ;(globalThis as any).fetch = vi.fn(async (url: string) => {
    if (url.startsWith('/api/opencode/sessions/')) {
      // Transcript endpoint (has session ID path)
      return {
        json: async () => transcriptPayload ?? {
          generatedAt: Date.now(),
          available: false,
          sessionId: 'unknown',
          entries: [],
        },
      }
    }
    if (url.startsWith('/api/opencode/sessions')) {
      // Sessions list endpoint
      return {
        json: async () => sessionsPayload ?? {
          generatedAt: Date.now(),
          available: false,
          sessions: [],
        },
      }
    }
    return { json: async () => payload }
  })
  window.location.hash = '#p1/loop-a'
  container = document.createElement('div')
  document.body.appendChild(container)
})

function makeTranscriptPayload(over: Record<string, any> = {}): any {
  return {
    generatedAt: Date.now(),
    available: true,
    sessionId: 'ses_001',
    entries: [
      {
        messageId: 'm1',
        role: 'user',
        type: 'text',
        text: 'Hello world',
        toolName: null,
        toolTitle: null,
        toolStatus: null,
        timeCreated: 1700000000000,
      },
      {
        messageId: 'm2',
        role: 'assistant',
        type: 'tool',
        text: null,
        toolName: 'read_file',
        toolTitle: 'Read src/index.ts',
        toolStatus: 'success',
        timeCreated: 1700000100000,
      },
    ],
    ...over,
  }
}

function makeSessionsPayload(over: Record<string, any> = {}): any {
  return {
    generatedAt: Date.now(),
    available: true,
    sessions: [
      {
        id: 'ses_001',
        title: 'Add dark mode',
        directory: '/projects/app',
        projectName: 'app-project',
        worktree: null,
        agent: 'code',
        modelId: 'gpt-4',
        providerId: 'openai',
        cost: 0.1234,
        tokensInput: 5000,
        tokensOutput: 1200,
        tokensReasoning: 200,
        tokensCacheRead: 100,
        tokensCacheWrite: 50,
        timeCreated: 1700000000000,
        timeUpdated: 1700000500000,
      },
      {
        id: 'ses_002',
        title: null,
        directory: '/projects/other',
        projectName: null,
        worktree: null,
        agent: 'code',
        modelId: 'claude-3',
        providerId: 'anthropic',
        cost: 0.0567,
        tokensInput: 2000,
        tokensOutput: 800,
        tokensReasoning: 100,
        tokensCacheRead: 50,
        tokensCacheWrite: 20,
        timeCreated: 1700001000000,
        timeUpdated: 1700001500000,
      },
    ],
    ...over,
  }
}

afterEach(() => {
  dispose?.()
  container.remove()
  window.location.hash = ''
  vi.unstubAllGlobals()
  delete (globalThis as any).marked
  delete (globalThis as any).fetch
  delete (globalThis as any).EventSource
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

  test('Sessions view renders project sidebar and filtered session list', async () => {
    sessionsPayload = makeSessionsPayload()
    window.location.hash = '#sessions'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Toggle tabs should render
    const toggleTabs = container.querySelectorAll('.view-tab')
    expect(toggleTabs.length).toBeGreaterThanOrEqual(2)

    const sessionsTab = Array.from(toggleTabs).find(
      (el) => el.textContent === 'Sessions',
    )
    expect(sessionsTab).toBeTruthy()
    expect(sessionsTab!.classList.contains('view-tab-active')).toBe(true)
    expect(sessionsTab!.getAttribute('aria-selected')).toBe('true')

    // Project sidebar should be rendered
    const sidebar = container.querySelector('.session-project-sidebar')
    expect(sidebar).toBeTruthy()

    // Two project nav items, one per group
    const navItems = sidebar!.querySelectorAll('.session-project-nav-item')
    expect(navItems.length).toBe(2)

    // First project (app-project) is selected by default
    expect(navItems[0].classList.contains('selected')).toBe(true)
    expect(navItems[0].querySelector('.session-project-nav-name')!.textContent).toBe('app-project')
    expect(navItems[0].querySelector('.session-project-nav-count')!.textContent).toBe('1')

    // Second project (other) is not selected
    expect(navItems[1].classList.contains('selected')).toBe(false)
    expect(navItems[1].querySelector('.session-project-nav-name')!.textContent).toBe('other')
    expect(navItems[1].querySelector('.session-project-nav-count')!.textContent).toBe('1')

    // Only the selected project's session rows are visible (app-project → ses_001)
    const rows = container.querySelectorAll('.session-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Add dark mode')
    expect(rows[0].textContent).toContain('app-project')
    expect(rows[0].textContent).toContain('gpt-4')
    expect(rows[0].textContent).toContain('$0.1234')
  })

  test('Sessions view shows unavailable message when no sessions data', async () => {
    sessionsPayload = { generatedAt: Date.now(), available: false, sessions: [] }
    window.location.hash = '#sessions'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.textContent).toContain('Sessions data unavailable')
  })

  test('opening a session renders transcript with markdown text and tool entries', async () => {
    sessionsPayload = makeSessionsPayload()
    transcriptPayload = makeTranscriptPayload()
    window.location.hash = '#sessions'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Only the selected project's session row is visible initially
    const rows = container.querySelectorAll('.session-row')
    expect(rows.length).toBe(1)
    ;(rows[0] as HTMLElement).click()
    await flush()

    // Transcript view should be rendered
    const transcriptView = container.querySelector('.transcript-view')
    expect(transcriptView).toBeTruthy()

    // Back link should be present
    expect(transcriptView!.textContent).toContain('Back to sessions')

    // Text entry: rendered as markdown (HTML, not escaped text)
    const markdownContent = container.querySelector('.transcript-text .markdown-content')
    expect(markdownContent).toBeTruthy()
    expect(markdownContent!.innerHTML).toContain('Hello world')
    expect(markdownContent!.querySelector('p')).toBeTruthy()
    expect(markdownContent!.querySelector('p')!.textContent).toBe('Hello world')

    // Tool entry: rendered as transcript-tool with name/title/status
    const toolEntry = container.querySelector('.transcript-tool')
    expect(toolEntry).toBeTruthy()
    expect(toolEntry!.textContent).toContain('read_file')
    expect(toolEntry!.textContent).toContain('Read src/index.ts')
    expect(toolEntry!.textContent).toContain('success')
  })

  test('back from transcript returns to session list', async () => {
    sessionsPayload = makeSessionsPayload()
    transcriptPayload = makeTranscriptPayload()
    window.location.hash = '#sessions/ses_001'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Should be on transcript view
    expect(container.querySelector('.transcript-view')).toBeTruthy()

    // Click back
    const backLink = container.querySelector('.back-to-loops') as HTMLElement
    expect(backLink).toBeTruthy()
    backLink.click()
    await flush()

    // Should be back on session list
    expect(container.querySelector('.transcript-view')).toBeFalsy()
    expect(container.querySelector('.session-list')).toBeTruthy()
  })

  test('clicking a different project in sidebar switches visible sessions', async () => {
    sessionsPayload = makeSessionsPayload()
    window.location.hash = '#sessions'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Default: app-project selected, shows ses_001
    let rows = container.querySelectorAll('.session-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Add dark mode')

    // Click the second project nav item (other)
    const navItemsBefore = container.querySelectorAll('.session-project-nav-item')
    expect(navItemsBefore.length).toBe(2)
    ;(navItemsBefore[1] as HTMLElement).click()
    await flush()

    // Re-query nav items after re-render
    const navItemsAfter = container.querySelectorAll('.session-project-nav-item')
    expect(navItemsAfter.length).toBe(2)
    // app-project nav item should no longer be selected
    expect(navItemsAfter[0].classList.contains('selected')).toBe(false)
    // other nav item should now be selected
    expect(navItemsAfter[1].classList.contains('selected')).toBe(true)

    rows = container.querySelectorAll('.session-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('/projects/other')
  })

  test('navigating to #sessions/sessionId selects the correct project and shows transcript', async () => {
    sessionsPayload = makeSessionsPayload()
    transcriptPayload = makeTranscriptPayload({ sessionId: 'ses_002' })
    window.location.hash = '#sessions/ses_002'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Transcript view should be rendered for ses_002
    const transcriptView = container.querySelector('.transcript-view')
    expect(transcriptView).toBeTruthy()
    expect(transcriptView!.textContent).toContain('Back to sessions')

    // Sidebar is not rendered while viewing a transcript, so verify project
    // selection after going back to the session list.
    const backLink = container.querySelector('.back-to-loops') as HTMLElement
    expect(backLink).toBeTruthy()
    backLink.click()
    await flush()

    // Should return to session list with sidebar rendered
    expect(container.querySelector('.transcript-view')).toBeFalsy()

    // The containing project (other) should be selected in the sidebar
    const navItems = container.querySelectorAll('.session-project-nav-item')
    expect(navItems.length).toBe(2)
    // other is the second nav item (sorted alphabetically: app-project first)
    expect(navItems[1].classList.contains('selected')).toBe(true)
    expect(navItems[1].querySelector('.session-project-nav-name')!.textContent).toBe('other')

    // Session list shows only sessions from the other project
    const rows = container.querySelectorAll('.session-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('/projects/other')
  })

  test('activity events render via EventSource', async () => {
    sessionsPayload = makeSessionsPayload()
    window.location.hash = '#sessions'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Simulate an incoming activity event
    expect(esOnMessage).toBeTruthy()
    const fakeEvent = { data: JSON.stringify({ type: 'session.updated', sessionId: 'ses_001', title: 'Fix bug', directory: '/proj', time: Date.now() }) }
    esOnMessage!(fakeEvent)
    await flush()

    // Activity row should be rendered
    const activityRow = container.querySelector('.activity-row')
    expect(activityRow).toBeTruthy()
    expect(activityRow!.textContent).toContain('session.updated')
    expect(activityRow!.textContent).toContain('Fix bug')
    // Directory renders as a project label (trailing path segment).
    const project = activityRow!.querySelector('.activity-project')
    expect(project).toBeTruthy()
    expect(project!.textContent).toBe('proj')
  })

  test('totals bar reflects updated counts after a poll', async () => {
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 1')

    await poll(makePayload({ loop: { status: 'completed' }, totals: { running: 0, completed: 1 } }))

    expect(container.querySelector('.totals')?.textContent).toContain('Running: 0')
    expect(container.querySelector('.totals')?.textContent).toContain('Completed: 1')
  })

  test('switching from transcript to loops and back to sessions shows session list', async () => {
    sessionsPayload = makeSessionsPayload()
    transcriptPayload = makeTranscriptPayload({ sessionId: 'ses_002' })
    window.location.hash = '#sessions/ses_002'
    dispose = render(() => App() as unknown as Element, container)
    await flush()

    // Should be on transcript view initially
    expect(container.querySelector('.transcript-view')).toBeTruthy()

    // Click the Loops tab
    const loopsTab = Array.from(container.querySelectorAll('.view-tab')).find(
      (el) => el.textContent === 'Loops',
    ) as HTMLElement
    expect(loopsTab).toBeTruthy()
    loopsTab.click()
    await flush()

    // Transcript should no longer be rendered
    expect(container.querySelector('.transcript-view')).toBeFalsy()

    // Click the Sessions tab
    const sessionsTab = Array.from(container.querySelectorAll('.view-tab')).find(
      (el) => el.textContent === 'Sessions',
    ) as HTMLElement
    expect(sessionsTab).toBeTruthy()
    sessionsTab.click()
    await flush()

    // Should be back on session list, not a stale transcript
    expect(container.querySelector('.transcript-view')).toBeFalsy()
    expect(container.querySelector('.session-list')).toBeTruthy()
  })
})
