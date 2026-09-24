/** @jsxImportSource @opentui/solid */
import type { SelectRenderable } from '@opentui/core'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { claimFocusOnMount } from './focus'
import type { ForgeTuiHost } from './host'
import { PLAN_EXECUTION_LABELS } from '../utils/plan-execution'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { buildDialogSelectOptions, getModelDisplayLabel, getAvailableModelVariants, getVariantDisplayLabel, normalizeVariantForModel, type LoopInfo, type ModelInfo } from '../utils/tui-models'
import { resolveExecutionDialogDefaults } from '../utils/tui-execution-preferences'
import type { ForgeProjectClient } from './project-client'
import { buildExecutionContextSnapshot, type ExecutionContextCache, type ExecutionContextSnapshot } from '../utils/tui-execution-context-cache'
import { withBusyGuard } from '../utils/busy-guard'
import type { PluginConfig } from '../types'

/** Selection state reported back to the wrapper dialog after every picker round-trip. */
export interface ExecutionSelection {
  executionModel: string
  auditorModel: string
  executionVariant: string
  auditorVariant: string
  loopName: string
}

export interface ExecutePlanPanelProps {
  host: ForgeTuiHost
  client: ForgeProjectClient
  cache: ExecutionContextCache | null
  pluginConfig: PluginConfig
  planContent: string
  sessionId: string
  initialExecutionModel?: string
  initialAuditorModel?: string
  initialExecutionVariant?: string
  initialAuditorVariant?: string
  initialLoopName?: string
  onBack: () => void
  onExecuted?: () => void | Promise<void>
  onSelectionChanged: (args: ExecutionSelection) => void
  restart?: {
    loops: LoopInfo[]
    onRestart(request: { loopName: string; auditorModel: string; auditorVariant: string; executionModel: string; executionVariant: string }): Promise<void>
  }
}

export function ExecutePlanPanel(props: ExecutePlanPanelProps) {
  const cache = untrack(() => props.cache)
  const pluginConfig = untrack(() => props.pluginConfig)
  const colors = () => props.host.colors()

  const openCodeDefaultModel = () => props.host.defaultModel()

  const initialSnapshot = cache?.snapshot() ?? null
  const initialDefaults = initialSnapshot?.defaults
    ?? resolveExecutionDialogDefaults(pluginConfig, initialSnapshot?.preferences ?? null)

  const hasInitialOverrides = () => props.initialExecutionModel !== undefined || props.initialAuditorModel !== undefined

  let selectRef: SelectRenderable | undefined
  claimFocusOnMount(() => selectRef)

  const [executionModel, setExecutionModel] = createSignal(
    props.initialExecutionModel ?? initialDefaults.executionModel,
  )
  const [auditorModel, setAuditorModel] = createSignal(
    props.initialAuditorModel ?? initialDefaults.auditorModel,
  )
  const [executionVariant, setExecutionVariant] = createSignal(
    props.initialExecutionVariant ?? initialDefaults.executionVariant,
  )
  const [auditorVariant, setAuditorVariant] = createSignal(
    props.initialAuditorVariant ?? initialDefaults.auditorVariant,
  )
  const [models, setModels] = createSignal<ModelInfo[]>(initialSnapshot?.models ?? [])
  const [recents, setRecents] = createSignal<string[]>(initialSnapshot?.recents ?? [])
  const [modelsError, setModelsError] = createSignal<string | undefined>(initialSnapshot?.modelsError)
  const [modelsLoaded, setModelsLoaded] = createSignal(!!initialSnapshot)
  const [busy, setBusy] = createSignal(false)
  const [loopName] = createSignal(
    props.initialLoopName ?? extractPlanExecutionMetadata(untrack(() => props.planContent)).executionName,
  )
  const isRestart = () => props.restart !== undefined
  const selectedLoop = () => props.restart?.loops.find(loop => loop.name === loopName())

  /** Current picker selections, with per-dialog overrides layered on top. */
  const currentSelection = (overrides: Partial<ExecutionSelection> = {}): ExecutionSelection => ({
    executionModel: executionModel(),
    auditorModel: auditorModel(),
    executionVariant: executionVariant(),
    auditorVariant: auditorVariant(),
    loopName: loopName(),
    ...overrides,
  })

  const selectedModelInfo = (target: 'execution' | 'auditor') => {
    const selected = target === 'execution' ? executionModel() : auditorModel()
    const fallback = openCodeDefaultModel()
    const fullName = selected || fallback
    return models().find(m => m.fullName === fullName) ?? null
  }

  const applyDefaults = (defaults: { executionModel: string; auditorModel: string; executionVariant?: string; auditorVariant?: string }) => {
    if (!hasInitialOverrides() && !props.initialExecutionModel && !executionModel()) {
      setExecutionModel(defaults.executionModel)
    }
    if (!hasInitialOverrides() && !props.initialAuditorModel && !auditorModel()) {
      setAuditorModel(defaults.auditorModel)
    }
    if (props.initialExecutionVariant === undefined && !executionVariant()) {
      setExecutionVariant(defaults.executionVariant ?? '')
    }
    if (props.initialAuditorVariant === undefined && !auditorVariant()) {
      setAuditorVariant(defaults.auditorVariant ?? '')
    }
  }

  const applySnapshot = (snap: ExecutionContextSnapshot) => {
    applyDefaults(snap.defaults)
    setModels(snap.models)
    setRecents(snap.recents)
    setModelsError(snap.modelsError)
    setModelsLoaded(true)
    // Normalize variants against loaded models
    setExecutionVariant(normalizeVariantForModel(executionVariant(), selectedModelInfo('execution')))
    setAuditorVariant(normalizeVariantForModel(auditorVariant(), selectedModelInfo('auditor')))
  }

  const loadInline = async () => {
    try {
      const ctx = await props.client.loadExecutionContext()
      const snap = buildExecutionContextSnapshot(props.client.projectId, pluginConfig, ctx)
      applySnapshot(snap)
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Failed to load models')
      setModelsLoaded(true)
    }
  }

  createEffect(() => {
    if (cache) {
      const unsub = cache.onChange((snap) => untrack(() => applySnapshot(snap)))
      onCleanup(unsub)
      const existing = cache.snapshot()
      if (existing) {
        applySnapshot(existing)
      } else {
        void cache.ensureLoaded().catch(() => { void untrack(() => loadInline()) })
      }
    } else {
      void loadInline()
    }
  })

  const reopenWith = (overrides: Partial<ExecutionSelection> | undefined) => {
    props.onSelectionChanged(currentSelection(overrides ?? {}))
  }

  const openModelDialog = async (which: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const currentModels = models()
    if (modelsError() || currentModels.length === 0) {
      props.host.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }

    const selectedModel = await props.host.select({
      title: which === 'execution' ? 'Execution Model' : 'Auditor Model',
      options: buildDialogSelectOptions(currentModels, recents()),
      current: (which === 'execution' ? executionModel() : auditorModel()) || '',
    })
    if (selectedModel === undefined) {
      reopenWith(undefined)
      return
    }
    const effectiveModelName = selectedModel || openCodeDefaultModel()
    const effectiveModelInfo = models().find(m => m.fullName === effectiveModelName) ?? null
    const normalizedVariant = normalizeVariantForModel(
      which === 'execution' ? executionVariant() : auditorVariant(),
      effectiveModelInfo,
    )
    reopenWith(which === 'execution'
      ? { executionModel: selectedModel, executionVariant: normalizedVariant }
      : { auditorModel: selectedModel, auditorVariant: normalizedVariant })
  }

  const openVariantDialog = async (which: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const availableVariants = getAvailableModelVariants(selectedModelInfo(which))
    if (availableVariants.length === 0) {
      props.host.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }

    const selectedVariant = await props.host.select({
      title: which === 'execution' ? 'Execution Variant' : 'Auditor Variant',
      options: [
        { title: 'Use default', value: '', description: 'Use OpenCode/model default variant' },
        ...availableVariants.map(v => ({ title: v.label, value: v.id, description: v.description })),
      ],
      current: (which === 'execution' ? executionVariant() : auditorVariant()) || '',
    })
    if (selectedVariant === undefined) {
      reopenWith(undefined)
      return
    }
    reopenWith(which === 'execution' ? { executionVariant: selectedVariant } : { auditorVariant: selectedVariant })
  }

  const openLoopNameDialog = async () => {
    const restart = props.restart
    if (restart) {
      const name = await props.host.select({
        title: 'Loop',
        options: restart.loops.filter(loop => loop.restartable).map(loop => ({
          title: loop.name,
          value: loop.name,
          description: `${loop.status} · ${loop.phase} · iteration ${loop.iteration}/${loop.maxIterations}`,
        })),
        current: loopName(),
      })
      const selected = restart.loops.find(loop => loop.name === name)
      reopenWith(selected
        ? {
            loopName: selected.name,
            executionModel: selected.executionModel ?? executionModel(),
            executionVariant: selected.executionModel ? selected.executionVariant ?? '' : executionVariant(),
            auditorModel: selected.auditorModel ?? auditorModel(),
            auditorVariant: selected.auditorModel ? selected.auditorVariant ?? '' : auditorVariant(),
          }
        : undefined)
      return
    }
    const name = await props.host.prompt({ title: 'Loop name', placeholder: 'my-feature-loop', value: loopName() })
    const trimmed = name?.trim()
    reopenWith(trimmed ? { loopName: trimmed } : undefined)
  }

  function getModeDescription(label: string): string {
    switch (label) {
      case 'New session':
        return 'Create a new session and send the plan to the code agent'
      case 'Execute here':
        return 'Execute the plan in the current session using the code agent'
      case 'Loop':
        return 'Execute using iterative development loop in an isolated git worktree (Docker sandbox used automatically when available)'
      default:
        return ''
    }
  }

  /**
   * Shared launch tail: surface errors, record recent
   * models, toast success, and notify the host. Returns false on error so
   * callers can stop.
   */
  async function completeLaunch(
    outcome: { error: string } | { message: string },
    execModel?: string,
    auditModel?: string,
  ): Promise<boolean> {
    if ('error' in outcome) {
      props.host.toast({ message: outcome.error, variant: 'error', duration: 10000 })
      return false
    }
    cache?.recordRecent(execModel || '')
    cache?.recordRecent(auditModel || '')
    props.host.toast({ message: outcome.message, variant: 'success', duration: 5000 })
    await props.onExecuted?.()
    return true
  }

  async function runExecuteMode(mode: string, execModel?: string, auditModel?: string, execVariant?: string, auditVariant?: string): Promise<void> {
    const planText = props.planContent
    const { title } = extractPlanExecutionMetadata(planText)

    const normalizedMode = mode.toLowerCase()
    const matchedLabel = PLAN_EXECUTION_LABELS.find(
      label => normalizedMode === label.toLowerCase() || normalizedMode.startsWith(label.toLowerCase())
    ) ?? null

    const apiMode: import('../host/forge-rpc').ForgeExecutionMode = matchedLabel === 'Execute here'
      ? 'execute-here'
      : matchedLabel === 'Loop'
        ? 'loop'
        : 'new-session'

    props.host.clearDialog()
    props.host.toast({ message: 'Executing plan...', variant: 'info', duration: 3000 })
    const result = await props.client.plan.execute(props.sessionId, {
      mode: apiMode,
      title,
      loopName: loopName(),
      plan: planText,
      executionModel: execModel,
      auditorModel: auditModel,
      executionVariant: execVariant,
      auditorVariant: auditVariant,
      targetSessionId: props.sessionId,
    })

    if (!result) {
      props.host.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
      return
    }

    if ('error' in result) {
      await completeLaunch(result)
      return
    }

    await completeLaunch(
      { message: result.loopName ? `Loop started: ${result.loopName}` : 'Plan execution started' },
      execModel,
      auditModel,
    )
    if (result.sessionId && (apiMode === 'new-session' || apiMode === 'loop')) {
      await props.client.selectSession(result.sessionId)
    }
  }

  // eslint-disable-next-line solid/reactivity
  const handleExecuteMode = withBusyGuard(runExecuteMode, {
    isBusy: busy,
    setBusy,
    onBusy: () => props.host.toast({ message: 'Plan execution already starting...', variant: 'info', duration: 2000 }),
  })

  const runRestart = async () => {
    if (!props.restart || !loopName()) return
    try {
      await props.restart.onRestart({
        loopName: loopName(),
        auditorModel: auditorModel(),
        auditorVariant: auditorVariant(),
        executionModel: executionModel(),
        executionVariant: executionVariant(),
      })
      cache?.recordRecent(auditorModel())
      cache?.recordRecent(executionModel())
      props.host.toast({ message: `Loop restarted: ${loopName()}`, variant: 'success', duration: 5000 })
      props.host.clearDialog()
    } catch (err) {
      props.host.toast({ message: err instanceof Error ? err.message : 'Failed to restart loop', variant: 'error', duration: 5000 })
    }
  }

  const options = () => isRestart()
    ? [
        {
          name: `Loop: ${loopName()}`,
          description: 'Press enter to choose a restartable loop',
          value: 'loop-name',
        },
        {
          name: `Execution model: ${getModelDisplayLabel(executionModel(), models(), openCodeDefaultModel())}`,
          description: 'Press enter to change',
          value: 'model:execution',
        },
        {
          name: `Execution variant: ${getVariantDisplayLabel(executionVariant(), selectedModelInfo('execution'))}`,
          description: 'Press enter to change',
          value: 'variant:execution',
        },
        {
          name: `Auditor model: ${getModelDisplayLabel(auditorModel(), models(), openCodeDefaultModel())}`,
          description: 'Press enter to change',
          value: 'model:auditor',
        },
        {
          name: `Auditor variant: ${getVariantDisplayLabel(auditorVariant(), selectedModelInfo('auditor'))}`,
          description: 'Press enter to change',
          value: 'variant:auditor',
        },
        {
          name: selectedLoop()?.restartRequiresForce ? 'Force restart loop' : 'Restart loop',
          description: selectedLoop()?.restartRequiresForce
            ? 'Stops the running session first and resumes persisted progress'
            : 'Resumes from persisted progress',
          value: 'action:restart',
        },
      ]
    : [
        {
          name: `Execution model: ${getModelDisplayLabel(executionModel(), models(), openCodeDefaultModel())}`,
          description: 'Press enter to change',
          value: 'model:execution',
        },
        {
          name: `Execution variant: ${getVariantDisplayLabel(executionVariant(), selectedModelInfo('execution'))}`,
          description: 'Press enter to change',
          value: 'variant:execution',
        },
        {
          name: `Auditor model: ${getModelDisplayLabel(auditorModel(), models(), openCodeDefaultModel())}`,
          description: 'Press enter to change',
          value: 'model:auditor',
        },
        {
          name: `Auditor variant: ${getVariantDisplayLabel(auditorVariant(), selectedModelInfo('auditor'))}`,
          description: 'Press enter to change',
          value: 'variant:auditor',
        },
        {
          name: `Loop name: ${loopName()}`,
          description: 'Press enter to edit the loop name used when launching',
          value: 'loop-name',
        },
        ...PLAN_EXECUTION_LABELS.map(label => ({
          name: label,
          description: getModeDescription(label),
          value: `mode:${label}`,
        })),
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
        options={options()}
        onSelect={(_, option) => {
          if (option?.value) {
            if (option.value === 'model:execution') {
              void openModelDialog('execution')
              return
            }
            if (option.value === 'model:auditor') {
              void openModelDialog('auditor')
              return
            }
            if (option.value === 'variant:execution') {
              void openVariantDialog('execution')
              return
            }
            if (option.value === 'variant:auditor') {
              void openVariantDialog('auditor')
              return
            }
            if (option.value === 'loop-name') {
              void openLoopNameDialog()
              return
            }
            if (typeof option.value === 'string' && option.value.startsWith('mode:')) {
              handleExecuteMode(option.value.slice(5), executionModel(), auditorModel(), executionVariant(), auditorVariant())
              return
            }
            if (option.value === 'action:restart') {
              void withBusyGuard(runRestart, {
                isBusy: busy,
                setBusy,
                onBusy: () => props.host.toast({ message: 'Loop restart already in progress...', variant: 'info', duration: 2000 }),
              })()
            }
          }
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

export type ExecutionDialogOptions = Omit<ExecutePlanPanelProps, 'onBack' | 'onExecuted' | 'onSelectionChanged'>

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

      <ExecutePlanPanel {...props.options} onBack={close} onSelectionChanged={props.onSelectionChanged} />

      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
        <text fg={colors().textMuted} onMouseUp={close}>Close (esc)</text>
      </box>
    </box>
  )
}

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
    openExecutionDialog({
      ...options,
      initialExecutionModel: selection.executionModel,
      initialAuditorModel: selection.auditorModel,
      initialExecutionVariant: selection.executionVariant,
      initialAuditorVariant: selection.auditorVariant,
      initialLoopName: selection.loopName,
    })
  }
  options.host.showDialog('xlarge', () => <ExecutionDialog options={options} onSelectionChanged={reopen} />)
}
