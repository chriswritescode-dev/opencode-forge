import html from 'solid-js/html'
import { chartMax } from './helpers'

// ---------------------------------------------------------------------------
// Hand-rolled SVG chart components for the dashboard app.
//
// solid-js/html constraints honored: each function returns one root element,
// reactive reads happen inside `${() => ...}` thunks, no `<${Show}>`/`<${For}>`
// syntax is used, and list rendering uses `.map()`. The whole SVG subtree is
// rebuilt when the data thunk re-emits; charts hold no scroll/resize state to
// preserve, so this is cheap and keeps the bars in sync on every poll.
// ---------------------------------------------------------------------------

export interface ChartSegment {
  value: number
  color: string
}

export interface ChartPoint {
  label: string
  segments: ChartSegment[]
}

const BAR_UNIT = 10 // viewBox units per bar (1-unit gap on the right)
const AXIS_PAD = 14 // viewBox units reserved at the bottom for x-axis labels

/**
 * Stacked bar chart. One `<rect>` per segment per point, anchored to a shared
 * height scale derived from the largest stacked total across all points (`chartMax`
 * floors the scale at 1 so empty inputs do not divide by zero). X-axis labels
 * are emitted every `ceil(n / 10)`th point so dense charts do not overcrowd.
 * Each bar carries a `<title>` providing the hover text for the full stack.
 */
export function StackedBarChart(props: { points: () => ChartPoint[]; height?: number }) {
  const height = props.height ?? 120
  return html`<div class="forge-chart">
    ${() => {
      const points = props.points()
      const n = points.length
      if (n === 0) return html`<div class="forge-chart-empty">No data.</div>`
      const vbW = n * BAR_UNIT
      const vbH = height
      const plotH = vbH - AXIS_PAD
      const maxStack = chartMax(points.map(p => p.segments.reduce((s, seg) => s + Math.max(0, seg.value), 0)))
      const labelEvery = Math.max(1, Math.ceil(n / 10))
      return html`<svg
        class="forge-chart-svg"
        viewBox=${`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="none"
        role="img"
      >
        ${points.map((pt: ChartPoint, i: number) => {
          const stackTotal = pt.segments.reduce((s, seg) => s + Math.max(0, seg.value), 0)
          let acc = 0
          const rects = pt.segments.map((seg: ChartSegment) => {
            const segVal = Math.max(0, seg.value)
            const segH = (segVal / maxStack) * plotH
            const y = plotH - acc - segH
            acc += segH
            return html`<rect
              x=${i * BAR_UNIT}
              y=${y}
              width=${BAR_UNIT - 1}
              height=${segH}
              fill=${seg.color}
            />`
          })
          const showLabel = i % labelEvery === 0
          return html`<g>
            ${rects}
            <title>${pt.label}: ${stackTotal}</title>
            ${showLabel
              ? html`<text
                  class="forge-chart-xlabel"
                  x=${i * BAR_UNIT + BAR_UNIT / 2}
                  y=${vbH - 2}
                  text-anchor="middle"
                >${pt.label}</text>`
              : ''}
          </g>`
        })}
      </svg>`
    }}
  </div>`
}

export interface DotStripItem {
  cls: string
  title: string
}

/**
 * Horizontal row of dots used to render audit-outcome timelines. Color is
 * conveyed by the per-item `cls` (e.g. `forge-dot-clean`); the `title`
 * surfaces the iteration / verdict on hover.
 */
export function DotStrip(props: { dots: () => DotStripItem[] }) {
  return html`<div class="forge-dot-strip">
    ${() =>
      props.dots().map(
        (d: DotStripItem) => html`<span class=${'forge-dot ' + d.cls} title=${d.title}></span>`,
      )}
  </div>`
}
