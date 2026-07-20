import html from 'solid-js/html'
import { createEffect } from 'solid-js'
import { chartMax } from './helpers'

interface ChartSegment {
  value: number
  color: string
}

interface ChartPoint {
  label: string
  segments: ChartSegment[]
}

/**
 * Stacked bar chart scaled against the largest point total.
 */
export function StackedBarChart(props: {
  points: () => ChartPoint[]
  valueFormatter?: (value: number) => string
  emptyMessage?: string
  ariaLabel?: string
}) {
  const root = document.createElement('div')
  root.className = 'forge-chart'
  const formatValue = props.valueFormatter ?? String

  createEffect(() => {
    const points = props.points()
    const totals = points.map(point => point.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0))
    const maxStack = chartMax(totals)
    if (points.length === 0 || totals.every(total => total === 0)) {
      const empty = document.createElement('div')
      empty.className = 'forge-chart-empty'
      empty.textContent = props.emptyMessage ?? 'No data recorded.'
      root.replaceChildren(empty)
      return
    }

    const plot = document.createElement('div')
    plot.className = 'forge-chart-plot'
    plot.style.minWidth = `${Math.max(320, points.length * 72)}px`
    plot.setAttribute('role', 'img')
    plot.setAttribute('aria-label', props.ariaLabel ?? 'Bar chart')

    points.forEach((point, index) => {
      const column = document.createElement('div')
      column.className = 'forge-chart-column'
      column.title = `${point.label}: ${formatValue(totals[index])}`

      const value = document.createElement('div')
      value.className = 'forge-chart-value'
      value.textContent = formatValue(totals[index])

      const barSlot = document.createElement('div')
      barSlot.className = 'forge-chart-bar-slot'
      const bar = document.createElement('div')
      bar.className = 'forge-chart-bar'

      point.segments.forEach(segment => {
        const segmentElement = document.createElement('div')
        segmentElement.className = 'forge-chart-segment'
        segmentElement.style.height = `${(Math.max(0, segment.value) / maxStack) * 100}%`
        segmentElement.style.background = segment.color
        bar.append(segmentElement)
      })

      const label = document.createElement('div')
      label.className = 'forge-chart-label'
      label.textContent = point.label

      barSlot.append(bar)
      column.append(value, barSlot, label)
      plot.append(column)
    })

    root.replaceChildren(plot)
  })

  return root
}

interface AuditTimelineItem {
  cls: string
  title: string
  label: string
  verdict: string
}

export function AuditTimeline(props: { items: () => AuditTimelineItem[] }) {
  return html`<div class="forge-audit-timeline" role="list" aria-label="Audit outcomes by iteration">
    ${() =>
      props.items().map(
        (item: AuditTimelineItem) => html`<div class="forge-audit-step" role="listitem" title=${item.title}>
          <span class=${'forge-audit-marker ' + item.cls}></span>
          <span class="forge-audit-iteration">Iteration ${item.label}</span>
          <span class=${'forge-audit-verdict ' + item.cls}>${item.verdict}</span>
        </div>`,
      )}
  </div>`
}
