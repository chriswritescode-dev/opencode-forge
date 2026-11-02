import type { ForgeLoopTransition } from '../../host/forge-rpc'

export interface DiagramCell {
  text: string
  highlight?: boolean
}

export type DiagramRow = DiagramCell[]

interface PhaseNode {
  phase: string
  label: string
  x: number
}

const NODE_WIDTH = 14
const NODE_GAP = 16

const NODES: readonly PhaseNode[] = [
  { phase: 'coding', label: 'coding', x: 0 },
  { phase: 'auditing', label: 'auditing', x: NODE_WIDTH + NODE_GAP },
  { phase: 'post_action', label: 'post_action', x: (NODE_WIDTH + NODE_GAP) * 2 },
]

const DIAGRAM_WIDTH = NODES[NODES.length - 1].x + NODE_WIDTH

const EDGE_KEYS = [
  'coding→auditing',
  'auditing→post_action',
  'auditing→coding',
  'coding→terminal',
  'auditing→terminal',
  'post_action→terminal',
] as const

const EDGE_KEY_SET: ReadonlySet<string> = new Set(EDGE_KEYS)

function edgeKeyFor(t: ForgeLoopTransition): string {
  if (t.toPhase == null) return t.fromPhase + '→terminal'
  return t.fromPhase + '→' + t.toPhase
}

function cell(text: string, highlight: boolean): DiagramCell {
  return highlight ? { text, highlight: true } : { text }
}

function boxTop(highlight: boolean): DiagramCell {
  return cell('┌' + '─'.repeat(NODE_WIDTH - 2) + '┐', highlight)
}

function boxMiddle(label: string, highlight: boolean): DiagramCell {
  const inner = NODE_WIDTH - 2
  const left = Math.floor((inner - label.length) / 2)
  return cell('│' + ' '.repeat(left) + label + ' '.repeat(inner - left - label.length) + '│', highlight)
}

function boxBottom(highlight: boolean): DiagramCell {
  return cell('└' + '─'.repeat(NODE_WIDTH - 2) + '┘', highlight)
}

function arrowRight(count: number, width: number): string {
  if (count <= 0) return '─'.repeat(width - 1) + '▶'
  const digits = String(count)
  const lineWidth = width - digits.length - 3
  if (lineWidth < 1) return digits + ' ▶'
  return '─'.repeat(lineWidth) + ' ' + digits + ' ▶'
}

function arrowLeft(count: number, width: number): string {
  if (count <= 0) return '◀' + '─'.repeat(width - 1)
  const digits = String(count)
  const lineWidth = width - digits.length - 3
  if (lineWidth < 1) return '◀ ' + digits
  return '◀ ' + digits + ' ' + '─'.repeat(lineWidth)
}

function verticalRow(marks: readonly { x: number; char: string; count?: number }[]): DiagramRow {
  const chars = Array.from({ length: DIAGRAM_WIDTH }, () => ' ')
  for (const mark of marks) {
    chars[mark.x] = mark.char
    if (mark.count && mark.count > 0) {
      const digits = String(mark.count)
      chars[mark.x + 1] = ' '
      for (let i = 0; i < digits.length; i++) chars[mark.x + 2 + i] = digits[i]
    }
  }
  return [{ text: chars.join('') }]
}

function padRows(rows: DiagramRow[]): DiagramRow[] {
  return rows.map((row) => {
    const width = row.reduce((sum, c) => sum + c.text.length, 0)
    if (width >= DIAGRAM_WIDTH) return row
    return [...row, { text: ' '.repeat(DIAGRAM_WIDTH - width) }]
  })
}

/**
 * Fixed box-drawing view of the loop state machine. Edge counts use the same
 * `fromPhase→toPhase` keys as the web graph, with terminal rows collapsing onto
 * `fromPhase→terminal`; transitions for phases this view does not draw are
 * ignored. The terminal box is labelled with the loop status only when the
 * loop is not running.
 */
export function renderLoopMachineDiagram(input: {
  phase: string
  status: string
  running: boolean
  transitions: readonly ForgeLoopTransition[]
}): DiagramRow[] {
  const counts = new Map<string, number>()
  for (const t of input.transitions) {
    const key = edgeKeyFor(t)
    if (!EDGE_KEY_SET.has(key)) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const activeIndex = input.running ? NODES.findIndex((node) => node.phase === input.phase) : -1
  const highlighted = (index: number) => index === activeIndex
  const count = (key: string) => counts.get(key) ?? 0

  const rows: DiagramRow[] = []
  rows.push([
    boxTop(highlighted(0)),
    { text: ' '.repeat(NODE_GAP) },
    boxTop(highlighted(1)),
    { text: ' '.repeat(NODE_GAP) },
    boxTop(highlighted(2)),
  ])
  rows.push([
    boxMiddle(NODES[0].label, highlighted(0)),
    { text: arrowRight(count('coding→auditing'), NODE_GAP) },
    boxMiddle(NODES[1].label, highlighted(1)),
    { text: arrowRight(count('auditing→post_action'), NODE_GAP) },
    boxMiddle(NODES[2].label, highlighted(2)),
  ])
  rows.push([
    boxBottom(highlighted(0)),
    { text: arrowLeft(count('auditing→coding'), NODE_GAP) },
    boxBottom(highlighted(1)),
    { text: ' '.repeat(NODE_GAP) },
    boxBottom(highlighted(2)),
  ])

  const centers = NODES.map((node) => node.x + Math.floor(NODE_WIDTH / 2))
  rows.push(verticalRow([
    { x: centers[0], char: '│', count: count('coding→terminal') },
    { x: centers[1], char: '│', count: count('auditing→terminal') },
    { x: centers[2], char: '│', count: count('post_action→terminal') },
  ]))
  rows.push(verticalRow([
    { x: centers[0], char: '▼' },
    { x: centers[1], char: '▼' },
    { x: centers[2], char: '▼' },
  ]))

  const terminalText = input.running ? '' : input.status
  rows.push([{ text: '┌' + '─'.repeat(DIAGRAM_WIDTH - 2) + '┐' }])
  rows.push([{ text: '│ ' + terminalText + ' '.repeat(Math.max(0, DIAGRAM_WIDTH - 3 - terminalText.length)) + '│' }])
  rows.push([{ text: '└' + '─'.repeat(DIAGRAM_WIDTH - 2) + '┘' }])

  return padRows(rows)
}
