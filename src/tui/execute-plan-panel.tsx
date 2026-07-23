/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { PLAN_EXECUTION_LABELS, describePlanExecutionMode } from '../utils/plan-execution'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { buildDialogSelectOptions, getModelDisplayLabel, getAvailableModelVariants, getVariantDisplayLabel, normalizeVariantForModel, type ModelInfo } from '../utils/tui-models'
import { resolveExecutionDialogDefaults } from '../utils/tui-execution-preferences'
import { type ForgeProjectClient } from '../utils/tui-client'
import { buildExecutionContextSnapshot, type ExecutionContextCache, type ExecutionContextSnapshot } from '../utils/tui-execution-context-cache'
import { withBusyGuard } from '../utils/busy-guard'
import { listRemoteNames } from '../utils/remote-config'
import { runPlanLaunch } from './execute-plan-launch'
import { createLogger } from '../utils/logger'
import { resolveLogPath } from '../storage'
import type { PluginConfig } from '../types'

/** Selection state reported back to the wrapper dialog after every picker round-trip. */
export interface ExecutionSelection {
  executionModel: string
  auditorModel: string
  executionVariant: string
  auditorVariant: string
  loopName: string
  target: string
}

export interface ExecutePlanPanelProps {
  api: TuiPluginApi
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
  initialTarget?: string
  projectDirectory?: string
  onBack: () => void
  onExecuted?: () => void | Promise<void>
  onSelectionChanged: (args: ExecutionSelection) => void
}

export function ExecutePlanPanel(props: ExecutePlanPanelProps) {
  const cache = untrack(() => props.cache)
  const pluginConfig = untrack(() => props.pluginConfig)
  const theme = () => props.api.theme.current

  // Shared plugin log file so remote-launch traces land alongside plugin logs.
  // clearOnInit:false prevents this TUI-side logger from wiping the plugin's log.
  const logger = untrack(() => createLogger({
    enabled: pluginConfig.logging?.enabled ?? false,
    file: pluginConfig.logging?.file || resolveLogPath(),
    debug: pluginConfig.logging?.debug ?? false,
  }, { clearOnInit: false }))

  const openCodeDefaultModel = () => props.api.state.config?.model ?? ''

  const initialSnapshot = cache?.snapshot() ?? null
  const initialDefaults = initialSnapshot?.defaults
    ?? resolveExecutionDialogDefaults(pluginConfig, initialSnapshot?.preferences ?? null)

  const hasInitialOverrides = () => props.initialExecutionModel !== undefined || props.initialAuditorModel !== undefined

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
  const [target] = createSignal(props.initialTarget ?? 'local')
  const remoteNames = listRemoteNames(pluginConfig)
  const hasRemotes = remoteNames.length > 0

  const targetLabel = () => target() === 'local' ? 'Local' : `Remote (${target()})`

  /** Current picker selections, with per-dialog overrides layered on top. */
  const currentSelection = (overrides: Partial<ExecutionSelection> = {}): ExecutionSelection => ({
    executionModel: executionModel(),
    auditorModel: auditorModel(),
    executionVariant: executionVariant(),
    auditorVariant: auditorVariant(),
    loopName: loopName(),
    target: target(),
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

  const openModelDialog = (which: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const currentModels = models()
    if (modelsError() || currentModels.length === 0) {
      props.api.ui.dialog.setSize('large')
      props.api.ui.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }

    const options = buildDialogSelectOptions(currentModels, recents())
    const title = which === 'execution' ? 'Execution Model' : 'Auditor Model'
    const currentValue = which === 'execution' ? executionModel() : auditorModel()

    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={title}
        options={options}
        current={currentValue || ''}
        onSelect={(opt) => {
          const selectedModel = typeof opt.value === 'string' ? opt.value : ''
          // Resolve the effective model for variant normalization:
          // if selected model is empty (use default), resolve against OpenCode default
          const effectiveModelName = selectedModel || openCodeDefaultModel()
          const effectiveModelInfo = models().find(m => m.fullName === effectiveModelName) ?? null
          // Normalize variant against newly selected model
          const normalizedVariant = normalizeVariantForModel(
            which === 'execution' ? executionVariant() : auditorVariant(),
            effectiveModelInfo,
          )
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged(currentSelection(
            which === 'execution'
              ? { executionModel: selectedModel, executionVariant: normalizedVariant }
              : { auditorModel: selectedModel, auditorVariant: normalizedVariant },
          ))
        }}
      />
    ))
  }

  const openVariantDialog = (which: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const model = selectedModelInfo(which)
    if (!model) {
      props.api.ui.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }

    const availableVariants = getAvailableModelVariants(model)
    if (availableVariants.length === 0) {
      props.api.ui.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }

    const currentValue = which === 'execution' ? executionVariant() : auditorVariant()
    const options = [
      { title: 'Use default', value: '', description: 'Use OpenCode/model default variant' },
      ...availableVariants.map(v => ({
        title: v.label,
        value: v.id,
        description: v.description,
      })),
    ]

    const title = which === 'execution' ? 'Execution Variant' : 'Auditor Variant'

    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={title}
        options={options}
        current={currentValue || ''}
        onSelect={(opt) => {
          const selectedVariant = typeof opt.value === 'string' ? opt.value : ''
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged(currentSelection(
            which === 'execution'
              ? { executionVariant: selectedVariant }
              : { auditorVariant: selectedVariant },
          ))
        }}
      />
    ))
  }

  const openLoopNameDialog = () => {
    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="Loop name"
        placeholder="my-feature-loop"
        value={loopName()}
        onConfirm={(name) => {
          const trimmed = name.trim()
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged(currentSelection(trimmed ? { loopName: trimmed } : {}))
        }}
        onCancel={() => {
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged(currentSelection())
        }}
      />
    ))
  }

  const openTargetDialog = () => {
    const options = [
      { title: 'Local', value: 'local' },
      ...remoteNames.map(n => ({ title: `Remote: ${n}`, value: n })),
    ]

    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="Target"
        options={options}
        current={target()}
        onSelect={(opt) => {
          const selected = typeof opt.value === 'string' ? opt.value : 'local'
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged(currentSelection({ target: selected }))
        }}
      />
    ))
  }

  /**
   * Delegates the actual launch (remote + local) to the extracted, testable
   * `runPlanLaunch` orchestration. The panel only contributes its current
   * signal values and props; all label→mode routing, bridge dispatch, and
   * result handling live in one place.
   */
  async function runExecuteMode(mode: string, execModel?: string, auditModel?: string, execVariant?: string, auditVariant?: string): Promise<void> {
    await runPlanLaunch(
      {
        api: props.api,
        client: props.client,
        cache,
        pluginConfig,
        logger,
        sessionId: props.sessionId,
        projectDirectory: props.projectDirectory,
        planContent: props.planContent,
        loopName: loopName(),
        onExecuted: props.onExecuted,
      },
      {
        mode,
        target: target(),
        execModel,
        auditModel,
        execVariant,
        auditVariant,
      },
    )
  }

  // eslint-disable-next-line solid/reactivity
  const handleExecuteMode = withBusyGuard(runExecuteMode, {
    isBusy: busy,
    setBusy,
    onBusy: () => props.api.ui.toast({ message: 'Plan execution already starting...', variant: 'info', duration: 2000 }),
  })

  return (
    <box flexDirection="column" paddingBottom={1} gap={1} minHeight={20} maxHeight="75%">
      <box paddingBottom={1}>
        <text fg={theme().text}><b>Configure and Run Plan</b></text>
      </box>
      <select
        focused={true}
        selectedIndex={0}
        options={[
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
          ...(hasRemotes ? [{
            name: `Target: ${targetLabel()}`,
            description: 'Press enter to choose where the loop runs',
            value: 'target',
          }] : []),
          ...PLAN_EXECUTION_LABELS.map(label => ({
            name: label,
            description: describePlanExecutionMode(label),
            value: `mode:${label}`,
          })),
        ]}
        onSelect={(_, option) => {
          if (option?.value) {
            if (option.value === 'model:execution') {
              openModelDialog('execution')
              return
            }
            if (option.value === 'model:auditor') {
              openModelDialog('auditor')
              return
            }
            if (option.value === 'variant:execution') {
              openVariantDialog('execution')
              return
            }
            if (option.value === 'variant:auditor') {
              openVariantDialog('auditor')
              return
            }
            if (option.value === 'loop-name') {
              openLoopNameDialog()
              return
            }
            if (option.value === 'target') {
              openTargetDialog()
              return
            }
            if (typeof option.value === 'string' && option.value.startsWith('mode:')) {
              handleExecuteMode(option.value.slice(5), executionModel(), auditorModel(), executionVariant(), auditorVariant())
            }
          }
        }}
        showDescription={true}
        itemSpacing={1}
        wrapSelection={true}
        textColor={theme().text}
        focusedTextColor={theme().text}
        selectedTextColor="#ffffff"
        selectedBackgroundColor={theme().borderActive}
        minHeight={16}
        flexGrow={1}
      />
    </box>
  )
}
