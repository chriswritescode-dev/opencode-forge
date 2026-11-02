/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import type { ColorInput, ScrollBoxRenderable } from '@opentui/core'
import { SyntaxStyle } from '@opentui/core'
import type { JSX } from '@opentui/solid'
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from 'solid-js'
import type {
  ForgeAmendmentDiff,
  ForgeDashboardLoopSummary,
  ForgeDashboardProjectSummary,
  ForgeDashboardUnexecutedPlan,
  ForgeLoopDetail,
  ForgeLoopDetailRow,
  ForgeLoopTransition,
  ForgePlanAmendment,
  ForgeReviewFinding,
  ForgeSectionPlan,
} from '../../host/forge-rpc'
import { phaseLabel } from '../../utils/phase-label'
import { renderLoopMachineDiagram } from './machine-diagram'
import type { DashboardSection, DashboardStore } from './store'
import {
  MAX_RENDERED_FINDING_ROWS,
  MAX_RENDERED_LOOP_ROWS,
  amendedSectionIndexes,
  buildRepoLabels,
  capList,
  computePhaseSpans,
  findingsLevel,
  formatFinding,
  formatCount,
  formatRelativeTime,
  formatSectionDuration,
  formatSectionNumber,
  formatSpanDuration,
  formatTokenCount,
  formatUsageCost,
  fmtTime,
  groupFindingsBySection,
  mergeTimelineEntries,
  modelUsageBars,
  phaseLegendRows,
  recentTransitionRows,
  repoLabel,
  repoRawPath,
  roleUsageBars,
  sectionProgress,
  splitFindings,
  summarizeAmendments,
  tabsForLoop,
  textBar,
  tokenBreakdownSegments,
  type LoopTab,
  type PhaseSpan,
  type TimelineEntry,
} from './view-model'

const SECTION_ORDER: readonly DashboardSection[] = ['loops', 'findings', 'plans']

const SECTION_LABELS: Record<DashboardSection, string> = {
  loops: 'Loops',
  findings: 'Findings',
  plans: 'Plans',
}

const TAB_LABELS: Record<LoopTab, string> = {
  overview: 'Overview',
  timeline: 'Timeline',
  sections: 'Sections',
  findings: 'Findings',
  plan: 'Plan',
  usage: 'Usage',
}

const METER_WIDTH = 8
const PHASE_BAR_WIDTH = 48
const USAGE_BAR_WIDTH = 16
const TIMELINE_WINDOW = 20

type DashboardColors = {
  text: ColorInput
  muted: ColorInput
  info: ColorInput
  success: ColorInput
  warning: ColorInput
  error: ColorInput
}

function dashboardColors(context: Plugin.Context): DashboardColors {
  const theme = context.theme
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    info: theme.text.feedback.info.base,
    success: theme.text.feedback.success.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
  }
}

const markdownStyles = new WeakMap<Plugin.Context['renderer'], SyntaxStyle>()

/** One shared syntax style per renderer for every markdown body the dashboard renders. */
function markdownStyle(context: Plugin.Context): SyntaxStyle {
  const cached = markdownStyles.get(context.renderer)
  if (cached) return cached
  const created = SyntaxStyle.create(context.renderer.nativeScene)
  markdownStyles.set(context.renderer, created)
  return created
}

/**
 * Registers a page's keymap layer for as long as the component that created it
 * lives. The layer factory is owned by an effect so it is torn down with the
 * page on every route change.
 */
function registerPageKeymap(
  props: { context: Plugin.Context },
  factory: Parameters<Plugin.Context['keymap']['layer']>[0],
): void {
  createEffect(() => {
    props.context.keymap.layer(factory)
  })
}

function statusColor(colors: DashboardColors, status: string): ColorInput {
  if (status === 'running') return colors.info
  if (status === 'completed') return colors.success
  if (status === 'errored') return colors.error
  if (status === 'stalled') return colors.warning
  return colors.muted
}

function phaseColor(colors: DashboardColors, phase: string): ColorInput {
  if (phase === 'coding') return colors.info
  if (phase === 'auditing') return colors.warning
  if (phase === 'post_action') return colors.success
  return colors.muted
}

function severityColor(colors: DashboardColors, severity: string): ColorInput {
  return severity === 'bug' ? colors.error : colors.warning
}

function changeColor(colors: DashboardColors, change: string): ColorInput {
  if (change === 'added') return colors.success
  if (change === 'removed') return colors.error
  if (change === 'modified') return colors.warning
  return colors.muted
}

function diffLineColor(colors: DashboardColors, kind: string): ColorInput {
  if (kind === 'add') return colors.success
  if (kind === 'remove') return colors.error
  return colors.muted
}

function diffLineText(kind: string, text: string): string {
  if (kind === 'add') return '+ ' + text
  if (kind === 'remove') return '- ' + text
  if (kind === 'context') return '  ' + text
  return text
}

function marker(selected: Accessor<boolean>, colors: DashboardColors): JSX.Element {
  return <text flexShrink={0} fg={selected() ? colors.info : colors.muted}>{selected() ? '▸' : ' '}</text>
}

function meter(current: number, total: number, colors: DashboardColors): JSX.Element {
  return (
    <text flexShrink={0} fg={colors.muted}>
      {`${textBar(total > 0 ? current / total : 0, METER_WIDTH)} ${current}/${total}`}
    </text>
  )
}

function MarkdownBlock(props: {
  context: Plugin.Context
  label: string
  content: string
  colors: DashboardColors
}): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={props.colors.muted}>{props.label}</text>
      <markdown content={props.content} syntaxStyle={markdownStyle(props.context)} fg={props.colors.text} />
    </box>
  )
}

function PhaseBar(props: { spans: PhaseSpan[]; truncated: boolean; colors: DashboardColors }): JSX.Element {
  const segments = createMemo(() => {
    const visible = props.spans.filter((span) => span.phase !== '')
    const total = visible.reduce((sum, span) => sum + span.durationMs, 0)
    if (total <= 0) return []
    let elapsed = 0
    const out: Array<{ phase: string; width: number }> = []
    for (const span of visible) {
      const start = Math.round((elapsed / total) * PHASE_BAR_WIDTH)
      elapsed += span.durationMs
      const end = Math.round((elapsed / total) * PHASE_BAR_WIDTH)
      const width = Math.max(0, end - start)
      if (width > 0) out.push({ phase: span.phase, width })
    }
    return out
  })
  return (
    <box flexDirection="row">
      <Show when={props.truncated}>
        <text fg={props.colors.muted}>⋯</text>
      </Show>
      <For each={segments()}>
        {(segment) => (
          <text fg={phaseColor(props.colors, segment.phase)} wrapMode="none">
            {'█'.repeat(segment.width)}
          </text>
        )}
      </For>
    </box>
  )
}

function PhaseLegend(props: { spans: PhaseSpan[]; colors: DashboardColors }): JSX.Element {
  const rows = createMemo(() => phaseLegendRows(props.spans))
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <text fg={props.colors.muted}>{`${row.label} · ${formatSpanDuration(row.durationMs)} · ${row.pct}%`}</text>
        )}
      </For>
    </box>
  )
}

type DashboardRow =
  | { kind: 'project'; project: ForgeDashboardProjectSummary }
  | { kind: 'loop'; loop: ForgeDashboardLoopSummary }
  | { kind: 'finding'; loopName: string; findings: ForgeReviewFinding[] }
  | { kind: 'plan'; plan: ForgeDashboardUnexecutedPlan }
  | { kind: 'executed'; loop: ForgeDashboardLoopSummary }

function rowId(index: number): string {
  return `forge-dashboard-row-${index}`
}

/**
 * The dashboard list. Every value comes from the store; the page only decides
 * which section is visible. The cursor indexes this one row model, so keyboard
 * movement and rendering can never disagree about the selected item.
 */
export function DashboardPage(props: { context: Plugin.Context; store: DashboardStore }) {
  const colors = () => dashboardColors(props.context)
  let scrollRef: ScrollBoxRenderable | undefined
  let disposed = false

  const project = () => props.store.selectedProject()

  const rowCache = new Map<DashboardRow['kind'], WeakMap<object, DashboardRow>>()

  /** One wrapper per source row, so an unchanged row keeps its rendered node across recomputes. */
  function cachedRow(kind: DashboardRow['kind'], source: object, create: () => DashboardRow): DashboardRow {
    let cache = rowCache.get(kind)
    if (!cache) {
      cache = new WeakMap()
      rowCache.set(kind, cache)
    }
    const cached = cache.get(source)
    if (cached) return cached
    const row = create()
    cache.set(source, row)
    return row
  }

  const labels = createMemo(() => buildRepoLabels((props.store.summary()?.projects ?? []).map(repoRawPath)))

  const sectionCounts = createMemo<Record<DashboardSection, number>>(() => {
    const current = project()
    if (!current) return { loops: 0, findings: 0, plans: 0 }
    return {
      loops: current.loops.length,
      findings: current.bugCount,
      plans: current.unexecutedPlans.length + current.loops.filter((loop) => loop.hasPlan).length,
    }
  })

  const sectionCountLabel = (section: DashboardSection): string => {
    const count = sectionCounts()[section]
    if (section === 'findings') return `${SECTION_LABELS[section]} (${formatCount(count, 'bug')})`
    return `${SECTION_LABELS[section]} ${count}`
  }

  const unexecutedPlans = createMemo(() => capList(project()?.unexecutedPlans ?? [], MAX_RENDERED_LOOP_ROWS, false))
  const executedPlans = createMemo(() =>
    capList((project()?.loops ?? []).filter((loop) => loop.hasPlan), MAX_RENDERED_LOOP_ROWS, false))

  const findingGroups = createMemo(() => {
    const groups: Array<{ loopName: string; findings: ForgeReviewFinding[] }> = []
    let budget = MAX_RENDERED_FINDING_ROWS
    for (const group of props.store.findings()) {
      if (budget <= 0) break
      const findings = group.findings.slice(0, budget)
      if (findings.length === 0) continue
      budget -= findings.length
      groups.push({ loopName: group.loopName, findings })
    }
    return groups
  })

  const findingsTotal = createMemo(() =>
    props.store.findings().reduce((sum, group) => sum + group.findings.length, 0))

  const rows = createMemo<DashboardRow[]>(() => {
    const current = project()
    if (!current) {
      return props.store.projects().map((entry) =>
        cachedRow('project', entry, () => ({ kind: 'project' as const, project: entry })))
    }
    const section = props.store.section()
    if (section === 'loops') {
      return props.store.loopRows().rows.map((loop) =>
        cachedRow('loop', loop, () => ({ kind: 'loop' as const, loop })))
    }
    if (section === 'findings') {
      return findingGroups().map((group) =>
        cachedRow('finding', group, () => ({
          kind: 'finding' as const,
          loopName: group.loopName,
          findings: group.findings,
        })))
    }
    if (props.store.planSessionId()) return []
    return [
      ...unexecutedPlans().rows.map((plan) =>
        cachedRow('plan', plan, () => ({ kind: 'plan' as const, plan }))),
      ...executedPlans().rows.map((loop) =>
        cachedRow('executed', loop, () => ({ kind: 'executed' as const, loop }))),
    ]
  })

  const selectedIndex = (): number => {
    const count = rows().length
    if (count === 0) return -1
    return Math.min(props.store.cursor(), count - 1)
  }

  const ensureCursorVisible = (): void => {
    if (disposed || !scrollRef) return
    const index = selectedIndex()
    if (index < 0) return
    scrollRef.scrollChildIntoView(rowId(index))
  }

  const moveCursor = (delta: number): void => {
    const count = rows().length
    if (count === 0) return
    const next = Math.max(0, Math.min(count - 1, selectedIndex() + delta))
    props.store.setCursor(next)
  }

  const openLoop = (projectId: string, loopName: string, tab: LoopTab = 'overview'): void => {
    props.store.openLoop(projectId, loopName)
    props.store.setLoopTab(tab)
    props.context.ui.router.navigate({
      type: 'plugin',
      name: 'forge-dashboard-loop',
      data: { projectId, loopName },
    })
  }

  const activateRow = (): void => {
    const row = rows()[selectedIndex()]
    if (!row) return
    const projectId = project()?.projectId
    if (row.kind === 'project') {
      props.store.selectProject(row.project.projectId)
      return
    }
    if (!projectId) return
    if (row.kind === 'loop') openLoop(projectId, row.loop.loopName)
    else if (row.kind === 'finding') openLoop(projectId, row.loopName)
    else if (row.kind === 'plan') props.store.openPlan(row.plan.sessionId)
    else openLoop(projectId, row.loop.loopName, 'plan')
  }

  const deleteSelectedPlan = (): void => {
    const row = rows()[selectedIndex()]
    if (row?.kind === 'plan') props.store.openPlan(row.plan.sessionId)
    if (!props.store.planSessionId()) return
    void props.store.deleteSelectedPlan()
  }

  const moveSection = (delta: number): void => {
    if (!project()) return
    const index = SECTION_ORDER.indexOf(props.store.section())
    props.store.setSection(SECTION_ORDER[(index + delta + SECTION_ORDER.length) % SECTION_ORDER.length])
  }

  const goUp = (): void => {
    if (props.store.searchFocused()) {
      props.store.blurSearch()
      return
    }
    if (props.store.planSessionId()) {
      props.store.closePlan()
      return
    }
    if (props.store.selectedProjectId()) {
      props.store.selectProject(null)
      return
    }
    const route = props.store.returnRoute()
    if (route) props.context.ui.router.navigate(route)
  }

  registerPageKeymap(props, () => ({
    commands: [
      {
        id: 'forge.dashboard.up',
        title: 'Dashboard: move up',
        bind: 'up',
        enabled: () => !props.store.searchFocused(),
        run: () => moveCursor(-1),
      },
      {
        id: 'forge.dashboard.down',
        title: 'Dashboard: move down',
        bind: 'down',
        enabled: () => !props.store.searchFocused(),
        run: () => moveCursor(1),
      },
      {
        id: 'forge.dashboard.previous',
        title: 'Dashboard: move up',
        bind: 'k',
        enabled: () => !props.store.searchFocused(),
        run: () => moveCursor(-1),
      },
      {
        id: 'forge.dashboard.next',
        title: 'Dashboard: move down',
        bind: 'j',
        enabled: () => !props.store.searchFocused(),
        run: () => moveCursor(1),
      },
      {
        id: 'forge.dashboard.open',
        title: 'Dashboard: open',
        bind: 'return',
        enabled: () => !props.store.searchFocused(),
        run: activateRow,
      },
      {
        id: 'forge.dashboard.back',
        title: 'Dashboard: back',
        bind: 'escape',
        run: goUp,
      },
      {
        id: 'forge.dashboard.search',
        title: 'Dashboard: search',
        bind: '/',
        enabled: () => !props.store.searchFocused(),
        run: () => props.store.focusSearch(),
      },
      {
        id: 'forge.dashboard.sectionNext',
        title: 'Dashboard: next section',
        bind: 'tab',
        enabled: () => !props.store.searchFocused() && project() !== null,
        run: () => moveSection(1),
      },
      {
        id: 'forge.dashboard.sectionPrevious',
        title: 'Dashboard: previous section',
        bind: 'shift+tab',
        enabled: () => !props.store.searchFocused() && project() !== null,
        run: () => moveSection(-1),
      },
      ...SECTION_ORDER.map((section, index) => ({
        id: `forge.dashboard.section.${section}`,
        title: `Dashboard: ${SECTION_LABELS[section]}`,
        bind: String(index + 1),
        enabled: () => !props.store.searchFocused() && project() !== null,
        run: () => props.store.setSection(section),
      })),
      {
        id: 'forge.dashboard.sort',
        title: 'Dashboard: cycle sort',
        bind: 's',
        enabled: () => !props.store.searchFocused(),
        run: () => props.store.cycleSort(),
      },
      {
        id: 'forge.dashboard.filter',
        title: 'Dashboard: cycle status filter',
        bind: 'f',
        enabled: () => !props.store.searchFocused(),
        run: () => props.store.cycleStatusFilter(),
      },
      {
        id: 'forge.dashboard.deletePlan',
        title: 'Dashboard: delete plan',
        bind: 'd',
        enabled: () => !props.store.searchFocused(),
        run: deleteSelectedPlan,
      },
      {
        id: 'forge.dashboard.refresh',
        title: 'Dashboard: refresh',
        bind: 'r',
        enabled: () => !props.store.searchFocused(),
        run: () => props.store.handleResubscribed(),
      },
    ],
  }))

  createEffect(() => {
    const count = rows().length
    if (count > 0 && props.store.cursor() > count - 1) props.store.setCursor(count - 1)
  })

  createEffect(() => {
    const index = selectedIndex()
    if (index < 0) return
    setTimeout(ensureCursorVisible, 0)
  })

  onMount(() => {
    props.store.activate()
    setTimeout(ensureCursorVisible, 0)
  })

  onCleanup(() => {
    disposed = true
    props.store.deactivate()
  })

  const footer = (): string => {
    const parts = ['↑/↓ move', 'enter open', '/ search', 'r refresh', 'esc back']
    if (project()) parts.push('tab section', '1-3 section')
    if (project() && props.store.section() === 'loops') parts.push('s sort', 'f filter')
    if (project() && props.store.section() === 'plans') parts.push('d delete')
    return parts.join(' · ')
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexShrink={0} flexDirection="column" paddingX={1}>
        <box flexDirection="row" gap={1}>
          <text fg={colors().text}>
            <b>Forge dashboard</b>
          </text>
          <text fg={colors().muted}>{`· ${formatCount(props.store.projects().length, 'project')}`}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} fg={colors().muted}>/</text>
          <input
            flexGrow={1}
            value={props.store.query()}
            placeholder="Search projects, loops and plans"
            focused={props.store.searchFocused()}
            onInput={(value) => props.store.setQuery(value)}
            onSubmit={() => props.store.blurSearch()}
          />
        </box>
        <Show when={project()}>
          <box flexDirection="row" gap={2} paddingTop={1}>
            <For each={SECTION_ORDER}>
              {(section) => (
                <text fg={props.store.section() === section ? colors().info : colors().muted}>
                  {sectionCountLabel(section)}
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>

      <scrollbox
        ref={(element) => { scrollRef = element }}
        flexGrow={1}
        flexDirection="column"
        scrollX={false}
        scrollY={true}
        paddingX={1}
      >
        <Show when={props.store.error()}>
          <text fg={colors().error}>{props.store.error()}</text>
        </Show>
        <Show when={props.store.findingsError() && props.store.section() === 'findings'}>
          <text fg={colors().error}>{props.store.findingsError()}</text>
        </Show>

        <Show when={!project()}>
          <Show when={props.store.projects().length === 0}>
            <text fg={colors().muted}>
              {props.store.query() ? 'No projects match the current search.' : 'No projects have Forge data yet.'}
            </text>
          </Show>
        </Show>

        <Show when={project() && props.store.section() === 'loops'}>
          <box flexDirection="row" gap={1}>
            <text fg={colors().muted}>{`Sort: ${props.store.sort()}`}</text>
            <text fg={colors().muted}>{`· Filter: ${props.store.statusFilter()}`}</text>
            <text fg={colors().muted}>{props.store.statusFilter() === 'all'
              ? `· ${formatCount(props.store.loopStatusCounts().all, 'loop')}`
              : `· ${props.store.loopRows().total} of ${formatCount(props.store.loopStatusCounts().all, 'loop')}`}</text>
          </box>
          <Show when={props.store.loopRows().capped}>
            <text fg={colors().warning}>
              {`Showing first ${MAX_RENDERED_LOOP_ROWS} of ${props.store.loopRows().total} loops; narrow the search to see more.`}
            </text>
          </Show>
          <Show when={props.store.loopRows().rows.length === 0}>
            <text fg={colors().muted}>No loops match the current search and filter.</text>
          </Show>
        </Show>

        <Show when={project() && props.store.section() === 'findings'}>
          <box flexDirection="row" gap={1}>
            <text fg={colors().muted}>{`Findings ${findingsTotal()}`}</text>
          </box>
          <Show when={!props.store.findingsError() && findingsTotal() === 0}>
            <text fg={colors().muted}>No findings recorded for this project.</text>
          </Show>
          <Show when={findingsTotal() > MAX_RENDERED_FINDING_ROWS}>
            <text fg={colors().warning}>
              {`Showing first ${MAX_RENDERED_FINDING_ROWS} of ${findingsTotal()} findings; narrow the search to see more.`}
            </text>
          </Show>
        </Show>

        <Show when={project() && props.store.section() === 'plans'}>
          <Show when={props.store.planSessionId()}>
            <PlanDetail context={props.context} store={props.store} colors={colors()} />
          </Show>
          <Show when={!props.store.planSessionId()}>
            <box flexDirection="row" gap={1}>
              <text fg={colors().muted}>{`Unexecuted ${unexecutedPlans().total} · Executed ${executedPlans().total}`}</text>
            </box>
            <Show when={unexecutedPlans().total === 0 && executedPlans().total === 0}>
              <text fg={colors().muted}>No plans recorded for this project.</text>
            </Show>
            <Show when={unexecutedPlans().capped || executedPlans().capped}>
              <text fg={colors().warning}>
                {`Showing first ${MAX_RENDERED_LOOP_ROWS} plans per group; narrow the search to see more.`}
              </text>
            </Show>
          </Show>
        </Show>

        <Show when={!props.store.planSessionId()}>
          <For each={rows()}>
            {(row, index) => (
              <box id={rowId(index())} flexDirection="column">
                {renderDashboardRow(row, () => index() === selectedIndex(), labels, colors())}
              </box>
            )}
          </For>
        </Show>
      </scrollbox>

      <box flexShrink={0} paddingX={1}>
        <text fg={colors().muted}>{footer()}</text>
      </box>
    </box>
  )
}

function renderDashboardRow(
  row: DashboardRow,
  selected: Accessor<boolean>,
  labels: Accessor<Map<string, string>>,
  colors: DashboardColors,
): JSX.Element {
  if (row.kind === 'project') {
    return renderProjectRow({ row, labels, selected, colors })
  }
  if (row.kind === 'loop') {
    return renderLoopRow({ loop: row.loop, selected, colors })
  }
  if (row.kind === 'finding') {
    return renderFindingGroup({ row, selected, colors })
  }
  if (row.kind === 'plan') {
    return renderPlanRow({ plan: row.plan, selected, colors })
  }
  return renderExecutedPlanRow({ loop: row.loop, selected, colors })
}

function renderProjectRow(props: {
  row: Extract<DashboardRow, { kind: 'project' }>
  labels: Accessor<Map<string, string>>
  selected: Accessor<boolean>
  colors: DashboardColors
}): JSX.Element {
  const running = () => props.row.project.loops.filter((loop) => loop.status === 'running').length
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" gap={1}>
        {marker(props.selected, props.colors)}
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>
          {repoLabel(props.labels(), props.row.project)}
        </text>
        <text flexShrink={0} fg={running() > 0 ? props.colors.info : props.colors.muted}>{`running ${running()}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>
          {`loops ${props.row.project.loopCount} · plans ${props.row.project.unexecutedPlanCount} · bugs ${props.row.project.bugCount}`}
        </text>
      </box>
      <box flexDirection="row" paddingLeft={2}>
        <text fg={props.colors.muted} wrapMode="none" truncate>
          {props.row.project.projectDir ?? props.row.project.projectId}
        </text>
      </box>
    </box>
  )
}

function renderLoopRow(props: {
  loop: ForgeDashboardLoopSummary
  selected: Accessor<boolean>
  colors: DashboardColors
}): JSX.Element {
  const phase = () => (props.loop.completedAt === undefined ? phaseLabel(props.loop.phase) : '—')
  const sections = () => sectionProgress(props.loop.currentSectionIndex, props.loop.totalSections)
  return (
    <box flexDirection="row" gap={1}>
      {marker(props.selected, props.colors)}
      <text flexShrink={0} fg={statusColor(props.colors, props.loop.status)}>{props.loop.status}</text>
      <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>{props.loop.loopName}</text>
      <text flexShrink={0} fg={props.colors.muted}>{phase()}</text>
      {meter(props.loop.iteration, props.loop.maxIterations, props.colors)}
      <Show when={props.loop.totalSections > 0} fallback={<text flexShrink={0} fg={props.colors.muted}>—</text>}>
        {meter(sections().current, sections().total, props.colors)}
      </Show>
      <text flexShrink={0} fg={props.loop.bugCount > 0 ? props.colors.error : props.colors.muted}>
        {formatCount(props.loop.bugCount, 'bug')}
      </text>
      <text flexShrink={0} fg={props.colors.muted}>
        {props.loop.totalCost === undefined ? '—' : formatUsageCost(props.loop.totalCost)}
      </text>
      <text flexShrink={0} fg={props.colors.muted}>{props.loop.durationText ?? '—'}</text>
      <text flexShrink={0} fg={props.colors.muted}>{formatRelativeTime(props.loop.activityAt)}</text>
    </box>
  )
}

function renderFindingGroup(props: {
  row: Extract<DashboardRow, { kind: 'finding' }>
  selected: Accessor<boolean>
  colors: DashboardColors
}): JSX.Element {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" gap={1}>
        {marker(props.selected, props.colors)}
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.info}>{props.row.loopName}</text>
        <text flexShrink={0} fg={props.colors.muted}>{formatCount(props.row.findings.length, 'finding')}</text>
      </box>
      <For each={props.row.findings}>
        {(finding) => (
          <text fg={severityColor(props.colors, finding.severity)} wrapMode="word">
            {`  ${finding.severity === 'bug' ? '✖' : '▲'} ${formatFinding(finding)}`}
          </text>
        )}
      </For>
    </box>
  )
}

function renderPlanRow(props: {
  plan: ForgeDashboardUnexecutedPlan
  selected: Accessor<boolean>
  colors: DashboardColors
}): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      {marker(props.selected, props.colors)}
      <text flexShrink={0} fg={props.colors.muted}>unexecuted</text>
      <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>{props.plan.title}</text>
      <text flexShrink={0} fg={props.colors.muted}>
        {`${formatRelativeTime(props.plan.updatedAt)} · ${props.plan.charCount.toLocaleString()} chars`}
      </text>
    </box>
  )
}

function renderExecutedPlanRow(props: {
  loop: ForgeDashboardLoopSummary
  selected: Accessor<boolean>
  colors: DashboardColors
}): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      {marker(props.selected, props.colors)}
      <text flexShrink={0} fg={statusColor(props.colors, props.loop.status)}>{props.loop.status}</text>
      <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>{props.loop.loopName}</text>
      <text flexShrink={0} fg={props.colors.muted}>
        {`${formatCount(props.loop.bugCount, 'bug')} · iter ${props.loop.iteration}/${props.loop.maxIterations}`}
      </text>
    </box>
  )
}

function PlanDetail(props: {
  context: Plugin.Context
  store: DashboardStore
  colors: DashboardColors
}): JSX.Element {
  const plan = (): ForgeDashboardUnexecutedPlan | null => {
    const sessionId = props.store.planSessionId()
    if (!sessionId) return null
    return props.store.selectedProject()?.unexecutedPlans.find((entry) => entry.sessionId === sessionId) ?? null
  }
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={props.colors.text}>{plan()?.title ?? props.store.planSessionId() ?? ''}</text>
      <Show when={plan()}>
        {(value) => (
          <text fg={props.colors.muted}>
            {`${value().sessionId} · updated ${formatRelativeTime(value().updatedAt)} · ${value().charCount.toLocaleString()} chars`}
          </text>
        )}
      </Show>
      <Show when={props.store.planError()}>
        <text fg={props.colors.error}>{props.store.planError()}</text>
      </Show>
      <Show when={props.store.planContent() === null && !props.store.planError()}>
        <text fg={props.colors.muted}>Loading plan…</text>
      </Show>
      <Show when={props.store.planContent() !== null}>
        <MarkdownBlock
          context={props.context}
          label="Plan"
          content={props.store.planContent() ?? ''}
          colors={props.colors}
        />
      </Show>
    </box>
  )
}

function readLoopRouteData(data: Record<string, unknown> | undefined): { projectId: string; loopName: string } | null {
  if (!data) return null
  const projectId = data.projectId
  const loopName = data.loopName
  if (typeof projectId !== 'string' || typeof loopName !== 'string') return null
  return { projectId, loopName }
}

/**
 * One loop's full detail. The loop route carries its identity, which is
 * mirrored into the store on mount so the page still renders when opened
 * directly. All scrolling and selection state lives in the store or this page;
 * the page never writes anything but its own scroll position.
 */
export function DashboardLoopPage(props: {
  context: Plugin.Context
  store: DashboardStore
  data?: Record<string, unknown>
}) {
  const colors = () => dashboardColors(props.context)
  let scrollRef: ScrollBoxRenderable | undefined
  let disposed = false
  const [sectionCursor, setSectionCursor] = createSignal(0)
  const [expandedSection, setExpandedSection] = createSignal<number | null>(null)
  const [amendmentCursor, setAmendmentCursor] = createSignal(0)

  const detail = (): ForgeLoopDetail | null => props.store.detail()

  const tabs = createMemo<LoopTab[]>(() => {
    const value = detail()
    if (!value) return ['overview']
    return tabsForLoop({ sectionCount: value.sections.length, hasPlan: value.plan !== undefined })
  })

  const activeTab = (): LoopTab => {
    const tab = props.store.loopTab()
    return tabs().includes(tab) ? tab : 'overview'
  }

  const persistScroll = (): void => {
    if (scrollRef) props.store.setLoopScrollTop(scrollRef.scrollTop)
  }

  const scroll = (delta: number, unit: 'step' | 'viewport'): void => {
    if (!scrollRef) return
    scrollRef.scrollBy(delta, unit)
    persistScroll()
  }

  const setTab = (tab: LoopTab): void => {
    props.store.setLoopTab(tab)
    props.store.setLoopScrollTop(0)
    setExpandedSection(null)
    setAmendmentCursor(0)
    if (scrollRef) scrollRef.scrollTop = 0
  }

  const cycleTab = (delta: number): void => {
    const list = tabs()
    const index = list.indexOf(activeTab())
    setTab(list[(index + delta + list.length) % list.length])
  }

  const moveSelection = (delta: number): void => {
    if (activeTab() === 'sections') {
      const count = detail()?.sections.length ?? 0
      if (count > 0) setSectionCursor((current) => Math.max(0, Math.min(count - 1, current + delta)))
      return
    }
    if (activeTab() === 'plan') {
      const count = detail()?.amendments.length ?? 0
      if (count > 0) setAmendmentCursor((current) => Math.max(0, Math.min(count - 1, current + delta)))
    }
  }

  const toggleSelection = (): void => {
    if (activeTab() === 'sections') {
      const section = detail()?.sections[sectionCursor()]
      if (!section) return
      setExpandedSection((current) => (current === section.sectionIndex ? null : section.sectionIndex))
      return
    }
    if (activeTab() === 'plan') {
      const amendment = detail()?.amendments[amendmentCursor()]
      if (amendment) void props.store.toggleAmendment(amendment.id)
    }
  }

  const goBack = (): void => {
    props.store.closeLoop()
    props.context.ui.router.navigate({ type: 'plugin', name: 'forge-dashboard' })
  }

  registerPageKeymap(props, () => ({
    commands: [
      {
        id: 'forge.dashboardLoop.tabNext',
        title: 'Loop page: next tab',
        bind: 'tab',
        run: () => cycleTab(1),
      },
      {
        id: 'forge.dashboardLoop.tabPrevious',
        title: 'Loop page: previous tab',
        bind: 'shift+tab',
        run: () => cycleTab(-1),
      },
      {
        id: 'forge.dashboardLoop.scrollUp',
        title: 'Loop page: scroll up',
        bind: 'up',
        run: () => scroll(-1, 'step'),
      },
      {
        id: 'forge.dashboardLoop.scrollDown',
        title: 'Loop page: scroll down',
        bind: 'down',
        run: () => scroll(1, 'step'),
      },
      {
        id: 'forge.dashboardLoop.pageUp',
        title: 'Loop page: page up',
        bind: 'pageup',
        run: () => scroll(-1, 'viewport'),
      },
      {
        id: 'forge.dashboardLoop.pageDown',
        title: 'Loop page: page down',
        bind: 'pagedown',
        run: () => scroll(1, 'viewport'),
      },
      {
        id: 'forge.dashboardLoop.selectPrevious',
        title: 'Loop page: select previous',
        bind: 'k',
        enabled: () => activeTab() === 'sections' || activeTab() === 'plan',
        run: () => moveSelection(-1),
      },
      {
        id: 'forge.dashboardLoop.selectNext',
        title: 'Loop page: select next',
        bind: 'j',
        enabled: () => activeTab() === 'sections' || activeTab() === 'plan',
        run: () => moveSelection(1),
      },
      {
        id: 'forge.dashboardLoop.toggle',
        title: 'Loop page: expand or collapse',
        bind: 'return',
        enabled: () => activeTab() === 'sections' || activeTab() === 'plan',
        run: toggleSelection,
      },
      {
        id: 'forge.dashboardLoop.back',
        title: 'Loop page: back to dashboard',
        bind: 'escape',
        run: goBack,
      },
      {
        id: 'forge.dashboardLoop.refresh',
        title: 'Loop page: refresh',
        bind: 'r',
        run: () => props.store.handleResubscribed(),
      },
    ],
  }))

  createEffect(() => {
    if (!detail()) return
    if (tabs().includes(props.store.loopTab())) return
    props.store.setLoopTab('overview')
  })

  createEffect(() => {
    const count = detail()?.sections.length ?? 0
    if (sectionCursor() > Math.max(0, count - 1)) setSectionCursor(Math.max(0, count - 1))
  })

  createEffect(() => {
    const count = detail()?.amendments.length ?? 0
    if (amendmentCursor() > Math.max(0, count - 1)) setAmendmentCursor(Math.max(0, count - 1))
  })

  onMount(() => {
    const route = readLoopRouteData(props.data)
    if (route && (props.store.loopProjectId() !== route.projectId || props.store.loopName() !== route.loopName)) {
      props.store.openLoop(route.projectId, route.loopName)
    }
    props.store.activate()
    setTimeout(() => {
      if (disposed || !scrollRef) return
      scrollRef.scrollTop = props.store.loopScrollTop()
    }, 0)
  })

  onCleanup(() => {
    disposed = true
    persistScroll()
    props.store.deactivate()
  })

  const footer = (): string => {
    const parts = ['tab/shift+tab tabs']
    if (activeTab() === 'sections' || activeTab() === 'plan') parts.push('j/k select', 'enter expand')
    parts.push('↑/↓ scroll', 'pgup/pgdn scroll', 'r refresh', 'esc back')
    return parts.join(' · ')
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexShrink={0} flexDirection="column" paddingX={1}>
        <Show when={detail()} fallback={<text fg={colors().muted}>Loading loop…</text>}>
          {(value) => <LoopHeader detail={value()} colors={colors()} />}
        </Show>
        <box flexDirection="row" gap={2} paddingTop={1}>
          <For each={tabs()}>
            {(tab) => (
              <text fg={activeTab() === tab ? colors().info : colors().muted}>
                {activeTab() === tab ? `[${TAB_LABELS[tab]}]` : TAB_LABELS[tab]}
              </text>
            )}
          </For>
        </box>
      </box>

      <scrollbox
        ref={(element) => { scrollRef = element }}
        flexGrow={1}
        flexDirection="column"
        scrollX={false}
        scrollY={true}
        paddingX={1}
      >
        <Show when={props.store.detailError()}>
          <text fg={colors().error}>{props.store.detailError()}</text>
        </Show>
        <Show when={detail()} fallback={<text fg={colors().muted}>Waiting for the loop detail…</text>}>
          {(value) => (
            <Switch>
              <Match when={activeTab() === 'overview'}>
                <OverviewTab detail={value()} context={props.context} colors={colors()} />
              </Match>
              <Match when={activeTab() === 'timeline'}>
                <TimelineTab detail={value()} colors={colors()} />
              </Match>
              <Match when={activeTab() === 'sections'}>
                <SectionsTab
                  detail={value()}
                  context={props.context}
                  colors={colors()}
                  cursor={sectionCursor}
                  expanded={expandedSection}
                />
              </Match>
              <Match when={activeTab() === 'findings'}>
                <FindingsTab detail={value()} colors={colors()} />
              </Match>
              <Match when={activeTab() === 'plan'}>
                <PlanTab
                  detail={value()}
                  context={props.context}
                  store={props.store}
                  colors={colors()}
                  cursor={amendmentCursor}
                />
              </Match>
              <Match when={activeTab() === 'usage'}>
                <UsageTab detail={value()} colors={colors()} />
              </Match>
            </Switch>
          )}
        </Show>
      </scrollbox>

      <box flexShrink={0} paddingX={1}>
        <text fg={colors().muted}>{footer()}</text>
      </box>
    </box>
  )
}

function LoopHeader(props: { detail: ForgeLoopDetail; colors: DashboardColors }): JSX.Element {
  const loop = (): ForgeLoopDetailRow => props.detail.loop
  const sections = () => sectionProgress(loop().currentSectionIndex, loop().totalSections)
  const split = () => splitFindings(props.detail.findings)
  const findingsSummary = (): string => {
    const value = split()
    if (value.bugs.length === 0 && value.warnings.length === 0) return 'no findings'
    const parts: string[] = []
    if (value.bugs.length > 0) parts.push(formatCount(value.bugs.length, 'bug'))
    if (value.warnings.length > 0) parts.push(formatCount(value.warnings.length, 'warning'))
    return parts.join(' · ')
  }
  const findingsTone = () => {
    const level = findingsLevel(split())
    if (level === 'bug') return props.colors.error
    if (level === 'warn') return props.colors.warning
    return props.colors.success
  }
  const auditor = (): string => {
    const base = loop().auditorModel ?? '—'
    return loop().auditorFallbackIndex > 0 ? `${base} (fallback ${loop().auditorFallbackIndex})` : base
  }
  const cost = (): string => {
    const usage = props.detail.usage
    return usage ? formatUsageCost(usage.totalCost) : '—'
  }
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={statusColor(props.colors, loop().status)}>{loop().status}</text>
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>
          <b>{loop().loopName}</b>
        </text>
        <Show when={loop().completedAt === undefined}>
          <text flexShrink={0} fg={props.colors.info}>{phaseLabel(loop().phase)}</text>
        </Show>
      </box>
      <box flexDirection="row" gap={2}>
        <text flexShrink={0} fg={props.colors.muted}>{`duration ${props.detail.durationText ?? '—'}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`cost ${cost()}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>
          {`iterations ${textBar(loop().iteration / Math.max(1, loop().maxIterations), METER_WIDTH)} ${loop().iteration}/${loop().maxIterations}`}
        </text>
        <Show when={loop().totalSections > 0}>
          <text flexShrink={0} fg={props.colors.muted}>
            {`sections ${textBar(sections().current / sections().total, METER_WIDTH)} ${sections().current}/${sections().total}`}
          </text>
        </Show>
      </box>
      <box flexDirection="row" gap={2}>
        <text flexShrink={0} fg={findingsTone()}>{findingsSummary()}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`exec ${loop().executionModel ?? '—'}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`audit ${auditor()}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`branch ${loop().worktreeBranch ?? '—'}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`sandbox ${loop().sandbox ? 'on' : 'off'}`}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`audits ${loop().auditCount} · errors ${loop().errorCount}`}</text>
      </box>
      <Show when={loop().terminationReason}>
        <text fg={props.colors.warning}>{`termination: ${loop().terminationReason}`}</text>
      </Show>
    </box>
  )
}

function OverviewTab(props: {
  detail: ForgeLoopDetail
  context: Plugin.Context
  colors: DashboardColors
}): JSX.Element {
  const spans = createMemo(() => computePhaseSpans(
    props.detail.transitions,
    props.detail.loop.startedAt,
    props.detail.loop.completedAt ?? null,
    props.detail.loop.completedAt ?? Date.now(),
    props.detail.loop.phase,
    props.detail.transitionsCapped,
  ))
  const report = (): string | undefined => props.detail.postActionReport ?? props.detail.completionSummary
  const reportLabel = (): string => (props.detail.postActionReport ? 'Post-action report' : 'Completion summary')
  const amendments = createMemo(() => summarizeAmendments(props.detail.amendments))
  return (
    <box flexDirection="column" paddingTop={1}>
      <PhaseBar spans={spans().spans} truncated={spans().truncated} colors={props.colors} />
      <PhaseLegend spans={spans().spans} colors={props.colors} />
      <Show when={amendments().count > 0}>
        <text fg={props.colors.warning}>
          {`Plan adjusted ${amendments().count}× · last ${formatRelativeTime(amendments().lastAt)} @ section ${formatSectionNumber(amendments().lastSection ?? 0)}`}
        </text>
      </Show>
      <Show when={report()}>
        <MarkdownBlock context={props.context} label={reportLabel()} content={report() ?? ''} colors={props.colors} />
      </Show>
      <Show when={props.detail.lastAuditResult}>
        <MarkdownBlock
          context={props.context}
          label="Last audit result"
          content={props.detail.lastAuditResult ?? ''}
          colors={props.colors}
        />
      </Show>
    </box>
  )
}

function TimelineTab(props: { detail: ForgeLoopDetail; colors: DashboardColors }): JSX.Element {
  const loop = (): ForgeLoopDetailRow => props.detail.loop
  const spans = createMemo(() => computePhaseSpans(
    props.detail.transitions,
    loop().startedAt,
    loop().completedAt ?? null,
    loop().completedAt ?? Date.now(),
    loop().phase,
    props.detail.transitionsCapped,
  ))
  const diagram = createMemo(() => renderLoopMachineDiagram({
    phase: loop().phase,
    status: loop().status,
    running: loop().completedAt === undefined,
    transitions: props.detail.transitions,
  }))
  const recent = createMemo(() => recentTransitionRows(props.detail.transitions, TIMELINE_WINDOW))
  const merged = createMemo(() => mergeTimelineEntries(
    props.detail.transitions,
    props.detail.amendments,
    loop().startedAt,
    spans().truncated,
  ))
  const visible = createMemo(() => merged().slice(0, TIMELINE_WINDOW))
  const hidden = createMemo(() => Math.max(0, merged().length - visible().length))
  return (
    <box flexDirection="column" paddingTop={1}>
      <For each={diagram()}>
        {(row) => (
          <box flexDirection="row">
            <For each={row}>
              {(cell) => (
                <text fg={cell.highlight ? props.colors.info : props.colors.text} wrapMode="none">{cell.text}</text>
              )}
            </For>
          </box>
        )}
      </For>
      <box paddingTop={1}>
        <PhaseBar spans={spans().spans} truncated={spans().truncated} colors={props.colors} />
      </box>
      <PhaseLegend spans={spans().spans} colors={props.colors} />
      <Show when={spans().truncated}>
        <text fg={props.colors.warning}>Earlier history was truncated by the 100-row fetch window.</text>
      </Show>

      <text fg={props.colors.muted} paddingTop={1}>Recent transitions</text>
      <Show when={recent().length === 0} fallback={
        <For each={recent()}>
          {(entry) => (
            <text fg={props.colors.muted}>{`${entry.time} · ${entry.eventType} · ${entry.flow}`}</text>
          )}
        </For>
      }>
        <text fg={props.colors.muted}>No transitions recorded.</text>
      </Show>

      <Show when={props.detail.amendments.length > 0}>
        <text fg={props.colors.muted} paddingTop={1}>Timeline with plan adjustments</text>
        <For each={visible()}>
          {(entry) => renderTimelineEntry(entry, props.colors)}
        </For>
        <Show when={hidden() > 0}>
          <text fg={props.colors.muted}>{`[ ${hidden()} earlier events ]`}</text>
        </Show>
      </Show>
    </box>
  )
}

function renderTimelineEntry(entry: TimelineEntry, colors: DashboardColors): JSX.Element {
  if (entry.kind === 'transition') return renderTimelineTransition(entry.transition, entry.elapsedMs, colors)
  return (
    <text fg={colors.warning}>
      {`${formatRelativeTime(entry.amendment.createdAt)} · plan adjusted @ section ${formatSectionNumber(entry.amendment.appliedAtSection)} · ${entry.amendment.rationale}`}
    </text>
  )
}

function renderTimelineTransition(
  transition: ForgeLoopTransition,
  elapsedMs: number | null,
  colors: DashboardColors,
): JSX.Element {
  const target = transition.toPhase ?? transition.status ?? ''
  const elapsed = elapsedMs === null ? '—' : formatSpanDuration(Math.max(0, elapsedMs))
  return (
    <text fg={colors.muted}>
      {`${formatRelativeTime(transition.createdAt)} · ${phaseLabel(transition.fromPhase)} → ${phaseLabel(target)} · ${transition.transitionKind} · iter ${transition.iteration} · ${elapsed}`}
    </text>
  )
}

function SectionsTab(props: {
  detail: ForgeLoopDetail
  context: Plugin.Context
  colors: DashboardColors
  cursor: Accessor<number>
  expanded: Accessor<number | null>
}): JSX.Element {
  const adjusted = createMemo(() => amendedSectionIndexes(props.detail.amendments))
  return (
    <box flexDirection="column" paddingTop={1}>
      <Show when={props.detail.sections.length === 0}>
        <text fg={props.colors.muted}>No sections recorded for this loop.</text>
      </Show>
      <For each={props.detail.sections}>
        {(section, index) => {
          const selected = () => index() === props.cursor()
          const isExpanded = () => props.expanded() === section.sectionIndex
          const duration = () => formatSectionDuration(section.startedAt, section.completedAt)
          return (
            <box flexDirection="column" paddingBottom={1}>
              <box flexDirection="row" gap={1}>
                {marker(selected, props.colors)}
                <text flexShrink={0} fg={props.colors.muted}>{`#${formatSectionNumber(section.sectionIndex)}`}</text>
                <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>{section.title}</text>
                <text flexShrink={0} fg={section.status === 'completed' ? props.colors.success : props.colors.muted}>
                  {section.status}
                </text>
                <Show when={adjusted().has(section.sectionIndex)}>
                  <text flexShrink={0} fg={props.colors.warning}>adjusted</text>
                </Show>
                <Show when={duration()}>
                  <text flexShrink={0} fg={props.colors.muted}>{duration()}</text>
                </Show>
                <Show when={section.attempts > 0}>
                  <text flexShrink={0} fg={props.colors.muted}>{formatCount(section.attempts, 'attempt')}</text>
                </Show>
                <text flexShrink={0} fg={props.colors.muted}>{isExpanded() ? '▾' : '▸'}</text>
              </box>
              <Show when={isExpanded()}>
                <SectionDetails section={section} context={props.context} colors={props.colors} />
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function SectionDetails(props: {
  section: ForgeSectionPlan
  context: Plugin.Context
  colors: DashboardColors
}): JSX.Element {
  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={props.section.startedAt || props.section.completedAt}>
        <text fg={props.colors.muted}>
          {`${props.section.startedAt ? 'Started ' + fmtTime(props.section.startedAt) : 'Not started'}${props.section.completedAt ? ' → completed ' + fmtTime(props.section.completedAt) : ''}`}
        </text>
      </Show>
      <Show when={props.section.summaryDone}>
        <MarkdownBlock context={props.context} label="Done" content={props.section.summaryDone ?? ''} colors={props.colors} />
      </Show>
      <Show when={props.section.summaryDeviations}>
        <MarkdownBlock
          context={props.context}
          label="Deviations"
          content={props.section.summaryDeviations ?? ''}
          colors={props.colors}
        />
      </Show>
      <Show when={props.section.summaryFollowUps}>
        <MarkdownBlock
          context={props.context}
          label="Follow-ups"
          content={props.section.summaryFollowUps ?? ''}
          colors={props.colors}
        />
      </Show>
      <Show when={props.section.content}>
        <MarkdownBlock context={props.context} label="Section plan" content={props.section.content} colors={props.colors} />
      </Show>
      <Show when={
        !props.section.startedAt
        && !props.section.completedAt
        && !props.section.summaryDone
        && !props.section.summaryDeviations
        && !props.section.summaryFollowUps
        && !props.section.content
      }>
        <text fg={props.colors.muted}>No details captured for this section yet.</text>
      </Show>
    </box>
  )
}

function FindingsTab(props: { detail: ForgeLoopDetail; colors: DashboardColors }): JSX.Element {
  const groups = createMemo(() => groupFindingsBySection(props.detail.findings))
  return (
    <box flexDirection="column" paddingTop={1}>
      <Show when={groups().length === 0}>
        <text fg={props.colors.muted}>No findings recorded for this loop.</text>
      </Show>
      <For each={groups()}>
        {(group) => (
          <box flexDirection="column" paddingBottom={1}>
            <text fg={props.colors.muted}>{group.label}</text>
            <For each={group.rows}>
              {(finding) => (
                <text fg={severityColor(props.colors, finding.severity)} wrapMode="word">
                  {`  ${finding.severity === 'bug' ? '✖' : '▲'} ${formatFinding(finding)}`}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

function PlanTab(props: {
  detail: ForgeLoopDetail
  context: Plugin.Context
  store: DashboardStore
  colors: DashboardColors
  cursor: Accessor<number>
}): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1}>
      <Show
        when={props.detail.plan !== undefined}
        fallback={<text fg={props.colors.muted}>No plan recorded for this loop.</text>}
      >
        <MarkdownBlock context={props.context} label="Plan" content={props.detail.plan ?? ''} colors={props.colors} />
      </Show>
      <Show when={props.detail.amendments.length > 0}>
        <text fg={props.colors.muted} paddingTop={1}>Plan amendments</text>
        <For each={props.detail.amendments}>
          {(amendment, index) => (
            <AmendmentRow
              amendment={amendment}
              selected={() => index() === props.cursor()}
              expanded={() => props.store.expandedAmendmentId() === amendment.id}
              diff={props.store.amendmentDiff}
              colors={props.colors}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

function AmendmentRow(props: {
  amendment: ForgePlanAmendment
  selected: Accessor<boolean>
  expanded: Accessor<boolean>
  diff: Accessor<ForgeAmendmentDiff | null>
  colors: DashboardColors
}): JSX.Element {
  const summary = () => props.amendment.summary
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" gap={1}>
        {marker(props.selected, props.colors)}
        <text flexShrink={0} fg={props.colors.muted}>{formatRelativeTime(props.amendment.createdAt)}</text>
        <text flexShrink={0} fg={props.colors.muted}>{`@ section ${formatSectionNumber(props.amendment.appliedAtSection)}`}</text>
        <text flexShrink={0} fg={props.colors.text}>{props.amendment.source}</text>
        <Show when={summary().added > 0}>
          <text flexShrink={0} fg={props.colors.success}>{`+${summary().added}`}</text>
        </Show>
        <Show when={summary().removed > 0}>
          <text flexShrink={0} fg={props.colors.error}>{`−${summary().removed}`}</text>
        </Show>
        <Show when={summary().modified > 0}>
          <text flexShrink={0} fg={props.colors.warning}>{`~${summary().modified}`}</text>
        </Show>
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.muted}>{props.amendment.rationale}</text>
        <text flexShrink={0} fg={props.colors.muted}>{props.expanded() ? '▾' : '▸'}</text>
      </box>
      <Show when={props.expanded()}>
        <Show when={props.diff()} fallback={<text fg={props.colors.muted}>Loading diff…</text>}>
          {(diff) => <AmendmentDiffView diff={diff()} colors={props.colors} />}
        </Show>
      </Show>
    </box>
  )
}

function AmendmentDiffView(props: { diff: ForgeAmendmentDiff; colors: DashboardColors }): JSX.Element {
  const changed = createMemo(() => props.diff.sections.filter((section) => section.change !== 'unchanged'))
  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={changed().length === 0}>
        <text fg={props.colors.muted}>No section changes recorded.</text>
      </Show>
      <For each={changed()}>
        {(section) => (
          <box flexDirection="column" paddingBottom={1}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={props.colors.muted}>{`#${formatSectionNumber(section.index)}`}</text>
              <text flexShrink={0} fg={changeColor(props.colors, section.change)}>{section.change}</text>
              <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={props.colors.text}>{section.title}</text>
              <Show when={section.previousTitle}>
                <text flexShrink={0} fg={props.colors.muted}>{`was: ${section.previousTitle}`}</text>
              </Show>
            </box>
            <Show when={section.lines.length > 0} fallback={<text fg={props.colors.muted}>Title changed only.</text>}>
              <For each={section.lines}>
                {(line) => (
                  <text fg={diffLineColor(props.colors, line.kind)} wrapMode="none" truncate>
                    {diffLineText(line.kind, line.text)}
                  </text>
                )}
              </For>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

function UsageTab(props: { detail: ForgeLoopDetail; colors: DashboardColors }): JSX.Element {
  const usage = () => props.detail.usage
  const totalTokens = (): number => {
    const value = usage()
    if (!value) return 0
    return value.totalInputTokens
      + value.totalOutputTokens
      + value.totalReasoningTokens
      + value.totalCacheReadTokens
      + value.totalCacheWriteTokens
  }
  return (
    <box flexDirection="column" paddingTop={1}>
      <Show when={usage()} fallback={<text fg={props.colors.muted}>No usage recorded for this loop.</text>}>
        {(value) => (
          <box flexDirection="column">
            <text fg={props.colors.text}>
              {`Total ${formatUsageCost(value().totalCost)} · ${formatTokenCount(totalTokens())} tokens · ${value().totalMessageCount} messages`}
            </text>
            <text fg={props.colors.muted} paddingTop={1}>Role split</text>
            <For each={roleUsageBars(value())}>
              {(bar) => (
                <text fg={props.colors.text}>
                  {`${bar.role.padEnd(10)} ${textBar(bar.pct / 100, USAGE_BAR_WIDTH)} ${formatUsageCost(bar.cost)} · ${bar.messageCount} msg · ${formatTokenCount(bar.tokens)} tok`}
                </text>
              )}
            </For>
            <text fg={props.colors.muted} paddingTop={1}>Token composition</text>
            <For each={tokenBreakdownSegments(value())}>
              {(segment) => (
                <text fg={props.colors.text}>
                  {`${segment.label.padEnd(10)} ${textBar(segment.pct / 100, USAGE_BAR_WIDTH)} ${formatTokenCount(segment.value)} (${Math.round(segment.pct)}%)`}
                </text>
              )}
            </For>
            <text fg={props.colors.muted} paddingTop={1}>Cost by model</text>
            <For each={modelUsageBars(value())}>
              {(bar) => (
                <text fg={props.colors.text}>
                  {`${bar.model} ${textBar(bar.pct / 100, USAGE_BAR_WIDTH)} ${formatUsageCost(bar.cost)} · ${formatTokenCount(bar.inputTokens)} in / ${formatTokenCount(bar.outputTokens)} out · ${bar.messageCount} msg`}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  )
}
