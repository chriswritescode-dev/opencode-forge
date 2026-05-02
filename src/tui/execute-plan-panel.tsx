/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { PLAN_EXECUTION_LABELS, matchExecutionLabel, type PlanExecutionLabel } from '../utils/plan-execution'
import { extractPlanTitle } from '../utils/plan-execution'
import { buildDialogSelectOptions, flattenProviders, getModelDisplayLabel, sortModelsByPriority, type ModelInfo } from '../utils/tui-models'
import { resolveExecutionDialogDefaults } from '../utils/tui-execution-preferences'
import type { ForgeProjectClient } from '../utils/tui-client'
import type { ExecutionContextCache } from '../utils/tui-execution-context-cache'
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
  onBack: () => void
  onExecuted: () => void | Promise<void>
  onModelSelected: (args: {
    target: 'execution' | 'auditor'
    selectedModel: string
    executionModel: string
    auditorModel: string
  }) => void
}) {
  const theme = () => props.api.theme.current

  const initialSnapshot = props.cache?.snapshot() ?? null
  const initialDefaults = initialSnapshot?.defaults
    ?? resolveExecutionDialogDefaults(props.pluginConfig, initialSnapshot?.preferences ?? null)

  const hasInitialOverrides = () => props.initialExecutionModel !== undefined || props.initialAuditorModel !== undefined

  const [executionModel, setExecutionModel] = createSignal(
    props.initialExecutionModel ?? initialDefaults.executionModel,
  )
  const [auditorModel, setAuditorModel] = createSignal(
    props.initialAuditorModel ?? initialDefaults.auditorModel,
  )
  const [models, setModels] = createSignal<ModelInfo[]>(initialSnapshot?.models ?? [])
  const [recents, setRecents] = createSignal<string[]>(initialSnapshot?.recents ?? [])
  const [favorites, setFavorites] = createSignal<string[]>(initialSnapshot?.favorites ?? [])
  const [modelsError, setModelsError] = createSignal<string | undefined>(initialSnapshot?.modelsError)
  const [modelsLoaded, setModelsLoaded] = createSignal(!!initialSnapshot)

  const loadContext = async () => {
    if (props.cache) {
      const snap = await props.cache.ensureLoaded()
      if (!hasInitialOverrides() && !props.initialExecutionModel && !executionModel()) {
        setExecutionModel(snap.defaults.executionModel)
      }
      if (!hasInitialOverrides() && !props.initialAuditorModel && !auditorModel()) {
        setAuditorModel(snap.defaults.auditorModel)
      }
      setModels(snap.models)
      setRecents(snap.recents)
      setFavorites(snap.favorites)
      setModelsError(snap.modelsError)
      setModelsLoaded(true)
    } else {
      const ctx = await props.client.loadExecutionContext()
      if (ctx.models.error) {
        setModelsError(ctx.models.error)
        setModelsLoaded(true)
        return
      }
      const allModelList = flattenProviders(ctx.models.providers as Parameters<typeof flattenProviders>[0])
      const recentsList: string[] = []
      const favoritesList = ctx.models.favoriteModels || []
      setRecents(recentsList)
      setFavorites(favoritesList)
      const sorted = sortModelsByPriority(allModelList, {
        favorites: favoritesList,
        recents: recentsList,
        connectedProviderIds: ctx.models.connectedProviderIds,
        configuredProviderIds: ctx.models.configuredProviderIds,
      })
      setModels(sorted)
      setModelsLoaded(true)
    }
  }

    
  createEffect(() => {
    if (props.cache) {
      const unsub = props.cache.onChange(() => {
        const snap = props.cache?.snapshot()
        if (snap) {
          if (!hasInitialOverrides() && !props.initialExecutionModel && executionModel() === initialDefaults.executionModel) {
            setExecutionModel(snap.defaults.executionModel)
          }
          if (!hasInitialOverrides() && !props.initialAuditorModel && auditorModel() === initialDefaults.auditorModel) {
            setAuditorModel(snap.defaults.auditorModel)
          }
          setModels(snap.models)
          setRecents(snap.recents)
          setFavorites(snap.favorites)
          setModelsError(snap.modelsError)
          setModelsLoaded(true)
        }
      })
      onCleanup(unsub)
    } else {
      void loadContext()
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

    const options = buildDialogSelectOptions(currentModels, recents(), favorites())
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
          props.api.ui.dialog.setSize('xlarge')
          props.onModelSelected({
            target,
            selectedModel,
            executionModel: executionModel(),
            auditorModel: auditorModel(),
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
      case 'Loop (worktree)':
        return 'Execute using iterative development loop in an isolated git worktree'
      case 'Loop':
        return 'Execute using iterative development loop in the current directory'
      default:
        return ''
    }
  }

  const handleExecuteMode = async (mode: string, execModel?: string, auditModel?: string) => {
    const planText = props.planContent
    const title = extractPlanTitle(planText)

    const matchedLabel = matchExecutionLabel(mode)

    const apiMode: import('../utils/tui-client').ApiExecutionMode = matchedLabel === 'Execute here'
      ? 'execute-here'
      : matchedLabel === 'Loop'
        ? 'loop'
        : matchedLabel === 'Loop (worktree)'
          ? 'loop-worktree'
          : 'new-session'

    props.api.ui.dialog.clear()
    props.api.ui.toast({ message: 'Executing plan...', variant: 'info', duration: 3000 })
    const result = await props.client.plan.execute(props.sessionId, {
      mode: apiMode,
      title,
      plan: planText,
      executionModel: execModel,
      auditorModel: auditModel,
      targetSessionId: props.sessionId,
    }, {
      mode: matchedLabel as PlanExecutionLabel,
      executionModel: execModel,
      auditorModel: auditModel,
    })

    if (!result) {
      props.api.ui.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
      return
    }

    props.cache?.recordRecent(execModel || '')
    props.cache?.recordRecent(auditModel || '')

    props.api.ui.toast({ message: result.loopName ? `Loop started: ${result.loopName}` : 'Plan execution started', variant: 'success', duration: 3000 })
    await props.onExecuted()
    if (result.sessionId && (apiMode === 'new-session' || apiMode === 'loop-worktree' || apiMode === 'loop')) {
      try {
        await props.api.client.tui.selectSession({ sessionID: result.sessionId })
      } catch {
        try { props.api.route.navigate('session', { sessionID: result.sessionId }) } catch {}
      }
    }
  }

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
            name: `Execution model: ${getModelDisplayLabel(executionModel(), models())}`,
            description: 'Press enter to change',
            value: 'model:execution',
          },
          {
            name: `Auditor model: ${getModelDisplayLabel(auditorModel(), models())}`,
            description: 'Press enter to change',
            value: 'model:auditor',
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
            if (typeof option.value === 'string' && option.value.startsWith('mode:')) {
              handleExecuteMode(option.value.slice(5), executionModel(), auditorModel())
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
