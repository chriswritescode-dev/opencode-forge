import { describe, test, expect, afterEach, vi } from 'vitest'
import { renderLoopMachineDiagram } from '../../src/tui/dashboard/machine-diagram'
import type { DiagramRow } from '../../src/tui/dashboard/machine-diagram'
import { recentTransitionRows } from '../../src/tui/dashboard/view-model'
import type { ForgeLoopTransition } from '../../src/host/forge-rpc'
import { makeTransition } from '../helpers/dashboard-fixtures'

function rowText(row: DiagramRow): string {
  return row.map((cell) => cell.text).join('')
}

function diagramText(rows: DiagramRow[]): string {
  return rows.map(rowText).join('\n')
}

function repeats(fromPhase: string, toPhase: string | undefined, count: number, startId: number): ForgeLoopTransition[] {
  return Array.from({ length: count }, (_, i) =>
    makeTransition({ id: startId + i, fromPhase, toPhase }),
  )
}

describe('renderLoopMachineDiagram', () => {
  test('draws the three phases and a terminal box on equal-width rows', () => {
    const rows = renderLoopMachineDiagram({ phase: 'coding', status: 'running', running: true, transitions: [] })
    const text = diagramText(rows)
    expect(text).toContain('coding')
    expect(text).toContain('auditing')
    expect(text).toContain('post_action')
    expect(rows.length).toBe(8)
    const widths = rows.map((row) => rowText(row).length)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBeGreaterThan(60)
  })

  test('prints each edge traversal count on its own edge', () => {
    const transitions = [
      ...repeats('coding', 'auditing', 1, 1),
      ...repeats('auditing', 'post_action', 2, 10),
      ...repeats('auditing', 'coding', 3, 20),
      ...repeats('coding', undefined, 4, 30),
      ...repeats('auditing', undefined, 5, 40),
      ...repeats('post_action', undefined, 6, 50),
    ]
    const rows = renderLoopMachineDiagram({ phase: 'coding', status: 'running', running: true, transitions })
    expect(rowText(rows[1])).toContain(' 1 ▶')
    expect(rowText(rows[1])).toContain(' 2 ▶')
    expect(rowText(rows[2])).toContain('◀ 3 ')
    expect(rowText(rows[3])).toContain('│ 4')
    expect(rowText(rows[3])).toContain('│ 5')
    expect(rowText(rows[3])).toContain('│ 6')
  })

  test('leaves every edge count empty when no transition used that edge', () => {
    const rows = renderLoopMachineDiagram({ phase: 'coding', status: 'completed', running: false, transitions: [] })
    expect(/\d/.test(diagramText(rows))).toBe(false)
  })

  test('collapses terminal transitions onto the matching phase→terminal edge', () => {
    const rows = renderLoopMachineDiagram({
      phase: 'coding',
      status: 'completed',
      running: false,
      transitions: [makeTransition({ fromPhase: 'post_action', toPhase: undefined, transitionKind: 'terminate', status: 'completed' })],
    })
    const stubRow = rowText(rows[3])
    expect(stubRow).toContain('│ 1')
    expect((stubRow.match(/│ 1/g) ?? []).length).toBe(1)
  })

  test('highlights only the current phase box while running', () => {
    const rows = renderLoopMachineDiagram({
      phase: 'auditing',
      status: 'running',
      running: true,
      transitions: [],
    })
    const highlighted = rows.flatMap((row) => row).filter((cell) => cell.highlight)
    expect(highlighted).toHaveLength(3)
    const text = highlighted.map((cell) => cell.text).join('')
    expect(text).toContain('auditing')
    expect(text).not.toContain('coding')
    expect(text).not.toContain('post_action')
  })

  test('highlights nothing when the loop is not running', () => {
    const rows = renderLoopMachineDiagram({
      phase: 'auditing',
      status: 'completed',
      running: false,
      transitions: [],
    })
    expect(rows.flatMap((row) => row).filter((cell) => cell.highlight)).toEqual([])
  })

  test('highlights nothing for a phase this diagram does not draw', () => {
    const rows = renderLoopMachineDiagram({
      phase: 'final_auditing',
      status: 'running',
      running: true,
      transitions: [],
    })
    expect(rows.flatMap((row) => row).filter((cell) => cell.highlight)).toEqual([])
  })

  test('labels the terminal box with the status only when not running', () => {
    const completed = renderLoopMachineDiagram({
      phase: 'post_action',
      status: 'completed',
      running: false,
      transitions: [],
    })
    expect(rowText(completed[6])).toContain('completed')

    const running = renderLoopMachineDiagram({
      phase: 'coding',
      status: 'running',
      running: true,
      transitions: [],
    })
    expect(diagramText(running)).not.toContain('running')
    expect(rowText(running[6]).replace(/[│┌┐└┘─]/g, '').trim()).toBe('')
  })

  test('ignores transitions for phases this build does not draw', () => {
    const rows = renderLoopMachineDiagram({
      phase: 'completed',
      status: 'completed',
      running: false,
      transitions: [
        makeTransition({ id: 1, fromPhase: 'auditing', toPhase: 'final_auditing' }),
        makeTransition({ id: 2, fromPhase: 'final_auditing', toPhase: 'final_audit_fix' }),
        makeTransition({ id: 3, fromPhase: 'final_audit_fix', toPhase: undefined, transitionKind: 'terminate' }),
      ],
    })
    const text = diagramText(rows)
    expect(text).not.toContain('final')
    expect(/\d/.test(text)).toBe(false)
  })
})

describe('recentTransitionRows', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function chain(length: number): ForgeLoopTransition[] {
    return Array.from({ length }, (_, i) =>
      makeTransition({
        id: i + 1,
        eventType: `evt-${i + 1}`,
        createdAt: 1_700_000_000_000 + (i + 1) * 1000,
      }),
    )
  }

  test('returns the newest 20 rows newest first', () => {
    const rows = recentTransitionRows(chain(105))
    expect(rows).toHaveLength(20)
    expect(rows[0].eventType).toBe('evt-105')
    expect(rows[19].eventType).toBe('evt-86')
  })

  test('honours an explicit limit and returns nothing for a non-positive one', () => {
    expect(recentTransitionRows(chain(5), 2).map((r) => r.eventType)).toEqual(['evt-5', 'evt-4'])
    expect(recentTransitionRows(chain(5), 0)).toEqual([])
  })

  test('shows the destination phase for phase rows and the status for terminal rows', () => {
    const rows = recentTransitionRows([
      makeTransition({ id: 1, fromPhase: 'coding', toPhase: 'auditing' }),
      makeTransition({ id: 2, fromPhase: 'post_action', toPhase: undefined, transitionKind: 'terminate', status: 'completed' }),
    ])
    expect(rows[0].flow).toBe('post_action → completed')
    expect(rows[1].flow).toBe('coding → auditing')
  })

  test('formats each timestamp relative to now', () => {
    vi.useFakeTimers()
    const now = new Date('2024-06-15T12:00:00Z').getTime()
    vi.setSystemTime(now)
    const rows = recentTransitionRows([makeTransition({ createdAt: now - 120_000 })])
    expect(rows[0].time).toBe('2m ago')
  })
})
