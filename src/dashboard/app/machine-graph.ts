import html from 'solid-js/html'
import { createMemo } from 'solid-js'
import { formatRelativeTime } from './helpers'
import type { LoopRow, LoopTransitionRow } from './types'

/**
 * Live state-machine canvas: a fixed-layout SVG of the three loop phases plus
 * a conditional terminal node, with the current phase highlighted and
 * per-edge traversal counts fed by `loop.transitions`. Below the SVG, a
 * compact transition history list.
 *
 * Like the rest of the dashboard app this uses `solid-js/html` (no JSX) and
 * reactive thunks for every dynamic field so the whole subtree is built once
 * per selected loop and survives polls — only attributes/text re-bind in
 * place, preserving scroll position and node identity.
 */

interface MgNode {
  phase: LoopRow['phase']
  label: string
  cx: number
  cy: number
}

/** Phase nodes left-to-right; the terminal node sits centred below the row. */
const PHASE_NODES: MgNode[] = [
  { phase: 'coding', label: 'coding', cx: 100, cy: 60 },
  { phase: 'auditing', label: 'auditing', cx: 290, cy: 60 },
  { phase: 'post_action', label: 'post_action', cx: 480, cy: 60 },
]

const NODE_W = 110
const NODE_H = 36
const TERMINAL_CX = 290
const TERMINAL_CY = 160

interface MgEdge {
  key: string
  d: string
  labelX: number
  labelY: number
}

/**
 * Fixed-layout edges. Each `key` ("fromPhase→toPhase") matches a key built by
 * the counts memo over `props.transitions()`:
 *   - non-terminal rows: `${fromPhase}→${toPhase}`
 *   - terminal rows (toPhase is null): `${fromPhase}→terminal`
 * Every persisted transition whose phases this build still renders finds a
 * matching count label. A persisted row for a phase this build no longer shows
 * (historical `final_auditing` / `final_audit_fix` rows) is counted under a key
 * no SVG group asks for, so the graph renders without that edge instead of
 * drawing a dangling one.
 */
const EDGES: MgEdge[] = [
  { key: 'coding→auditing', d: 'M 155 60 L 235 60', labelX: 195, labelY: 52 },
  { key: 'auditing→post_action', d: 'M 345 60 L 425 60', labelX: 385, labelY: 52 },
  { key: 'auditing→coding', d: 'M 290 42 Q 195 14 100 42', labelX: 195, labelY: 18 },
  { key: 'coding→terminal', d: 'M 130 78 L 272 142', labelX: 201, labelY: 102 },
  { key: 'auditing→terminal', d: 'M 290 78 L 290 142', labelX: 317, labelY: 112 },
  { key: 'post_action→terminal', d: 'M 450 78 L 308 142', labelX: 379, labelY: 102 },
]

/**
 * Visual edge-count key for a persisted transition row. Terminal rows
 * (`toPhase === null`, recorded by `terminateLoop`) collapse onto the shared
 * `terminal` visual target so a terminate from any phase lands on the matching
 * phase→terminal edge.
 */
function edgeKeyFor(t: LoopTransitionRow): string {
  if (t.toPhase === null) return t.fromPhase + '→terminal'
  return t.fromPhase + '→' + t.toPhase
}

/**
 * Human-readable flow target for the history list. Terminal rows show the
 * resulting status (e.g. "completed"); phase rows show the destination phase
 * exactly as persisted, including phases this build no longer renders.
 */
function flowTargetFor(t: LoopTransitionRow): string {
  return t.toPhase ?? t.status ?? ''
}

function svgChild<T extends SVGElement>(template: Node | Node[]): T {
  const root = Array.isArray(template) ? template[0] : template
  const child = root instanceof SVGSVGElement ? root.firstElementChild : null
  if (!(child instanceof SVGElement)) throw new Error('Expected an SVG child')
  return child as T
}

export function LoopMachineGraph(props: {
  loop: () => LoopRow
  transitions: () => LoopTransitionRow[]
}) {
  const lp = () => props.loop()
  const isRunning = createMemo(() => lp().status === 'running')

  /**
   * Per-edge traversal counts, keyed by `edgeKeyFor`. Recomputed when the
   * transitions array changes; the edge label thunks below read this memo so
   * the counts update in place without rebuilding the SVG.
   */
  const counts = createMemo(() => {
    const m = new Map<string, number>()
    for (const t of props.transitions()) {
      const key = edgeKeyFor(t)
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  })

  const edges = EDGES.map((edge) =>
    svgChild<SVGGElement>(html`<svg>
      <g class="mg-edge" data-edge-key=${edge.key}>
        <path class="mg-edge-path" d=${edge.d} marker-end="url(#mg-arrow)"></path>
        <text class="mg-edge-label" x=${edge.labelX} y=${edge.labelY} text-anchor="middle">${() => {
          const n = counts().get(edge.key)
          return n ? String(n) : ''
        }}</text>
      </g>
    </svg>`),
  )

  const phaseNodes = PHASE_NODES.map((node) => {
    const rx = node.cx - NODE_W / 2
    const ry = node.cy - NODE_H / 2
    return svgChild<SVGGElement>(html`<svg>
      <g class=${() =>
        'mg-node' +
        (lp().phase === node.phase && isRunning() ? ' mg-node-active' : '')}>
        <rect x=${rx} y=${ry} width=${NODE_W} height=${NODE_H} rx="6"></rect>
        <text class="mg-node-label" x=${node.cx} y=${node.cy} text-anchor="middle" dominant-baseline="middle">${node.label}</text>
      </g>
    </svg>`)
  })

  const terminalNode = svgChild<SVGGElement>(html`<svg>
    <g class="mg-terminal">
      <rect x=${TERMINAL_CX - NODE_W / 2} y=${TERMINAL_CY - NODE_H / 2} width=${NODE_W} height=${NODE_H} rx="6"></rect>
      <text class="mg-terminal-label" x=${TERMINAL_CX} y=${TERMINAL_CY} text-anchor="middle" dominant-baseline="middle">${() => lp().status}</text>
    </g>
  </svg>`)

  return html`<div class="mg-graph">
    <svg class="mg-svg" viewBox="0 0 580 200" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="mg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg-muted)"></path>
        </marker>
      </defs>

      ${edges}
      ${phaseNodes}
      ${() => (isRunning() ? '' : terminalNode)}
    </svg>

    <div class="mg-history">
      <div class="mg-history-title">Transition history</div>
      <div class="mg-history-list">
        ${() =>
          props
            .transitions()
            .slice(-20)
            .reverse()
            .map(
              (t) =>
                html`<div class="mg-history-row">
                  <span class="mg-history-event">${t.eventType}</span>
                  <span class="mg-history-flow">${t.fromPhase} → ${flowTargetFor(t)}</span>
                  <span class="mg-history-time">${formatRelativeTime(t.createdAt)}</span>
                </div>`,
            )}
      </div>
    </div>
  </div>`
}
