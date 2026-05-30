/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js'
import { VERSION } from './version'
import { loadPluginConfig } from './setup'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { connectForgeProject, type ForgeProjectClient } from './utils/tui-client'
import { ExecutePlanPanel } from './tui/execute-plan-panel'
import { attachLoopSessionFollower, getCurrentRouteSessionId } from './tui/session-follow'
import { fetchLatestPlanForSession } from './utils/plan-from-messages'
import { normalizePastedPlanText } from './utils/marked-plan-parser'

type TuiKeybinds = {
  executePlan: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  executePlan: '<leader>f',
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

function Sidebar(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: () => ExecutionContextCache | null
  pluginConfig: PluginConfig
  opts: TuiOptions
  sessionId?: string
}) {
  const theme = () => props.api.theme.current

  const title = createMemo(() => {
    return props.opts.showVersion ? `Forge v${VERSION}` : 'Forge'
  })

  return (
    <Show when={props.opts.sidebar}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>{title()}</b>
          </text>
        </box>
      </box>
    </Show>
  )
}

/**
 * Standalone wrapper around `ExecutePlanPanel`. The picker sub-dialogs
 * (model, variant, loop name) need to fully replace the dialog stack,
 * which means we lose the panel's component state every time the user
 * touches one. The wrapper re-renders itself via `dialog.replace` when
 * the panel reports a new selection, preserving the user's choices
 * across picker round-trips. This mirrors the pattern the deleted
 * `PlanViewerDialog` used internally.
 */
function ExecutionDialog(props: {
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
}) {
  const theme = () => props.api.theme.current

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>Execute plan</b>
        </text>
      </box>

      <ExecutePlanPanel
        api={props.api}
        client={props.client}
        cache={props.cache}
        pluginConfig={props.pluginConfig}
        planContent={props.planContent}
        sessionId={props.sessionId}
        initialExecutionModel={props.initialExecutionModel}
        initialAuditorModel={props.initialAuditorModel}
        initialExecutionVariant={props.initialExecutionVariant}
        initialAuditorVariant={props.initialAuditorVariant}
        initialLoopName={props.initialLoopName}
        onBack={() => props.api.ui.dialog.clear()}
        onSelectionChanged={({ executionModel, auditorModel, executionVariant, auditorVariant, loopName }) => {
          props.api.ui.dialog.setSize('xlarge')
          props.api.ui.dialog.replace(() => (
            <ExecutionDialog
              api={props.api}
              client={props.client}
              cache={props.cache}
              pluginConfig={props.pluginConfig}
              planContent={props.planContent}
              sessionId={props.sessionId}
              initialExecutionModel={executionModel}
              initialAuditorModel={auditorModel}
              initialExecutionVariant={executionVariant}
              initialAuditorVariant={auditorVariant}
              initialLoopName={loopName}
            />
          ))
        }}
      />

      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
        <text fg={theme().textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>Close (esc)</text>
      </box>
    </box>
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

  // Auto-follow loop session rotations. Runs independently of the sidebar
  // option so users with the sidebar disabled still get follow-on-rotation.
  const detachSessionFollower = attachLoopSessionFollower(api)
  api.lifecycle.onDispose(detachSessionFollower)

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

  createEffect(() => {
    if (!api.state.ready || client() || connectPromise) return
    void startClientConnection()
  })

  const ensureClient = async (): Promise<ForgeProjectClient | null> => {
    const existing = client()
    if (existing) return existing
    return startClientConnection()
  }

  const openExecutionDialog = (currentClient: ForgeProjectClient, sessionID: string, planContent: string) => {
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <ExecutionDialog
        api={api}
        client={currentClient}
        cache={executionContextCache()}
        pluginConfig={pluginConfig}
        planContent={planContent}
        sessionId={sessionID}
      />
    ))
  }

  const openPastePlanDialog = (currentClient: ForgeProjectClient, sessionID: string) => {
    api.ui.dialog.setSize('large')
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Paste plan"
        placeholder="Paste a marked or unmarked implementation plan"
        value=""
        onConfirm={(value) => {
          const normalized = normalizePastedPlanText(value)
          if (!normalized.ok) {
            api.ui.toast({
              message: normalized.reason === 'empty'
                ? 'Paste a plan before executing'
                : `Invalid plan markers: ${normalized.reason}`,
              variant: 'error',
              duration: 4000,
            })
            openPastePlanDialog(currentClient, sessionID)
            return
          }

          openExecutionDialog(currentClient, sessionID, normalized.planText)
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  const runExecutePlan = async () => {
    const sessionID = getCurrentRouteSessionId(api)
    if (!sessionID) {
      api.ui.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const currentClient = await ensureClient()
    if (!currentClient) return

    const planText = await fetchLatestPlanForSession(api.client, sessionID, directory)
    if (!planText) {
      api.ui.toast({
        message: 'No plan in current session — paste one to execute',
        variant: 'info',
        duration: 4000,
      })
      openPastePlanDialog(currentClient, sessionID)
      return
    }

    openExecutionDialog(currentClient, sessionID, planText)
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: 'forge.plan.execute',
        title: 'Forge: Execute plan',
        desc: 'Open the execution dialog for the current session plan, or paste one if none is found',
        category: 'Forge',
        namespace: 'palette',
        run: () => { void runExecutePlan() },
      },
      {
        name: 'forge.plan.executePasted',
        title: 'Forge: Execute pasted plan',
        desc: 'Paste a marked or unmarked plan and open the execution dialog',
        category: 'Forge',
        namespace: 'palette',
        run: () => {
          const sessionID = getCurrentRouteSessionId(api)
          if (!sessionID) {
            api.ui.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
            return
          }
          void ensureClient().then((currentClient) => {
            if (currentClient) openPastePlanDialog(currentClient, sessionID)
          })
        },
      },
    ],
    bindings: opts.keybinds.executePlan
      ? [{ key: opts.keybinds.executePlan, cmd: 'forge.plan.execute' }]
      : [],
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
