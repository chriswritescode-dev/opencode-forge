/** @jsxImportSource @opentui/solid */
import type { SelectRenderable } from '@opentui/core'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { claimFocusOnMount } from './focus'
import type { ForgeTuiHost } from './host'
import { PLAN_EXECUTION_LABELS, extractPlanExecutionMetadata, type PlanExecutionLabel } from '../utils/plan-execution'
import { normalizePastedPlanText } from '../utils/marked-plan-parser'
import { buildDialogSelectOptions, getModelDisplayLabel, getAvailableModelVariants, getVariantDisplayLabel, normalizeVariantForModel, type LoopInfo, type ModelInfo } from '../utils/tui-models'
import { resolveExecutionDialogDefaults } from '../utils/tui-execution-preferences'
import type { ForgeExecutionMode, ForgeLoopDefaults, ForgeLoopRestartInput } from '../host/forge-rpc'
import type { ForgeProjectClient } from './project-client'
import { buildExecutionContextSnapshot, type ExecutionContextCache, type ExecutionContextSnapshot } from '../utils/tui-execution-context-cache'
import { withBusyGuard } from '../utils/busy-guard'
import type { PluginConfig } from '../types'
import { editLoopSettings, formatLoopSettingsSummary, toLoopLaunchRequest, type LoopLaunchSettings } from './loop-settings-dialog'

/** Dialog state carried across every picker round-trip, which closes and reopens the dialog. */
export interface ExecutionSelection {
  executionModel: string
  auditorModel: string
  executionVariant: string
  auditorVariant: string
  loopName: string
  planContent: string
  loopSettings: LoopLaunchSettings
}

type ModelRole = 'execution' | 'auditor'

const MODE_API: Record<PlanExecutionLabel, ForgeExecutionMode> = {
  'New session': 'new-session',
  'Execute here': 'execute-here',
  Loop: 'loop',
}

const MODE_DESCRIPTIONS: Record<PlanExecutionLabel, string> = {
  'New session': 'Create a new session and send the plan to the code agent',
  'Execute here': 'Execute the plan in the current session using the code agent',
  Loop: 'Run an iterative coding/auditing loop in an isolated git worktree, using the loop settings above',
}

export interface ExecutePlanPanelProps {
  host: ForgeTuiHost
  client: ForgeProjectClient
  cache: ExecutionContextCache | null
  pluginConfig: PluginConfig
  planContent: string
  sessionId: string
  initial?: Partial<Omit<ExecutionSelection, 'planContent'>>
  onExecuted?: () => void | Promise<void>
  onSelectionChanged: (selection: ExecutionSelection) => void
  /** Execute mode only: switches to the restart dialog. */
  onOpenRestart?: () => void | Promise<void>
  restart?: {
    loops: LoopInfo[]
    onRestart(request: Omit<ForgeLoopRestartInput, 'executionModel' | 'executionVariant' | 'force'> & Required<Pick<ForgeLoopRestartInput, 'executionModel' | 'executionVariant' | 'force'>>): Promise<void>
  }
}

export function ExecutePlanPanel(props: ExecutePlanPanelProps) {
  const cache = untrack(() => props.cache)
  const pluginConfig = untrack(() => props.pluginConfig)
  const initial = untrack(() => props.initial) ?? {}
  const planContent = untrack(() => props.planContent)
  const colors = () => props.host.colors()
  const openCodeDefaultModel = () => props.host.defaultModel()

  const initialSnapshot = cache?.snapshot() ?? null
  const initialDefaults = initialSnapshot?.defaults
    ?? resolveExecutionDialogDefaults(pluginConfig, initialSnapshot?.preferences ?? null)

  let selectRef: SelectRenderable | undefined
  claimFocusOnMount(() => selectRef)

  const [executionModel, setExecutionModel] = createSignal(initial.executionModel ?? initialDefaults.executionModel)
  const [auditorModel, setAuditorModel] = createSignal(initial.auditorModel ?? initialDefaults.auditorModel)
  const [executionVariant, setExecutionVariant] = createSignal(initial.executionVariant ?? initialDefaults.executionVariant)
  const [auditorVariant, setAuditorVariant] = createSignal(initial.auditorVariant ?? initialDefaults.auditorVariant)
  const [models, setModels] = createSignal<ModelInfo[]>(initialSnapshot?.models ?? [])
  const [recents, setRecents] = createSignal<string[]>(initialSnapshot?.recents ?? [])
  const [modelsError, setModelsError] = createSignal<string | undefined>(initialSnapshot?.modelsError)
  const [modelsLoaded, setModelsLoaded] = createSignal(!!initialSnapshot)
  const [loopDefaults, setLoopDefaults] = createSignal<ForgeLoopDefaults | null>(initialSnapshot?.loopDefaults ?? null)
  const [busy, setBusy] = createSignal(false)
  const loopName = initial.loopName ?? (planContent ? extractPlanExecutionMetadata(planContent).executionName : '')
  const loopSettings = initial.loopSettings ?? {}
  const isRestart = () => props.restart !== undefined
  const selectedLoop = () => props.restart?.loops.find(loop => loop.name === loopName)

  const currentSelection = (overrides: Partial<ExecutionSelection> = {}): ExecutionSelection => ({
    executionModel: executionModel(),
    auditorModel: auditorModel(),
    executionVariant: executionVariant(),
    auditorVariant: auditorVariant(),
    loopName,
    planContent,
    loopSettings,
    ...overrides,
  })

  const reopenWith = (overrides?: Partial<ExecutionSelection>) => props.onSelectionChanged(currentSelection(overrides))

  const modelOf = (role: ModelRole) => role === 'execution' ? executionModel() : auditorModel()
  const variantOf = (role: ModelRole) => role === 'execution' ? executionVariant() : auditorVariant()
  const modelInfoFor = (fullName: string) => models().find(m => m.fullName === (fullName || openCodeDefaultModel())) ?? null

  const hasInitialModels = initial.executionModel !== undefined || initial.auditorModel !== undefined

  const applySnapshot = (snap: ExecutionContextSnapshot) => {
    if (!hasInitialModels && !executionModel()) setExecutionModel(snap.defaults.executionModel)
    if (!hasInitialModels && !auditorModel()) setAuditorModel(snap.defaults.auditorModel)
    if (initial.executionVariant === undefined && !executionVariant()) setExecutionVariant(snap.defaults.executionVariant ?? '')
    if (initial.auditorVariant === undefined && !auditorVariant()) setAuditorVariant(snap.defaults.auditorVariant ?? '')
    setModels(snap.models)
    setRecents(snap.recents)
    setModelsError(snap.modelsError)
    setLoopDefaults(snap.loopDefaults)
    setModelsLoaded(true)
    setExecutionVariant(normalizeVariantForModel(executionVariant(), modelInfoFor(executionModel())))
    setAuditorVariant(normalizeVariantForModel(auditorVariant(), modelInfoFor(auditorModel())))
  }

  const loadInline = async () => {
    try {
      const ctx = await props.client.loadExecutionContext()
      applySnapshot(buildExecutionContextSnapshot(props.client.projectId, pluginConfig, ctx))
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Failed to load models')
      setModelsLoaded(true)
    }
  }

  createEffect(() => {
    if (!cache) {
      void loadInline()
      return
    }
    const unsub = cache.onChange((snap) => untrack(() => applySnapshot(snap)))
    onCleanup(unsub)
    const existing = cache.snapshot()
    if (existing) applySnapshot(existing)
    else void cache.ensureLoaded().catch(() => { void untrack(() => loadInline()) })
  })

  const openModelDialog = async (role: ModelRole) => {
    if (!modelsLoaded()) return
    if (modelsError() || models().length === 0) {
      props.host.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }
    const selected = await props.host.select({
      title: role === 'execution' ? 'Execution Model' : 'Auditor Model',
      options: buildDialogSelectOptions(models(), recents()),
      current: modelOf(role) || '',
    })
    if (selected === undefined) return reopenWith()
    const variant = normalizeVariantForModel(variantOf(role), modelInfoFor(selected))
    reopenWith(role === 'execution'
      ? { executionModel: selected, executionVariant: variant }
      : { auditorModel: selected, auditorVariant: variant })
  }

  const openVariantDialog = async (role: ModelRole) => {
    if (!modelsLoaded()) return
    const variants = getAvailableModelVariants(modelInfoFor(modelOf(role)))
    if (variants.length === 0) {
      props.host.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }
    const selected = await props.host.select({
      title: role === 'execution' ? 'Execution Variant' : 'Auditor Variant',
      options: [
        { title: 'Use default', value: '', description: 'Use OpenCode/model default variant' },
        ...variants.map(v => ({ title: v.label, value: v.id, description: v.description })),
      ],
      current: variantOf(role) || '',
    })
    if (selected === undefined) return reopenWith()
    reopenWith(role === 'execution' ? { executionVariant: selected } : { auditorVariant: selected })
  }

  const openRestartLoopPicker = async (loops: LoopInfo[]) => {
    const name = await props.host.select({
      title: 'Loop',
      options: loops.filter(loop => loop.restartable).map(loop => ({
        title: loop.name,
        value: loop.name,
        description: `${loop.status} · ${loop.phase} · iteration ${loop.iteration}/${loop.maxIterations}`,
      })),
      current: loopName,
    })
    const selected = loops.find(loop => loop.name === name)
    if (!selected) return reopenWith()
    reopenWith({
      loopName: selected.name,
      executionModel: selected.executionModel ?? executionModel(),
      executionVariant: selected.executionModel ? selected.executionVariant ?? '' : executionVariant(),
      auditorModel: selected.auditorModel ?? auditorModel(),
      auditorVariant: selected.auditorModel ? selected.auditorVariant ?? '' : auditorVariant(),
    })
  }

  const openLoopNameDialog = async () => {
    const name = await props.host.prompt({ title: 'Loop name', placeholder: 'my-feature-loop', value: loopName })
    const trimmed = name?.trim()
    reopenWith(trimmed ? { loopName: trimmed } : undefined)
  }

  const openPastePlanDialog = async () => {
    const pasted = await props.host.prompt({ title: 'Paste plan', placeholder: 'Paste a marked or unmarked implementation plan', value: '' })
    if (pasted === undefined) return reopenWith()
    const normalized = normalizePastedPlanText(pasted)
    if (!normalized.ok) {
      props.host.toast({
        message: normalized.reason === 'empty' ? 'Paste a plan before executing' : `Invalid plan markers: ${normalized.reason}`,
        variant: 'error',
        duration: 4000,
      })
      return reopenWith()
    }
    reopenWith({ planContent: normalized.planText, loopName: extractPlanExecutionMetadata(normalized.planText).executionName })
  }

  const openLoopSettingsDialog = async () => {
    reopenWith({ loopSettings: await editLoopSettings(props.host, loopSettings, loopDefaults()) })
  }

  async function runExecuteMode(label: PlanExecutionLabel): Promise<void> {
    if (!planContent) {
      props.host.toast({ message: 'Paste a plan before executing', variant: 'info', duration: 3000 })
      await openPastePlanDialog()
      return
    }
    const mode = MODE_API[label]
    const execModel = executionModel()
    const auditModel = auditorModel()
    props.host.clearDialog()
    props.host.toast({ message: 'Executing plan...', variant: 'info', duration: 3000 })
    const result = await props.client.plan.execute(props.sessionId, {
      mode,
      title: extractPlanExecutionMetadata(planContent).title,
      loopName,
      plan: planContent,
      executionModel: execModel,
      auditorModel: auditModel,
      executionVariant: executionVariant(),
      auditorVariant: auditorVariant(),
      targetSessionId: props.sessionId,
      ...(mode === 'loop' ? toLoopLaunchRequest(loopSettings, loopDefaults()) : {}),
    })
    if (!result) {
      props.host.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
      return
    }
    if ('error' in result) {
      props.host.toast({ message: result.error, variant: 'error', duration: 10000 })
      return
    }
    cache?.recordRecent(execModel)
    cache?.recordRecent(auditModel)
    props.host.toast({ message: result.loopName ? `Loop started: ${result.loopName}` : 'Plan execution started', variant: 'success', duration: 5000 })
    await props.onExecuted?.()
    if (result.sessionId && mode !== 'execute-here') await props.client.selectSession(result.sessionId)
  }

  const runRestart = async () => {
    if (!props.restart || !loopName) return
    try {
      await props.restart.onRestart({
        loopName,
        auditorModel: auditorModel(),
        auditorVariant: auditorVariant(),
        executionModel: executionModel(),
        executionVariant: executionVariant(),
        force: !!selectedLoop()?.restartRequiresForce,
        expectedStartedAt: selectedLoop()?.startedAt,
      })
      cache?.recordRecent(auditorModel())
      cache?.recordRecent(executionModel())
      props.host.toast({ message: `Loop restarted: ${loopName}`, variant: 'success', duration: 5000 })
      props.host.clearDialog()
    } catch (err) {
      props.host.toast({ message: err instanceof Error ? err.message : 'Failed to restart loop', variant: 'error', duration: 5000 })
    }
  }

  // eslint-disable-next-line solid/reactivity
  const handleExecuteMode = withBusyGuard(runExecuteMode, {
    isBusy: busy,
    setBusy,
    onBusy: () => props.host.toast({ message: 'Plan execution already starting...', variant: 'info', duration: 2000 }),
  })

  // eslint-disable-next-line solid/reactivity
  const handleRestart = withBusyGuard(runRestart, {
    isBusy: busy,
    setBusy,
    onBusy: () => props.host.toast({ message: 'Loop restart already in progress...', variant: 'info', duration: 2000 }),
  })

  const actions: Record<string, () => void> = {
    'plan': () => { void openPastePlanDialog() },
    'model:execution': () => { void openModelDialog('execution') },
    'variant:execution': () => { void openVariantDialog('execution') },
    'model:auditor': () => { void openModelDialog('auditor') },
    'variant:auditor': () => { void openVariantDialog('auditor') },
    'loop-name': () => { void (props.restart ? openRestartLoopPicker(props.restart.loops) : openLoopNameDialog()) },
    'loop-settings': () => { void openLoopSettingsDialog() },
    'action:restart': () => { handleRestart() },
    'action:open-restart': () => { void props.onOpenRestart?.() },
    ...Object.fromEntries(PLAN_EXECUTION_LABELS.map(label => [`mode:${label}`, () => { handleExecuteMode(label) }])),
  }

  const modelRows = () => (['execution', 'auditor'] as const).flatMap(role => {
    const label = role === 'execution' ? 'Execution' : 'Auditor'
    return [
      { name: `${label} model: ${getModelDisplayLabel(modelOf(role), models(), openCodeDefaultModel())}`, description: 'Press enter to change', value: `model:${role}` },
      { name: `${label} variant: ${getVariantDisplayLabel(variantOf(role), modelInfoFor(modelOf(role)))}`, description: 'Press enter to change', value: `variant:${role}` },
    ]
  })

  const restartRows = () => [
    { name: `Loop: ${loopName}`, description: 'Press enter to choose a restartable loop', value: 'loop-name' },
    ...modelRows(),
    {
      name: selectedLoop()?.restartRequiresForce ? 'Force restart loop' : 'Restart loop',
      description: selectedLoop()?.restartRequiresForce
        ? 'Stops the running session first and resumes persisted progress'
        : 'Resumes from persisted progress',
      value: 'action:restart',
    },
  ]

  const executeRows = () => [
    {
      name: planContent ? `Plan: ${extractPlanExecutionMetadata(planContent).title}` : 'Plan: none',
      description: planContent ? 'Press enter to paste a different plan' : 'Press enter to paste a plan',
      value: 'plan',
    },
    ...modelRows(),
    { name: `Loop name: ${loopName || '(from plan)'}`, description: 'Press enter to edit the loop name used when launching', value: 'loop-name' },
    { name: `Loop settings: ${formatLoopSettingsSummary(loopSettings, loopDefaults())}`, description: 'Press enter to change iterations and sandbox settings for Loop mode', value: 'loop-settings' },
    ...PLAN_EXECUTION_LABELS.map(label => ({ name: label, description: MODE_DESCRIPTIONS[label], value: `mode:${label}` })),
    ...(props.onOpenRestart ? [{ name: 'Restart a loop…', description: 'Resume a stopped or running loop from persisted progress', value: 'action:open-restart' }] : []),
  ]

  return (
    <box flexDirection="column" paddingBottom={1} gap={1} minHeight={20} maxHeight="75%">
      <box paddingBottom={1}>
        <text fg={colors().text}><b>{isRestart() ? 'Configure and Restart Loop' : 'Configure and Run Plan'}</b></text>
      </box>
      <select
        ref={(el) => { selectRef = el }}
        focused={true}
        selectedIndex={0}
        options={isRestart() ? restartRows() : executeRows()}
        onSelect={(_, option) => {
          if (typeof option?.value === 'string') actions[option.value]?.()
        }}
        showDescription={true}
        itemSpacing={1}
        wrapSelection={true}
        textColor={colors().text}
        focusedTextColor={colors().text}
        selectedTextColor={colors().selectedText}
        selectedBackgroundColor={colors().selectedBackground}
        minHeight={16}
        flexGrow={1}
      />
    </box>
  )
}

export type ExecutionDialogOptions = Omit<ExecutePlanPanelProps, 'onExecuted' | 'onSelectionChanged'>

function ExecutionDialog(props: { options: ExecutionDialogOptions; onSelectionChanged: (selection: ExecutionSelection) => void }) {
  const colors = () => props.options.host.colors()
  const close = () => props.options.host.clearDialog()

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={colors().text}>
          <b>{props.options.restart ? 'Restart loop' : 'Execute plan'}</b>
        </text>
      </box>

      <ExecutePlanPanel {...props.options} onSelectionChanged={props.onSelectionChanged} />

      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
        <text fg={colors().textMuted} onMouseUp={close}>Close (esc)</text>
      </box>
    </box>
  )
}

/** Opens the execution dialog; every picker round-trip reopens it with the carried selection. */
export function openExecutionDialog(options: ExecutionDialogOptions): void {
  const reopen = (selection: ExecutionSelection) => {
    if (!options.restart) {
      options.cache?.setSelectionOverride({
        executionModel: selection.executionModel,
        auditorModel: selection.auditorModel,
        executionVariant: selection.executionVariant,
        auditorVariant: selection.auditorVariant,
      })
    }
    const { planContent, ...initial } = selection
    openExecutionDialog({ ...options, planContent, initial })
  }
  options.host.showDialog('xlarge', () => <ExecutionDialog options={options} onSelectionChanged={reopen} />)
}
