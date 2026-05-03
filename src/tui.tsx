/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, For, untrack } from 'solid-js'
import { SyntaxStyle, type TextareaRenderable } from '@opentui/core'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { VERSION } from './version'
import { loadPluginConfig } from './setup'
import { fetchSessionStats, type SessionStats } from './utils/session-stats'
import { slugify } from './utils/logger'
import { extractPlanTitle } from './utils/plan-execution'
import type { LoopInfo } from './utils/tui-refresh-helpers'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { ExecutePlanPanel } from './tui/execute-plan-panel'
import { formatDuration, formatTokens, truncate, truncateMiddle } from './utils/format'
import { connectForgeProject, type ForgeProjectClient } from './utils/tui-client'

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

type ForgeConnectionStatus = 'connecting' | 'connected' | 'unavailable'

function ForgeSidebarStatus(props: { api: TuiPluginApi; opts: TuiOptions; status: () => ForgeConnectionStatus }) {
  const theme = () => props.api.theme.current
  const title = createMemo(() => props.opts.showVersion ? `Forge v${VERSION}` : 'Forge')
  const statusText = createMemo(() => props.status() === 'connecting' ? 'connecting' : 'RPC unavailable')

  return (
    <Show when={props.opts.sidebar}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>{title()}</b>
          </text>
          <text fg={theme().textMuted}>· {statusText()}</text>
        </box>
      </box>
    </Show>
  )
}

function SidebarContainer(props: {
  api: TuiPluginApi
  client: () => ForgeProjectClient | null
  cache: () => ExecutionContextCache | null
  pluginConfig: PluginConfig
  opts: TuiOptions
  status: () => ForgeConnectionStatus
  sessionId?: string
}) {
  const currentClient = createMemo(() => props.client())

  return (
    <Show
      when={currentClient()}
      fallback={<ForgeSidebarStatus api={props.api} opts={props.opts} status={props.status} />}
    >
      {(client) => <Sidebar api={props.api} client={client()} cache={props.cache} pluginConfig={props.pluginConfig} opts={props.opts} sessionId={props.sessionId} />}
    </Show>
  )
}

function PlanViewerDialog(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: ExecutionContextCache | null
  pluginConfig: PluginConfig
  planContent: string
  sessionId: string
  onRefresh?: () => void | Promise<void>
  startInExecuteMode?: boolean
  initialExecutionModel?: string
  initialAuditorModel?: string
}) {
  const theme = () => props.api.theme.current
  const [editing, setEditing] = createSignal(false)
  const startInExecuteModeValue = () => !!props.startInExecuteMode
  const planContentValue = () => props.planContent
  const initialExecutionModelValue = () => props.initialExecutionModel ?? ''
  const initialAuditorModelValue = () => props.initialAuditorModel ?? ''
  const [executing, setExecuting] = createSignal(startInExecuteModeValue())
  const [content, setContent] = createSignal(planContentValue())
  let textareaRef: TextareaRenderable | undefined

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
        <ExecutePlanPanel
          api={props.api}
          client={props.client}
          cache={props.cache}
          pluginConfig={props.pluginConfig}
          planContent={content()}
          sessionId={props.sessionId}
          initialExecutionModel={initialExecutionModelValue()}
          initialAuditorModel={initialAuditorModelValue()}
          onBack={() => setExecuting(false)}
          onExecuted={props.onRefresh}
          onModelSelected={({ target, selectedModel, executionModel, auditorModel }) => {
            props.api.ui.dialog.setSize('xlarge')
            props.api.ui.dialog.replace(() => (
              <PlanViewerDialog
                api={props.api}
                client={props.client}
                cache={props.cache}
                pluginConfig={props.pluginConfig}
                planContent={content()}
                sessionId={props.sessionId}
                onRefresh={props.onRefresh}
                startInExecuteMode={true}
                initialExecutionModel={target === 'execution' ? selectedModel : executionModel}
                initialAuditorModel={target === 'auditor' ? selectedModel : auditorModel}
              />
            ))
          }}
        />
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
  // eslint-disable-next-line solid/reactivity
  const [currentLoop, setCurrentLoop] = createSignal<LoopInfo>(props.loop)
  const [stats, setStats] = createSignal<SessionStats | null>(null)
  const [loading, setLoading] = createSignal(true)

  // Re-read loop state when dialog opens and on refresh requests
  // This ensures the dialog shows fresh data, not a stale snapshot
  const refreshLoopState = async () => {
    const loopName = currentLoop().name
    if (loopName) {
      const freshLoop = await props.client.loops.get(loopName)
      if (freshLoop) {
        setCurrentLoop(freshLoop)
      }
    }
  }
  
  // Initial refresh on mount - wrap in createEffect for reactivity
  createEffect(() => {
    void refreshLoopState()
  })

  createEffect(() => {
    const loop = currentLoop()
    const dir = props.api.state.path.directory
    if (loop.sessionId && dir) {
      setLoading(true)
      fetchSessionStats(props.api, loop.sessionId, dir).then((result) => {
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
                <box flexDirection="row">
                  <text fg={theme().textMuted}>Session: </text>
                  <text fg={theme().text}>{currentLoop().sessionId.slice(0, 8)}...</text>
                </box>
              </box>
              <box>
                <box flexDirection="row">
                  <text fg={theme().textMuted}>Phase: </text>
                  <text fg={theme().text}>{currentLoop().phase}</text>
                </box>
              </box>
              <Show when={currentLoop().executionModel}>
                <box>
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>Execution model: </text>
                    <text fg={theme().text}>{currentLoop().executionModel}</text>
                  </box>
                </box>
              </Show>
              <Show when={currentLoop().auditorModel}>
                <box>
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>Auditor model: </text>
                    <text fg={theme().text}>{currentLoop().auditorModel}</text>
                  </box>
                </box>
              </Show>
              <box>
                <box flexDirection="row">
                  <text fg={theme().textMuted}>Messages: </text>
                  <text fg={theme().text}>{stats()!.messages.total} total ({stats()!.messages.assistant} assistant)</text>
                </box>
              </box>
              <box>
                <box flexDirection="row">
                  <text fg={theme().textMuted}>Tokens: </text>
                  <text fg={theme().text}>{formatTokens(stats()!.tokens.input)} in / {formatTokens(stats()!.tokens.output)} out / {formatTokens(stats()!.tokens.reasoning)} reasoning</text>
                </box>
              </box>
              <box>
                <box flexDirection="row">
                  <text fg={theme().textMuted}>Cost: </text>
                  <text fg={theme().text}>${stats()!.cost.toFixed(4)}</text>
                </box>
              </box>
              <Show when={stats()!.fileChanges}>
                <box>
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>Files: </text>
                    <text fg={theme().text}>{stats()!.fileChanges!.files} changed (+{stats()!.fileChanges!.additions}/-{stats()!.fileChanges!.deletions})</text>
                  </box>
                </box>
              </Show>
              <Show when={stats()!.timing}>
                <box>
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>Duration: </text>
                    <text fg={theme().text}>{formatDuration(stats()!.timing!.durationMs, { includeSeconds: true, compact: true })}</text>
                  </box>
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

function Sidebar(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: () => ExecutionContextCache | null
  pluginConfig: PluginConfig
  opts: TuiOptions
  sessionId?: string
}) {
  const [open, setOpen] = createSignal(true)
  const [loops, setLoops] = createSignal<LoopInfo[]>([])
  const [hasPlan, setHasPlan] = createSignal(false)
  const theme = () => props.api.theme.current

  const title = createMemo(() => {
    return props.opts.showVersion ? `Forge v${VERSION}` : 'Forge'
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
    * Refreshes all sidebar-visible data: loops and plan presence.
    * This is the single source of truth for sidebar state updates.
    *
    * Triggers:
    * - Initial mount
    * - props.sessionId change (session navigation)
    * - forge.evt:loops.changed bus events (loop mutations)
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
  }

  // Initial mount refresh - also re-runs when sessionId changes (navigation)
  createEffect(() => {
    void props.sessionId  // track navigation
    void refreshSidebarData()
  })

  // Subscribe to loops.changed events from the bus
  // eslint-disable-next-line solid/reactivity
  const unsubLoops = props.client.events.onLoopsChanged(() => {
    void refreshSidebarData()
  })

  onCleanup(() => {
    unsubLoops()
  })

  const hasContent = createMemo(() => {
    if (hasPlan()) return true
    if (props.opts.showLoops && loops().length > 0) return true
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
          </text>
          <Show when={!open() && hasPlan()}>
            <text fg={theme().info}>· plan</text>
          </Show>
          <Show when={!open() && activeCount() > 0}>
            <text fg={theme().textMuted}>{`(${activeCount()} active)`}</text>
          </Show>
          <Show when={!open()}>
            <text fg={theme().textMuted}>(local)</text>
          </Show>
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
                  <PlanViewerDialog
                    api={props.api}
                    client={props.client}
                    cache={props.cache()}
                    pluginConfig={props.pluginConfig}
                    planContent={plan}
                    sessionId={props.sessionId!}
                    onRefresh={refreshSidebar}
                  />
                ))
              }}
            >
              <text flexShrink={0} fg={theme().info}>📋</text>
              <text fg={theme().text}>Plan</text>
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
                  <text flexShrink={0} fg={dot(loop)}>•</text>
                  <text fg={theme().text} wrapMode="word">{truncateMiddle(loop.name, 25)}</text>
                  <text fg={theme().textMuted}>{statusText(loop)}</text>
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
  const directory = api.state.path.directory
  const opts: TuiOptions = {
    sidebar: tuiConfig?.sidebar ?? true,
    showLoops: tuiConfig?.showLoops ?? true,
    showVersion: tuiConfig?.showVersion ?? true,
    keybinds: { ...DEFAULT_KEYBINDS, ...tuiConfig?.keybinds },
  }

  if (!opts.sidebar) return

  const [client, setClient] = createSignal<ForgeProjectClient | null>(null)
  const [connectionStatus, setConnectionStatus] = createSignal<ForgeConnectionStatus>('connecting')
  const [executionContextCache, setExecutionContextCache] = createSignal<ExecutionContextCache | null>(null)
  let connectPromise: Promise<ForgeProjectClient | null> | null = null
  let disposed = false
  let unavailableToastShown = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  api.lifecycle.onDispose(() => {
    disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  })

  const showUnavailableToast = () => {
    if (unavailableToastShown) return
    unavailableToastShown = true
    api.ui.toast({ message: `Forge bus RPC unavailable for ${directory}`, variant: 'warning', duration: 5000 })
  }

  const scheduleClientRetry = () => {
    if (disposed || retryTimer || untrack(client)) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!disposed && !untrack(client)) void startClientConnection()
    }, 2000)
  }

  const startClientConnection = (): Promise<ForgeProjectClient | null> => {
    if (connectPromise) return connectPromise

    setConnectionStatus('connecting')
    connectPromise = connectForgeProject(api, directory).then((connected) => untrack(() => {
      connectPromise = null
      if (disposed) return connected

      setClient(connected)
      setConnectionStatus(connected ? 'connected' : 'unavailable')
      if (!connected) {
        showUnavailableToast()
        scheduleClientRetry()
      } else if (connected && connected.projectId) {
        const cache = createExecutionContextCache(
          connected.projectId,
          pluginConfig,
          () => connected.loadExecutionContext(),
        )
        void cache.ensureLoaded().catch((err) => console.error('[forge] execution context preload failed', err))
        setExecutionContextCache(cache)
      }
      return connected
    })).catch((err) => untrack(() => {
      connectPromise = null
      console.error('[forge] TUI RPC connection failed', err)
      if (!disposed) {
        setConnectionStatus('unavailable')
        showUnavailableToast()
        scheduleClientRetry()
      }
      return null
    }))

    return connectPromise
  }

  const ensureClient = async (): Promise<ForgeProjectClient | null> => {
    const existing = client()
    if (existing) return existing
    return startClientConnection()
  }

  createEffect(() => {
    if (!api.state.ready || client() || connectPromise) return
    void startClientConnection()
  })

  api.command.register(() => {
    return [
      {
        title: 'Forge: Show loops',
        value: 'forge.loops.show',
        description: 'API loops',
        category: 'Forge',
        keybind: opts.keybinds.showLoops,
        onSelect: async () => {
          const currentClient = await ensureClient()
          if (!currentClient) return

          const currentStates = await currentClient.loops.list()
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
                // eslint-disable-next-line solid/reactivity
                onSelect={async (opt) => {
                  const loopName = opt.value as string
                  const freshLoop = await currentClient.loops.get(loopName)
                  if (freshLoop) {
                    api.ui.dialog.setSize("medium")
                    api.ui.dialog.replace(() => (
                      <LoopDetailsDialog api={api} client={currentClient} loop={freshLoop} onBack={showLoopList} onRefresh={() => {}} />
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

    return [{
      title: 'Forge: View plan',
      value: 'forge.plan.view',
      description: 'View cached plan for this session',
      category: 'Forge',
      keybind: opts.keybinds.viewPlan,
      onSelect: async () => {
        const currentClient = await ensureClient()
        if (!currentClient) return

        const freshPlan = await currentClient.plan.read(sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        const cache = executionContextCache()
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog
            api={api}
            client={currentClient}
            cache={cache}
            pluginConfig={pluginConfig}
            planContent={freshPlan}
            sessionId={sessionID}
            // onRefresh omitted - sidebar refreshes via loops.changed events
          />
        ))
      },
    }, {
      title: 'Forge: Execute plan',
      value: 'forge.plan.execute',
      description: 'Execute cached plan',
      category: 'Forge',
      keybind: opts.keybinds.executePlan,
      onSelect: async () => {
        const currentClient = await ensureClient()
        if (!currentClient) return

        const freshPlan = await currentClient.plan.read(sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        const cache = executionContextCache()
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog
            api={api}
            client={currentClient}
            cache={cache}
            pluginConfig={pluginConfig}
            planContent={freshPlan}
            sessionId={sessionID}
            // onRefresh omitted - sidebar refreshes via loops.changed events
            startInExecuteMode={true}
          />
        ))
      },
    }]
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, slotProps) {
        return <SidebarContainer
          api={api}
          client={client}
          cache={executionContextCache}
          pluginConfig={pluginConfig}
          opts={opts}
          status={connectionStatus}
          sessionId={slotProps.session_id}
        />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
