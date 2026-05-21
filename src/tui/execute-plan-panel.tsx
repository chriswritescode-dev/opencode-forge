/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { PLAN_EXECUTION_LABELS, type PlanExecutionLabel } from '../utils/plan-execution'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { buildDialogSelectOptions, flattenProviders, getModelDisplayLabel, sortModelsByPriority, getAvailableModelVariants, getVariantDisplayLabel, normalizeVariantForModel, type ModelInfo } from '../utils/tui-models'
import { resolveExecutionDialogDefaults } from '../utils/tui-execution-preferences'
import { selectTuiSession, type ForgeProjectClient } from '../utils/tui-client'
import type { ExecutionContextCache, ExecutionContextSnapshot } from '../utils/tui-execution-context-cache'
import { withBusyGuard } from '../utils/busy-guard'
import type { PluginConfig } from '../types'

export function ExecutePlanPanel(props: {
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
  onBack: () => void
  onExecuted?: () => void | Promise<void>
  onSelectionChanged: (args: {
    executionModel: string
    auditorModel: string
    executionVariant: string
    auditorVariant: string
    loopName: string
  }) => void
}) {
  const cache = untrack(() => props.cache)
  const pluginConfig = untrack(() => props.pluginConfig)
  const theme = () => props.api.theme.current

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
    props.initialLoopName ?? extractPlanExecutionMetadata(props.planContent).executionName,
  )

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
      const inlineDefaults = resolveExecutionDialogDefaults(pluginConfig, ctx.preferences)
      if (ctx.models.error) {
        setModelsError(ctx.models.error)
        applyDefaults(inlineDefaults)
        setModelsLoaded(true)
        return
      }
      const allModelList = flattenProviders(ctx.models.providers as Parameters<typeof flattenProviders>[0])
      const recentsList: string[] = []
      const sorted = sortModelsByPriority(allModelList, {
        recents: recentsList,
        connectedProviderIds: ctx.models.connectedProviderIds,
        configuredProviderIds: ctx.models.configuredProviderIds,
      })
      setRecents(recentsList)
      setModels(sorted)
      applyDefaults(inlineDefaults)
      setModelsLoaded(true)
      // Normalize variants against loaded models
      setExecutionVariant(normalizeVariantForModel(executionVariant(), selectedModelInfo('execution')))
      setAuditorVariant(normalizeVariantForModel(auditorVariant(), selectedModelInfo('auditor')))
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

  const openModelDialog = (target: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const currentModels = models()
    if (modelsError() || currentModels.length === 0) {
      props.api.ui.dialog.setSize('large')
      props.api.ui.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }

    const options = buildDialogSelectOptions(currentModels, recents())
    const title = target === 'execution' ? 'Execution Model' : 'Auditor Model'
    const currentValue = target === 'execution' ? executionModel() : auditorModel()

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
            target === 'execution' ? executionVariant() : auditorVariant(),
            effectiveModelInfo,
          )
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged({
            executionModel: target === 'execution' ? selectedModel : executionModel(),
            auditorModel: target === 'auditor' ? selectedModel : auditorModel(),
            executionVariant: target === 'execution' ? normalizedVariant : executionVariant(),
            auditorVariant: target === 'auditor' ? normalizedVariant : auditorVariant(),
            loopName: loopName(),
          })
        }}
      />
    ))
  }

  const openVariantDialog = (target: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const model = selectedModelInfo(target)
    if (!model) {
      props.api.ui.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }

    const availableVariants = getAvailableModelVariants(model)
    if (availableVariants.length === 0) {
      props.api.ui.toast({ message: 'No variants available for this model', variant: 'info', duration: 3000 })
      return
    }

    const currentValue = target === 'execution' ? executionVariant() : auditorVariant()
    const options = [
      { title: 'Use default', value: '', description: 'Use OpenCode/model default variant' },
      ...availableVariants.map(v => ({
        title: v.label,
        value: v.id,
        description: v.description,
      })),
    ]

    const title = target === 'execution' ? 'Execution Variant' : 'Auditor Variant'

    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={title}
        options={options}
        current={currentValue || ''}
        onSelect={(opt) => {
          const selectedVariant = typeof opt.value === 'string' ? opt.value : ''
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged({
            executionModel: executionModel(),
            auditorModel: auditorModel(),
            executionVariant: target === 'execution' ? selectedVariant : executionVariant(),
            auditorVariant: target === 'auditor' ? selectedVariant : auditorVariant(),
            loopName: loopName(),
          })
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
          const newName = trimmed || loopName()
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged({
            executionModel: executionModel(),
            auditorModel: auditorModel(),
            executionVariant: executionVariant(),
            auditorVariant: auditorVariant(),
            loopName: newName,
          })
        }}
        onCancel={() => {
          props.api.ui.dialog.setSize('xlarge')
          props.onSelectionChanged({
            executionModel: executionModel(),
            auditorModel: auditorModel(),
            executionVariant: executionVariant(),
            auditorVariant: auditorVariant(),
            loopName: loopName(),
          })
        }}
      />
    ))
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

  async function runExecuteMode(mode: string, execModel?: string, auditModel?: string, execVariant?: string, auditVariant?: string): Promise<void> {
    const planText = props.planContent
    const { title } = extractPlanExecutionMetadata(planText)

    const normalizedMode = mode.toLowerCase()
    const matchedLabel = PLAN_EXECUTION_LABELS.find(
      label => normalizedMode === label.toLowerCase() || normalizedMode.startsWith(label.toLowerCase())
    ) ?? null

    const apiMode: import('../utils/tui-client').ApiExecutionMode = matchedLabel === 'Execute here'
      ? 'execute-here'
      : matchedLabel === 'Loop'
        ? 'loop'
        : 'new-session'

    props.api.ui.dialog.clear()
    props.api.ui.toast({ message: 'Executing plan...', variant: 'info', duration: 3000 })
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
    }, {
      mode: matchedLabel as PlanExecutionLabel,
      executionModel: execModel,
      auditorModel: auditModel,
      executionVariant: execVariant,
      auditorVariant: auditVariant,
    })

    if (!result) {
      props.api.ui.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
      return
    }

    cache?.recordRecent(execModel || '')
    cache?.recordRecent(auditModel || '')

    props.api.ui.toast({ message: result.loopName ? `Loop started: ${result.loopName}` : 'Plan execution started', variant: 'success', duration: 3000 })
    await props.onExecuted?.()
    props.client.workspaces.list().catch(() => {})
    if (result.sessionId && (apiMode === 'new-session' || apiMode === 'loop')) {
      await selectTuiSession(props.api, result.sessionId, result.workspaceId)
    }
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
          ...PLAN_EXECUTION_LABELS.map(label => ({
            name: label,
            description: getModeDescription(label),
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
