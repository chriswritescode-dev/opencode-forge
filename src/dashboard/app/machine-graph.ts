import html from 'solid-js/html'
import { createMemo } from 'solid-js'
import { formatRelativeTime } from './helpers'
import type { LoopRow, LoopTransitionRow } from './types'

// ── Live state-machine canvas ────────────────────────────────────────────
//
// A fixed-layout SVG of the five loop phases plus a conditional terminal
// node, with the current phase highlighted and per-edge traversal counts fed
// by `loop.transitions`. Below the SVG, a compact transition history list.
//
// Like the rest of the dashboard app this uses `solid-js/html` (no JSX) and
// reactive thunks for every dynamic field so the whole subtree is built once
// per selected loop and survives polls — only attributes/text re-bind in
// place, preserving scroll position and node identity.

interface MgNode {
  phase: LoopRow['phase']
  label: string
  cx: number
  cy: number
}

// coding → auditing → final_auditing → post_action left-to-right;
// final_audit_fix sits below final_auditing; the terminal node sits below
// post_action on the bottom row so every phase has a clean diagonal to it.
const PHASE_NODES: MgNode[] = [
  { phase: 'coding', label: 'coding', cx: 70, cy: 60 },
  { phase: 'auditing', label: 'auditing', cx: 220, cy: 60 },
  { phase: 'final_auditing', label: 'final_auditing', cx: 370, cy: 60 },
  { phase: 'post_action', label: 'post_action', cx: 520, cy: 60 },
  { phase: 'final_audit_fix', label: 'final_audit_fix', cx: 370, cy: 160 },
]

const NODE_W = 110
const NODE_H = 36
const TERMINAL_CX = 655
const TERMINAL_CY = 160

interface MgEdge {
  key: string
  d: string
  labelX: number
  labelY: number
}

// Fixed-layout edges. Each `key` ("fromPhase→toPhase") matches a key built by
// the counts memo over `props.transitions()`:
//   - non-terminal rows: `${fromPhase}→${toPhase}`
//   - terminal rows (toPhase is null): `${fromPhase}→terminal`
// so every persisted transition has a corresponding SVG edge and a count
// label can be looked up directly. Curved back-edges use a quadratic Bézier
// control point above the node row to keep them visually distinct from the
// forward arrows; terminal diagonals run below the row to the terminal node;
// the two recovery edges between coding and final_audit_fix curve through the
// empty space below the top row and below the bottom row respectively.
const EDGES: MgEdge[] = [
  // Forward chain along the top row.
  { key: 'coding→auditing', d: 'M 125 60 L 165 60', labelX: 145, labelY: 52 },
  { key: 'auditing→final_auditing', d: 'M 275 60 L 315 60', labelX: 295, labelY: 52 },
  { key: 'final_auditing→post_action', d: 'M 425 60 L 465 60', labelX: 445, labelY: 52 },
  // Back-edges above the row.
  {
    key: 'auditing→coding',
    d: 'M 220 42 Q 145 14 70 42',
    labelX: 145,
    labelY: 18,
  },
  // Goal-audit clear path: auditing skips final_auditing straight to post_action.
  {
    key: 'auditing→post_action',
    d: 'M 220 42 Q 370 8 520 42',
    labelX: 370,
    labelY: 16,
  },
  // Amendment revert: a plan amendment appended sections while the loop was in
  // final_auditing, so it steps back to auditing to execute them (recorded via
  // the setPhase wrapper as eventType 'set-phase' in runtime.runFinalAuditPhase).
  {
    key: 'final_auditing→auditing',
    d: 'M 315 42 Q 295 24 275 42',
    labelX: 295,
    labelY: 30,
  },
  // Recovery back-edge across the whole top row: persisted by
  // `rotateToCodingAfterAuditFailure` (runtime.ts:617-635) when a
  // `final_auditing` session aborts (eventType 'final-audit-session-aborted'
  // at runtime.ts:2094) or errors before any assistant response (eventType
  // 'final-audit-session-error' at runtime.ts:2151). Recorded with
  // transitionKind 'error-recovery' AFTER the persisted phase commit to
  // coding, so the row shows `final_auditing → coding`. Curves below the
  // top row through the empty mid-band to stay distinct from the upper
  // back-edges and from the `coding↔final_audit_fix` recovery curves.
  {
    key: 'final_auditing→coding',
    d: 'M 370 78 C 370 110 145 110 70 78',
    labelX: 220,
    labelY: 102,
  },
  // Vertical edges between final_auditing and final_audit_fix.
  {
    key: 'final_auditing→final_audit_fix',
    d: 'M 370 78 L 370 142',
    labelX: 358,
    labelY: 112,
  },
  {
    key: 'final_audit_fix→final_auditing',
    d: 'M 415 142 L 415 78',
    labelX: 442,
    labelY: 116,
  },
  // Recovery edges between final_audit_fix and coding.
  // `final_audit_fix→coding` is persisted by the final-audit-fix prompt-error
  // rollback (runtime.ts: recordTransition with transitionKind 'error-recovery')
  // and by restart of a stopped final_audit_fix loop (the restart row goes
  // from the prior persisted phase into the coding restart phase).
  // `coding→final_audit_fix` is the symmetric visual edge: no runtime path
  // emits it today, but the public `setPhase` wrapper can record any phase pair,
  // so rendering the edge keeps a persisted row from ever being silently
  // dropped (counts default to empty when absent).
  {
    key: 'coding→final_audit_fix',
    d: 'M 70 78 C 70 95 200 115 315 142',
    labelX: 175,
    labelY: 118,
  },
  {
    key: 'final_audit_fix→coding',
    d: 'M 315 178 C 250 210 100 210 70 78',
    labelX: 175,
    labelY: 205,
  },
  // Terminal diagonals — one per phase that can terminate, converging on the
  // shared visual `terminal` target. Any persisted terminate row counts
  // against its origin phase's edge here.
  { key: 'coding→terminal', d: 'M 125 78 L 600 142', labelX: 240, labelY: 90 },
  { key: 'auditing→terminal', d: 'M 275 78 L 600 142', labelX: 395, labelY: 90 },
  { key: 'final_auditing→terminal', d: 'M 425 78 L 600 142', labelX: 505, labelY: 90 },
  { key: 'post_action→terminal', d: 'M 520 78 L 600 142', labelX: 565, labelY: 95 },
  { key: 'final_audit_fix→terminal', d: 'M 425 160 L 600 160', labelX: 512, labelY: 152 },
]

// Build the visual edge-count key for a persisted transition row. Terminal
// rows (`toPhase === null`, recorded by `terminateLoop`) collapse onto a
// shared `terminal` visual target so a terminate from any phase lands on
// the matching phase→terminal edge.
function edgeKeyFor(t: LoopTransitionRow): string {
  if (t.toPhase === null) return t.fromPhase + '→terminal'
  return t.fromPhase + '→' + t.toPhase
}

// Human-readable flow target for the history list. Terminal rows show the
// resulting status (e.g. "completed"); phase rows show the destination
// phase exactly as persisted.
function flowTargetFor(t: LoopTransitionRow): string {
  return t.toPhase ?? t.status ?? ''
}

export function LoopMachineGraph(props: {
  loop: () => LoopRow
  transitions: () => LoopTransitionRow[]
}) {
  const lp = () => props.loop()
  const isRunning = createMemo(() => lp().status === 'running')

  // Per-edge traversal counts, keyed by `edgeKeyFor`. Recomputed when the
  // transitions array changes; the edge label thunks below read this memo so
  // the counts update in place without rebuilding the SVG.
  const counts = createMemo(() => {
    const m = new Map<string, number>()
    for (const t of props.transitions()) {
      const key = edgeKeyFor(t)
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  })

  return html`<div class="mg-graph">
    <svg class="mg-svg" viewBox="0 0 720 220" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="mg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e"></path>
        </marker>
      </defs>

      ${EDGES.map((edge) => html`<g class="mg-edge" data-edge-key=${edge.key}>
        <path class="mg-edge-path" d=${edge.d} marker-end="url(#mg-arrow)"></path>
        <text class="mg-edge-label" x=${edge.labelX} y=${edge.labelY} text-anchor="middle">${() => {
          const n = counts().get(edge.key)
          return n ? String(n) : ''
        }}</text>
      </g>`)}

      ${PHASE_NODES.map((node) => {
        const rx = node.cx - NODE_W / 2
        const ry = node.cy - NODE_H / 2
        return html`<g class=${() =>
          'mg-node' +
          (lp().phase === node.phase && isRunning() ? ' mg-node-active' : '')}>
          <rect x=${rx} y=${ry} width=${NODE_W} height=${NODE_H} rx="6"></rect>
          <text class="mg-node-label" x=${node.cx} y=${node.cy} text-anchor="middle" dominant-baseline="middle">${node.label}</text>
        </g>`
      })}

      ${() =>
        isRunning()
          ? ''
          : html`<g class="mg-terminal">
              <rect x=${TERMINAL_CX - NODE_W / 2} y=${TERMINAL_CY - NODE_H / 2} width=${NODE_W} height=${NODE_H} rx="6"></rect>
              <text class="mg-terminal-label" x=${TERMINAL_CX} y=${TERMINAL_CY} text-anchor="middle" dominant-baseline="middle">${() => lp().status}</text>
            </g>`}
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
