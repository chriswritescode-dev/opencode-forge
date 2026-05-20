/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js'
import { SyntaxStyle, type TextareaRenderable } from '@opentui/core'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { VERSION } from './version'
import { loadPluginConfig, setTuiAutoSavePlans } from './setup'
import { slugify } from './utils/logger'
import { extractPlanExecutionMetadata } from './utils/plan-execution'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { ExecutePlanPanel } from './tui/execute-plan-panel'
import { connectForgeProject, type ForgeProjectClient } from './utils/tui-client'
import { savePlanToArchive, listArchivedPlans, readArchivedPlan, resolvePlanArchiveDir, hashPlanContent, DEFAULT_PLAN_ARCHIVE_TTL_MS, type ArchivedPlan } from './utils/plan-archive'

type TuiKeybinds = {
  viewPlan: string
  loadPlan: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  viewPlan: '<leader>v',
  loadPlan: '<leader>i',
}

type TuiOptions = {
  sidebar: boolean
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
  initialExecutionVariant?: string
  initialAuditorVariant?: string
}) {
  const theme = () => props.api.theme.current
  const [editing, setEditing] = createSignal(false)
  const startInExecuteModeValue = () => !!props.startInExecuteMode
  const planContentValue = () => props.planContent
  const initialExecutionModelValue = () => props.initialExecutionModel
  const initialAuditorModelValue = () => props.initialAuditorModel
  const initialExecutionVariantValue = () => props.initialExecutionVariant
  const initialAuditorVariantValue = () => props.initialAuditorVariant
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
    const name = extractPlanExecutionMetadata(planText).executionName
    const slugifiedName = slugify(name)
    const directory = props.api.state.path.directory
    const filename = `${slugifiedName}.md`
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
          initialExecutionVariant={initialExecutionVariantValue()}
          initialAuditorVariant={initialAuditorVariantValue()}
          onBack={() => setExecuting(false)}
          onExecuted={props.onRefresh}
          onSelectionChanged={({ executionModel, auditorModel, executionVariant, auditorVariant }) => {
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
                initialExecutionModel={executionModel}
                initialAuditorModel={auditorModel}
                initialExecutionVariant={executionVariant}
                initialAuditorVariant={auditorVariant}
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

function LoadPlanDialog(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: () => ExecutionContextCache | null
  pluginConfig: PluginConfig
  sessionId?: string
  onRefresh?: () => void | Promise<void>
  plans: ArchivedPlan[]
}) {
  return (
    <props.api.ui.DialogSelect
      title="Load plan"
      options={props.plans.map(p => ({
        title: p.title,
        value: p.filepath,
        description: new Date(p.modifiedAt).toLocaleString(),
      }))}
      onSelect={(opt) => {
        const filepath = opt.value as string
        let content: string
        try {
          content = readArchivedPlan(filepath)
        } catch (err) {
          props.api.ui.toast({
            message: `Failed to read plan: ${(err as Error).message}`,
            variant: 'error',
            duration: 4000,
          })
          props.api.ui.dialog.clear()
          return
        }
        props.api.ui.dialog.setSize('xlarge')
        props.api.ui.dialog.replace(() => (
          <PlanViewerDialog
            api={props.api}
            client={props.client}
            cache={props.cache()}
            pluginConfig={props.pluginConfig}
            planContent={content}
            sessionId={props.sessionId ?? ''}
            startInExecuteMode={true}
            onRefresh={props.onRefresh}
          />
        ))
      }}
    />
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
  const [hasPlan, setHasPlan] = createSignal(false)
  const [planContent, setPlanContent] = createSignal<string | null>(null)
  // eslint-disable-next-line solid/reactivity
  const [autoSavePlans, setAutoSavePlans] = createSignal(props.pluginConfig.tui?.autoSavePlans ?? false)
  const theme = () => props.api.theme.current
  const archivedHashes = new Map<string, string>()

  const title = createMemo(() => {
    return props.opts.showVersion ? `Forge v${VERSION}` : 'Forge'
  })

  /**
    * Refreshes sidebar-visible data: plan presence.
    * This is the single source of truth for sidebar state updates.
    *
    * Triggers:
    * - Initial mount
    * - props.sessionId change (session navigation)
    * - Manual onRefresh callbacks from dialogs
    */
  async function refreshSidebarData() {
    // Refresh plan presence and content for current session
    if (props.sessionId) {
      const plan = await props.client.plan.read(props.sessionId)
      setHasPlan(plan !== null)
      setPlanContent(plan)
    }

    // Refresh workspace list so newly created workspaces appear in session list
    props.client.workspaces.list().catch(() => {})
  }

  // Per-session auto-save effect: fires when plan content changes
  createEffect(() => {
    const sid = props.sessionId
    const content = planContent()
    if (!sid || !content || !autoSavePlans() || !props.client.projectId) return
    const hash = hashPlanContent(content)
    if (archivedHashes.get(sid) === hash) return
    archivedHashes.set(sid, hash)
    // run fs write off the reactive tracker
    // eslint-disable-next-line solid/reactivity
    queueMicrotask(() => {
      try {
        const ttlMs = props.pluginConfig.tui?.planArchiveTtlMs ?? DEFAULT_PLAN_ARCHIVE_TTL_MS
        const { deduped } = savePlanToArchive(props.client.projectId, content, new Date(), ttlMs)
        if (!deduped) {
          props.api.ui.toast({ message: `Plan archived`, variant: 'success', duration: 3000 })
        }
      } catch (err) {
        archivedHashes.delete(sid)  // allow retry next time content changes
        props.api.ui.toast({ message: `Plan auto-save failed: ${(err as Error).message}`, variant: 'error', duration: 4000 })
      }
    })
  })

  // Initial mount refresh - also re-runs when sessionId changes (navigation)
  createEffect(() => {
    void props.sessionId  // track navigation
    void refreshSidebarData()
  })

  const hasContent = createMemo(() => {
    return hasPlan()
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
          <Show when={!open()}>
            <text fg={theme().textMuted}>(local)</text>
          </Show>
        </box>
        <Show when={open()}>
          <box
            flexDirection="row"
            gap={1}
            onMouseUp={() => {
              const next = !autoSavePlans()
              setAutoSavePlans(next)
              try {
                setTuiAutoSavePlans(next)
                props.api.ui.toast({
                  message: `Auto-save plans: ${next ? 'on' : 'off'}`,
                  variant: 'success',
                  duration: 2000,
                })
                if (next) void refreshSidebarData()
              } catch (err) {
                setAutoSavePlans(!next)
                props.api.ui.toast({
                  message: `Failed to persist toggle: ${(err as Error).message}`,
                  variant: 'error',
                  duration: 4000,
                })
              }
            }}
          >
            <text flexShrink={0} fg={autoSavePlans() ? theme().success : theme().textMuted}>
              {autoSavePlans() ? '☑' : '☐'}
            </text>
            <text fg={theme().text}>Auto-save plans</text>
          </box>
          <box
            flexDirection="row"
            gap={1}
            onMouseUp={() => {
              const plans = listArchivedPlans(props.client.projectId)
              if (plans.length === 0) {
                props.api.ui.toast({
                  message: `No archived plans in ${resolvePlanArchiveDir(props.client.projectId)}`,
                  variant: 'info',
                  duration: 4000,
                })
                return
              }
              props.api.ui.dialog.setSize('large')
              props.api.ui.dialog.replace(() => (
                <LoadPlanDialog
                  api={props.api}
                  client={props.client}
                  cache={props.cache}
                  pluginConfig={props.pluginConfig}
                  sessionId={props.sessionId}
                  onRefresh={refreshSidebarData}
                  plans={plans}
                />
              ))
            }}
          >
            <text flexShrink={0} fg={theme().info}>📂</text>
            <text fg={theme().text}>Load plan</text>
          </box>
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

  if (!api.command) return

  function resolveSessionID(): string | null {
    const route = api.route.current
    if (route.name !== 'session') return null
    return (route as { params: { sessionID: string } }).params.sessionID
  }

  api.command.register(() => [
    {
      title: 'Forge: View plan',
      value: 'forge.plan.view',
      description: 'View cached plan for this session',
      category: 'Forge',
      keybind: opts.keybinds.viewPlan,
      onSelect: async () => {
        const sessionID = resolveSessionID()
        if (!sessionID) {
          api.ui.toast({ message: 'Open a session to view its plan', variant: 'info', duration: 3000 })
          return
        }
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
          />
        ))
      },
    },
  ])

  api.command.register(() => {
    return [{
      title: 'Forge: Load plan',
      value: 'forge.plan.load',
      description: 'Load an archived plan',
      category: 'Forge',
      keybind: opts.keybinds.loadPlan,
      onSelect: async () => {
        const currentClient = await ensureClient()
        if (!currentClient) return

        const plans = listArchivedPlans(currentClient.projectId)
        if (plans.length === 0) {
          api.ui.toast({
            message: `No archived plans in ${resolvePlanArchiveDir(currentClient.projectId)}`,
            variant: 'info',
            duration: 4000,
          })
          return
        }

        api.ui.dialog.setSize('large')
        api.ui.dialog.replace(() => (
          <LoadPlanDialog
            api={api}
            client={currentClient}
            cache={executionContextCache}
            pluginConfig={pluginConfig}
            sessionId={undefined}
            plans={plans}
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
