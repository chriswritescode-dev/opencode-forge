/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, For } from 'solid-js'
import { SyntaxStyle, type TextareaRenderable } from '@opentui/core'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { VERSION } from './version'
import { loadPluginConfig } from './setup'
import { fetchSessionStats, type SessionStats } from './utils/session-stats'
import { slugify } from './utils/logger'
import { extractPlanTitle, PLAN_EXECUTION_LABELS, matchExecutionLabel, type PlanExecutionLabel } from './utils/plan-execution'
import { formatGraphStatus } from './utils/tui-graph-status'
import { shouldPollSidebar, type LoopInfo } from './utils/tui-refresh-helpers'
import { resolveExecutionDialogDefaults } from './utils/tui-execution-preferences'
import { flattenProviders, buildDialogSelectOptions, getModelDisplayLabel, sortModelsByPriority, type ModelInfo } from './utils/tui-models'
import { formatDuration, formatTokens, truncate, truncateMiddle } from './utils/format'
import { resolveForgeApiUrl, connectForgeProject, type ApiExecutionMode, type ForgeProjectClient } from './utils/tui-client'

type TuiKeybinds = {
  viewPlan: string
  executePlan: string
  showLoops: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  viewPlan: '<leader>v',
  executePlan: '<leader>e',
  showLoops: '<leader>w',
}

type TuiOptions = {
  sidebar: boolean
  showLoops: boolean
  showVersion: boolean
  keybinds: TuiKeybinds
}
function PlanViewerDialog(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  planContent: string
  sessionId: string
  onRefresh?: () => void | Promise<void>
  startInExecuteMode?: boolean
  initialExecutionModel?: string
  initialAuditorModel?: string
}) {
  const theme = () => props.api.theme.current
  const [editing, setEditing] = createSignal(false)
  const [executing, setExecuting] = createSignal(props.startInExecuteMode ?? false)
  const [content, setContent] = createSignal(props.planContent)
  const [defaultsLoaded, setDefaultsLoaded] = createSignal(false)
  const [allModels, setAllModels] = createSignal<ModelInfo[]>([])
  const [modelsLoaded, setModelsLoaded] = createSignal(false)
  const [modelsError, setModelsError] = createSignal<string | undefined>(undefined)
  const [executionModel, setExecutionModel] = createSignal<string>(props.initialExecutionModel ?? '')
  const [auditorModel, setAuditorModel] = createSignal<string>(props.initialAuditorModel ?? '')
  const [recentModelIds, setRecentModelIds] = createSignal<string[]>([])
  let textareaRef: TextareaRenderable | undefined

  const hasInitialOverrides = props.initialExecutionModel !== undefined || props.initialAuditorModel !== undefined

  const loadContext = async () => {
    const ctx = await props.client.loadExecutionContext()
    // defaults
    const defaults = resolveExecutionDialogDefaults(
      { logging: { enabled: false, file: '' } },
      ctx.preferences,
    )
    if (!hasInitialOverrides) {
      setExecutionModel(defaults.executionModel)
      setAuditorModel(defaults.auditorModel)
    }
    setDefaultsLoaded(true)
    // models
    if (ctx.models.error) {
      setModelsError(ctx.models.error)
      setModelsLoaded(true)
      return
    }
    const allModelList = flattenProviders(ctx.models.providers as Parameters<typeof flattenProviders>[0])
    const recents: string[] = []
    setRecentModelIds(recents)
    const sorted = sortModelsByPriority(allModelList, {
      recents,
      connectedProviderIds: ctx.models.connectedProviderIds,
      configuredProviderIds: ctx.models.configuredProviderIds,
    })
    setAllModels(sorted)
    setModelsLoaded(true)
  }

  void loadContext().catch((err) => {
    console.error('[forge] PlanViewerDialog: loadContext failed', err)
    setDefaultsLoaded(true)
    setModelsLoaded(true)
  })

  const handleSave = async () => {
    const text = textareaRef?.plainText ?? content()
    const saved = await props.client.plan.write(props.sessionId, text)
    props.api.ui.toast({
      message: saved ? 'Plan saved' : 'Failed to save plan',
      variant: saved ? 'success' : 'error',
      duration: 3000,
    })
    if (saved) {
      setContent(text)
      setEditing(false)
    }
  }

  const handleExport = () => {
    const planText = content()
    const title = extractPlanTitle(planText)
    const slugifiedTitle = slugify(title)
    const directory = props.api.state.path.directory
    const filename = `${slugifiedTitle}.md`
    const filepath = join(directory, filename)

    try {
      writeFileSync(filepath, planText, 'utf-8')
      props.api.ui.toast({
        message: `Exported plan to ${filename}`,
        variant: 'success',
        duration: 3000,
      })
    } catch (error) {
      props.api.ui.toast({
        message: `Failed to export plan: ${(error as Error).message}`,
        variant: 'error',
        duration: 3000,
      })
    }
  }

  const openModelDialog = (target: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const models = allModels()
    if (modelsError() || models.length === 0) {
      props.api.ui.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }

    const options = buildDialogSelectOptions(models, recentModelIds())
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
          props.api.ui.dialog.replace(() => (
            <PlanViewerDialog
              api={props.api}
              client={props.client}
              planContent={content()}
              sessionId={props.sessionId}
              onRefresh={props.onRefresh}
              startInExecuteMode={true}
              initialExecutionModel={target === 'execution' ? selectedModel : executionModel()}
              initialAuditorModel={target === 'auditor' ? selectedModel : auditorModel()}
            />
          ))
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

  const handleExecuteMode = async (mode: string, executionModel?: string, auditorModel?: string) => {
    const planText = content()
    const title = extractPlanTitle(planText)

    // Use canonical label matching instead of fragile string comparison
    const matchedLabel = matchExecutionLabel(mode)

    const apiMode: ApiExecutionMode = matchedLabel === 'Execute here'
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
      executionModel,
      auditorModel,
      targetSessionId: props.sessionId,
    }, {
      mode: matchedLabel as PlanExecutionLabel,
      executionModel,
      auditorModel,
    })

    if (!result) {
      props.api.ui.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
      return
    }

    props.api.ui.toast({ message: result.loopName ? `Loop started: ${result.loopName}` : 'Plan execution started', variant: 'success', duration: 3000 })
    props.onRefresh?.()
    if (result.sessionId && (apiMode === 'new-session' || apiMode === 'loop-worktree' || apiMode === 'loop')) {
      try { props.api.route.navigate('session', { sessionID: result.sessionId }) } catch {}
    }
  }



  const tabIndex = () => executing() ? 2 : editing() ? 1 : 0
  let tabRef: import('@opentui/core').TabSelectRenderable | undefined

  createEffect(() => {
    const idx = tabIndex()
    tabRef?.setSelectedIndex(idx)
  })

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1}>
        <tab_select
          ref={(el: import('@opentui/core').TabSelectRenderable) => { tabRef = el }}
          focused={!editing() && !executing()}
          options={[
            { name: 'View', description: 'View plan', value: 'view' },
            { name: 'Edit', description: 'Edit plan', value: 'edit' },
            { name: 'Execute', description: 'Execute plan', value: 'execute' },
            { name: 'Export', description: 'Export to file', value: 'export' },
          ]}
          onSelect={(_, option) => {
            if (!option) return
            switch (option.value) {
              case 'view': setEditing(false); setExecuting(false); break
              case 'edit': setEditing(true); setExecuting(false); break
              case 'execute': setEditing(false); setExecuting(true); break
              case 'export': handleExport(); break
            }
          }}
          showUnderline={false}
          showDescription={false}
          wrapSelection={true}
          tabWidth={10}
          textColor={theme().textMuted}
          focusedTextColor={theme().text}
          selectedTextColor="#ffffff"
          selectedBackgroundColor={theme().borderActive}
        />
      </box>
      
      <Show when={!editing() && !executing()}>
        <scrollbox minHeight={20} maxHeight="75%" borderStyle="rounded" borderColor={theme().border} paddingX={1}>
          <markdown
            content={content()}
            syntaxStyle={SyntaxStyle.create()}
            fg={theme().markdownText}
          />
        </scrollbox>
      </Show>
      
      <Show when={editing()}>
        <textarea
          ref={(value) => {
            textareaRef = value
          }}
          initialValue={content()}
          focused={true}
          minHeight={20}
          maxHeight="75%"
          paddingX={1}
        />
      </Show>
      
      <Show when={executing()}>
        <box flexDirection="column" paddingBottom={1} gap={1} minHeight={20} maxHeight="75%">
          <box paddingBottom={1}>
            <text fg={theme().text}><b>Configure and Run Plan</b></text>
          </box>
          <Show when={defaultsLoaded()} fallback={
            <box flexDirection="column" gap={1} paddingBottom={1}>
              <text fg={theme().textMuted}>Loading...</text>
            </box>
          }>
            <select
              focused={true}
              selectedIndex={0}
              options={[
                {
                  name: `Execution model: ${modelsLoaded() ? getModelDisplayLabel(executionModel(), allModels()) : 'loading...'}`,
                  description: 'Press enter to change',
                  value: 'model:execution',
                },
                {
                  name: `Auditor model: ${modelsLoaded() ? getModelDisplayLabel(auditorModel(), allModels()) : 'loading...'}`,
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
          </Show>
        </box>
      </Show>
      
      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
        <Show when={editing()}>
          <text fg={theme().success} onMouseUp={handleSave}>Save</text>
        </Show>
        <Show when={executing()}>
          <text fg={theme().textMuted} onMouseUp={() => setExecuting(false)}>Back to plan</text>
        </Show>
        <text fg={theme().textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>Close (esc)</text>
      </box>
    </box>
  )
}

function LoopDetailsDialog(props: { api: TuiPluginApi; client: ForgeProjectClient; loop: LoopInfo; onBack?: () => void; onRefresh?: () => void | Promise<void> }) {
  const theme = () => props.api.theme.current
  const [currentLoop, setCurrentLoop] = createSignal<LoopInfo>(props.loop)
  const [stats, setStats] = createSignal<SessionStats | null>(null)
  const [loading, setLoading] = createSignal(true)

  const directory = props.api.state.path.directory

  // Re-read loop state when dialog opens and on refresh requests
  // This ensures the dialog shows fresh data, not a stale snapshot
  const refreshLoopState = async () => {
    if (currentLoop().name) {
      const freshLoop = await props.client.loops.get(currentLoop().name)
      if (freshLoop) {
        setCurrentLoop(freshLoop)
      }
    }
  }
  
  // Initial refresh on mount
  refreshLoopState()

  createEffect(() => {
    const loop = currentLoop()
    if (loop.sessionId && directory) {
      setLoading(true)
      fetchSessionStats(props.api, loop.sessionId, directory).then((result) => {
        setStats(result)
        setLoading(false)
      }).catch(() => {
        setStats(null)
        setLoading(false)
      })
    } else {
      setLoading(false)
    }
  })

  const handleCancel = async () => {
    props.api.ui.dialog.clear()
    const cancelled = await props.client.loops.cancel(currentLoop().name)
    props.api.ui.toast({
      message: cancelled ? `Cancelled loop: ${currentLoop().name}` : `Loop ${currentLoop().name} is not active`,
      variant: cancelled ? 'success' : 'info',
      duration: 3000,
    })
    // Refresh sidebar immediately after mutation is issued
    props.onRefresh?.()
  }

  const handleRestart = async () => {
    props.api.ui.dialog.clear()
    const newSessionId = await props.client.loops.restart(currentLoop().name, currentLoop().active)
    const label = currentLoop().active ? 'Force restarting' : 'Restarting'
    props.api.ui.toast({
      message: newSessionId ? `${label} loop: ${currentLoop().name}` : `Failed to restart loop: ${currentLoop().name}`,
      variant: newSessionId ? 'success' : 'error',
      duration: 3000,
    })
    // Refresh sidebar immediately after mutation is issued
    props.onRefresh?.()
  }

  const statusBadge = () => {
    const loop = currentLoop()
    if (loop.active) return { text: loop.phase, color: loop.phase === 'auditing' ? theme().warning : theme().success }
    if (loop.terminationReason === 'completed') return { text: 'completed', color: theme().success }
    if (loop.terminationReason === 'cancelled' || loop.terminationReason === 'user_aborted') return { text: 'cancelled', color: theme().textMuted }
    return { text: 'ended', color: theme().error }
  }

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme().text}>
            <b>{currentLoop().name}</b>
          </text>
          <text fg={statusBadge().color}>
            <b>[{statusBadge().text}]</b>
          </text>
        </box>
        <box>
          <text fg={theme().textMuted}>
            Iteration {currentLoop().iteration}{currentLoop().maxIterations > 0 ? `/${currentLoop().maxIterations}` : ''}
          </text>
        </box>
      </box>

      <Show when={loading()}>
        <box paddingTop={1}>
          <text fg={theme().textMuted}>Loading stats...</text>
        </box>
      </Show>

      <Show when={!loading()}>
        <box flexDirection="column" paddingTop={1} flexShrink={0}>
          <Show when={stats()} fallback={
            <box>
              <text fg={theme().textMuted}>Session stats unavailable</text>
            </box>
          }>
            <box flexDirection="column">
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Session: </span>
                  {currentLoop().sessionId.slice(0, 8)}...
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Phase: </span>
                  {currentLoop().phase}
                </text>
              </box>
              <Show when={currentLoop().executionModel}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Execution model: </span>
                    {currentLoop().executionModel}
                  </text>
                </box>
              </Show>
              <Show when={currentLoop().auditorModel}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Auditor model: </span>
                    {currentLoop().auditorModel}
                  </text>
                </box>
              </Show>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Messages: </span>
                  {stats()!.messages.total} total ({stats()!.messages.assistant} assistant)
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Tokens: </span>
                  {formatTokens(stats()!.tokens.input)} in / {formatTokens(stats()!.tokens.output)} out / {formatTokens(stats()!.tokens.reasoning)} reasoning
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Cost: </span>
                  ${stats()!.cost.toFixed(4)}
                </text>
              </box>
              <Show when={stats()!.fileChanges}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Files: </span>
                    {stats()!.fileChanges!.files} changed (+{stats()!.fileChanges!.additions}/-{stats()!.fileChanges!.deletions})
                  </text>
                </box>
              </Show>
              <Show when={stats()!.timing}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Duration: </span>
                    {formatDuration(stats()!.timing!.durationMs, { includeSeconds: true, compact: true })}
                  </text>
                </box>
              </Show>
            </box>
          </Show>
        </box>
      </Show>

      <Show when={stats()?.lastActivity?.summary}>
        <box flexDirection="column" paddingTop={1} flexGrow={1} flexShrink={1}>
          <box flexShrink={0}>
            <text fg={theme().text}><b>Latest Output</b></text>
          </box>
          <scrollbox maxHeight={12} borderStyle="rounded" borderColor={theme().border} paddingX={1}>
            <text fg={theme().textMuted} wrapMode="word">
              {truncate(stats()!.lastActivity!.summary, 500)}
            </text>
          </scrollbox>
        </box>
      </Show>

      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2} paddingY={2}>
        <Show when={props.onBack}>
          <text fg={theme().textMuted} onMouseUp={() => props.onBack!()}>Back</text>
        </Show>
        <Show when={currentLoop().sessionId && currentLoop().workspaceId}>
          <text fg={theme().success} onMouseUp={() => {
            props.api.route.navigate('session', { sessionID: currentLoop().sessionId })
          }}>Open session</text>
        </Show>
        <Show when={currentLoop().active}>
          <text fg={theme().warning} onMouseUp={handleRestart}>Force Restart</text>
          <text fg={theme().error} onMouseUp={handleCancel}>Cancel loop</text>
        </Show>
        <Show when={!currentLoop().active && currentLoop().terminationReason !== 'completed'}>
          <text fg={theme().success} onMouseUp={handleRestart}>Restart</text>
        </Show>
        <text fg={theme().textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>Close (esc)</text>
      </box>
    </box>
  )
}

function Sidebar(props: { api: TuiPluginApi; client: ForgeProjectClient; opts: TuiOptions; sessionId?: string; remoteUrl?: string }) {
  const [open, setOpen] = createSignal(true)
  const [loops, setLoops] = createSignal<LoopInfo[]>([])
  const [hasPlan, setHasPlan] = createSignal(false)
  const [graphStatusFormatted, setGraphStatusFormatted] = createSignal<ReturnType<typeof formatGraphStatus> | null>(null)
  const [graphStatusRaw, setGraphStatusRaw] = createSignal<Parameters<typeof formatGraphStatus>[0] | null>(null)
  const theme = () => props.api.theme.current
  const directory = props.api.state.path.directory

  const title = createMemo(() => {
    return props.opts.showVersion ? `Forge v${VERSION}` : 'Forge'
  })

  const remoteInfo = createMemo(() => {
    const url = props.remoteUrl?.trim()
    if (!url) return null
    try {
      const urlObj = new URL(url)
      return {
        hostname: urlObj.hostname,
        protocol: urlObj.protocol.replace(':', ''),
      }
    } catch {
      return null
    }
  })

  const dot = (loop: LoopInfo) => {
    if (!loop.active) {
      if (loop.terminationReason === 'completed') return theme().success
      if (loop.terminationReason === 'cancelled' || loop.terminationReason === 'user_aborted') return theme().textMuted
      return theme().error
    }
    if (loop.phase === 'auditing') return theme().warning
    return theme().success
  }

  const statusText = (loop: LoopInfo) => {
    const max = loop.maxIterations > 0 ? `/${loop.maxIterations}` : ''
    if (loop.active) return `${loop.phase} · iter ${loop.iteration}${max}`
    if (loop.terminationReason === 'completed') return `completed · ${loop.iteration} iter${loop.iteration !== 1 ? 's' : ''}`
    return loop.terminationReason?.replace(/_/g, ' ') ?? 'ended'
  }

  /**
   * Refreshes all sidebar-visible data: loops, plan presence, and graph status.
   * This is the single source of truth for sidebar state updates.
   * 
   * Triggers:
   * - session.status events
   * - Loop/plan mutation actions (save, delete, execute, cancel, restart)
   * - Periodic polling for active worktree loops (5s interval)
   * - Periodic polling for transient graph states (5s interval)
   * - Manual onRefresh callbacks from dialogs
   */
  const redirectedSessions = new Set<string>()

  async function refreshSidebarData() {
    const states = await props.client.loops.list()
    const cutoff = Date.now() - 5 * 60 * 1000
    const visible = states.filter(l => 
      l.active || (l.completedAt && new Date(l.completedAt).getTime() > cutoff)
    )
    visible.sort((a, b) => {
      if (a.active && !b.active) return -1
      if (!a.active && b.active) return 1
      const aTime = a.completedAt ?? a.startedAt ?? ''
      const bTime = b.completedAt ?? b.startedAt ?? ''
      return bTime.localeCompare(aTime)
    })
    setLoops(visible)
    
    // Refresh plan presence for current session
    if (props.sessionId) {
      const plan = await props.client.plan.read(props.sessionId)
      setHasPlan(plan !== null)
    }
    
    // Auto-redirect if the currently-viewed session belongs to a loop that just completed
    if (props.sessionId && !redirectedSessions.has(props.sessionId)) {
      const ended = states.find(l =>
        l.sessionId === props.sessionId
        && !l.active
        && l.terminationReason === 'completed'
        && l.worktree
        && l.hostSessionId,
      )
      if (ended) {
        redirectedSessions.add(props.sessionId)
        try {
          props.api.route.navigate('session', { sessionID: ended.hostSessionId! })
          props.api.ui.toast({
            message: `Loop "${ended.name}" completed · click Forge sidebar to review`,
            variant: 'success',
            duration: 5000,
          })
        } catch (err) {
          console.error('[forge] sidebar: failed to redirect after loop completion', err)
        }
      }
    }
    
    // Refresh graph status from KV (scoped to current directory)
    const status = await props.client.readGraphStatus(directory)
    setGraphStatusRaw(status)
    setGraphStatusFormatted(formatGraphStatus(status))
  }
  

  
  const unsubStatus = props.api.event.on('session.status', () => {
    refreshSidebarData()
  })
  // session.deleted fires when terminateLoop cleans up a completed worktree loop's session,
  // session.updated fires on status transitions. Both should refresh the sidebar immediately
  // so completed loops don't keep their stale sessionId/workspaceId in the list.
  const unsubDeleted = props.api.event.on('session.deleted', () => {
    refreshSidebarData()
  })
  const unsubUpdated = props.api.event.on('session.updated', () => {
    refreshSidebarData()
  })

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void refreshSidebarData()
    }, 5000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  void refreshSidebarData()

  // Re-check after a short delay to catch graph status that wasn't written yet at mount time
  const initTimer = setTimeout(() => {
    if (!graphStatusRaw()) {
      void refreshSidebarData()
    }
  }, 2000)

  createEffect(() => {
    if (shouldPollSidebar(loops(), graphStatusRaw())) {
      startPolling()
    } else {
      stopPolling()
    }
  })

  onCleanup(() => {
    unsubStatus()
    unsubDeleted()
    unsubUpdated()
    stopPolling()
    clearTimeout(initTimer)
  })

  const hasContent = createMemo(() => {
    if (hasPlan()) return true
    if (props.opts.showLoops && loops().length > 0) return true
    if (graphStatusFormatted()) return true
    return false
  })
  
  const activeCount = createMemo(() => {
    return loops().filter(l => l.active).length
  })

  return (
    <Show when={props.opts.sidebar}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => hasContent() && setOpen((x) => !x)}>
          <Show when={hasContent()}>
            <text fg={theme().text}>{open() ? '▼' : '▶'}</text>
          </Show>
          <text fg={theme().text}>
            <b>{title()}</b>
            {!open() && hasPlan() ? <span style={{ fg: theme().info }}> · plan</span> : ''}
            {!open() && graphStatusFormatted() && graphStatusFormatted()!.text.includes('ready') ? <span style={{ fg: theme().success }}> · ready</span> : ''}
            {!open() && activeCount() > 0 ? <span style={{ fg: theme().textMuted }}>{` (${activeCount()} active)`}</span> : ''}
            {!open() && remoteInfo() ? <span style={{ fg: theme().warning }}>{` (${remoteInfo()!.hostname})`}</span> : ''}
            {!open() && !remoteInfo() ? <span style={{ fg: theme().textMuted }}> (local)</span> : ''}
          </text>
        </box>
        <Show when={open()}>
          <Show when={hasPlan()}>
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={async () => {
                if (!props.sessionId) return
                const plan = await props.client.plan.read(props.sessionId)
                if (!plan) {
                  props.api.ui.toast({ message: 'Plan not found', variant: 'info', duration: 3000 })
                  return
                }
                const refreshSidebar = refreshSidebarData
                props.api.ui.dialog.setSize("xlarge")
                props.api.ui.dialog.replace(() => (
                  <PlanViewerDialog api={props.api} client={props.client} planContent={plan} sessionId={props.sessionId!} onRefresh={refreshSidebar} />
                ))
              }}
            >
              <text flexShrink={0} style={{ fg: theme().info }}>📋</text>
              <text fg={theme().text}>Plan</text>
            </box>
          </Show>
          <Show when={graphStatusFormatted()}>
            <box
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} style={{ fg: theme()[graphStatusFormatted()!.color] }}>•</text>
              <text fg={theme().text} wrapMode="word">
                {graphStatusFormatted()!.text}
              </text>
            </box>
          </Show>
          <Show when={props.opts.showLoops && loops().length > 0}>
            <For each={loops()}>
              {(loop) => (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseUp={() => {
                    // Completed/terminated loops: always show the details dialog.
                    // Their session and workspace may have been deleted during cleanup,
                    // so navigating to loop.sessionId would land on a dead session.
                    // Workspace-backed active worktree loop: navigate directly to its session.
                    // Legacy active worktree loop (no workspaceId): open the details dialog.
                    // Active in-place loop: navigate directly.
                    if (!loop.active) {
                      props.api.ui.dialog.setSize("medium")
                      props.api.ui.dialog.replace(() => (
                        <LoopDetailsDialog api={props.api} client={props.client} loop={loop} onRefresh={refreshSidebarData} />
                      ))
                    } else if (loop.worktree && loop.workspaceId && loop.sessionId) {
                      props.api.route.navigate('session', { sessionID: loop.sessionId })
                    } else if (loop.worktree) {
                      props.api.ui.dialog.setSize("medium")
                      props.api.ui.dialog.replace(() => (
                        <LoopDetailsDialog api={props.api} client={props.client} loop={loop} onRefresh={refreshSidebarData} />
                      ))
                    } else {
                      props.api.route.navigate('session', { sessionID: loop.sessionId })
                    }
                  }}
                >
                  <text flexShrink={0} style={{ fg: dot(loop) }}>•</text>
                  <text fg={theme().text} wrapMode="word">
                    {truncateMiddle(loop.name, 25)}{' '}
                    <span style={{ fg: theme().textMuted }}>{statusText(loop)}</span>
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const id = 'oc-forge'

const tui: TuiPlugin = async (api) => {

  const pluginConfig = loadPluginConfig()
  const tuiConfig = pluginConfig.tui
  const remoteUrl = resolveForgeApiUrl(pluginConfig)
  const directory = api.state.path.directory
  const client = await connectForgeProject(pluginConfig, directory)
  if (!client) {
    api.ui.toast({ message: `Forge API unavailable for ${directory}; TUI disabled`, variant: 'error', duration: 5000 })
    return
  }

  const opts: TuiOptions = {
    sidebar: tuiConfig?.sidebar ?? true,
    showLoops: tuiConfig?.showLoops ?? true,
    showVersion: tuiConfig?.showVersion ?? true,
    keybinds: { ...DEFAULT_KEYBINDS, ...tuiConfig?.keybinds },
  }

  if (!opts.sidebar) return

  api.command.register(() => {
    return [
      {
        title: 'Forge: Show loops',
        value: 'forge.loops.show',
        description: 'API loops',
        category: 'Forge',
        keybind: opts.keybinds.showLoops,
        onSelect: async () => {
          const currentStates = await client.loops.list()
          const worktreeLoops = currentStates.filter(l => l.worktree)
          const loopOptions = worktreeLoops.map(l => {
            const status = l.active
              ? l.phase
              : l.terminationReason?.replace(/_/g, ' ') ?? 'ended'

            return {
              title: l.name,
              value: l.name,
              description: status,
            }
          })

          const showLoopList = () => {
            api.ui.dialog.setSize("large")
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Loops"
                options={loopOptions}
                onSelect={async (opt) => {
                  const loopName = opt.value as string
                  const freshLoop = await client.loops.get(loopName)
                  if (freshLoop) {
                    api.ui.dialog.setSize("medium")
                    api.ui.dialog.replace(() => (
                      <LoopDetailsDialog api={api} client={client} loop={freshLoop} onBack={showLoopList} onRefresh={() => {}} />
                    ))
                  } else {
                    api.ui.dialog.clear()
                  }
                }}
              />
            ))
          }

          showLoopList()
        },
      },
    ]
  })

  api.command.register(() => {
    const route = api.route.current
    if (route.name !== 'session') return []

    const sessionID = (route as { params: { sessionID: string } }).params.sessionID

    const refreshSidebar = () => {
      // Trigger sidebar refresh via session status event
    }

    return [{
      title: 'Forge: View plan',
      value: 'forge.plan.view',
      description: 'View cached plan for this session',
      category: 'Forge',
      keybind: opts.keybinds.viewPlan,
      onSelect: async () => {
        const freshPlan = await client.plan.read(sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog api={api} client={client} planContent={freshPlan} sessionId={sessionID} onRefresh={refreshSidebar} />
        ))
      },
    }, {
      title: 'Forge: Execute plan',
      value: 'forge.plan.execute',
      description: 'Execute cached plan',
      category: 'Forge',
      keybind: opts.keybinds.executePlan,
      onSelect: async () => {
        const freshPlan = await client.plan.read(sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog api={api} client={client} planContent={freshPlan} sessionId={sessionID} onRefresh={refreshSidebar} startInExecuteMode={true} />
        ))
      },
    }]
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, slotProps) {
        return <Sidebar api={api} client={client} opts={opts} sessionId={slotProps.session_id} remoteUrl={remoteUrl} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
