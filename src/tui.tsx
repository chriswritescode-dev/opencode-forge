/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js'
import { VERSION } from './version'
import { loadPluginConfig, resolveBundledContainerDir } from './setup'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { createDockerService } from './sandbox/docker'
import { connectForgeProject, type ForgeProjectClient } from './utils/tui-client'
import { ExecutePlanPanel } from './tui/execute-plan-panel'
import { attachLoopSessionFollower, getCurrentRouteSessionId } from './tui/session-follow'
import { openInBrowser, startDashboardServer, type DashboardServerHandle } from './dashboard/launch'
import { createEventBroadcaster, type EventBroadcaster } from './dashboard/event-broadcaster'
import { startActivityForwarding } from './dashboard/opencode-events'
import { createForgeClient, createForgeClientFromServerUrl } from './client/sdk-adapter'
import { normalizePastedPlanText } from './utils/marked-plan-parser'

type TuiKeybinds = {
  executePlan: string
  dashboard: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  executePlan: '<leader>f',
  dashboard: '',
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

function SandboxBuildDialog(props: {
  api: TuiPluginApi
  buildContextDir: string
  image: string
}) {
  const theme = () => props.api.theme.current

  const doBuild = async () => {
    props.api.ui.dialog.clear()
    props.api.ui.toast({ message: `Building sandbox image ${props.image}...`, variant: 'info', duration: 5000 })

    const logger = { log: () => {}, error: () => {}, debug: () => {} }
    const docker = createDockerService(logger)

    try {
      await docker.buildImage(props.buildContextDir, props.image)
      props.api.ui.toast({
        message: `Sandbox image ${props.image} built successfully`,
        variant: 'success',
        duration: 5000,
      })
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err)
      const message = rawMessage.includes('spawn docker ENOENT')
        ? 'Docker CLI not found. Is Docker installed and running?'
        : rawMessage.split('\n').filter(Boolean).at(-1)?.trim() || rawMessage.slice(0, 200)
      props.api.ui.toast({ message, variant: 'error', duration: 10_000 })
    }
  }

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>Build sandbox Docker image</b>
        </text>
      </box>

      <box paddingBottom={1}>
        <text fg={theme().textMuted}>
          This will build the sandbox image from the bundled Dockerfile.
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>Image: {props.image}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>Context: {props.buildContextDir}</text>
      </box>

      <box paddingTop={1} paddingX={1} flexShrink={0}>
        <select
          focused={true}
          selectedIndex={0}
          options={[
            { name: 'Build', description: 'Press enter to build the sandbox image', value: 'build' },
            { name: 'Cancel', description: 'Press enter to close this dialog', value: 'cancel' },
          ]}
          onSelect={(_, option) => {
            if (option?.value === 'build') {
              void doBuild()
              return
            }
            if (option?.value === 'cancel') {
              props.api.ui.dialog.clear()
            }
          }}
          showDescription={true}
          itemSpacing={1}
          wrapSelection={true}
          textColor={theme().text}
          focusedTextColor={theme().text}
          selectedTextColor="#ffffff"
          selectedBackgroundColor={theme().borderActive}
          minHeight={4}
          flexShrink={0}
        />
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

  // Dashboard command. Registered independently of the sidebar option so it is
  // available even when the sidebar is disabled. The HTTP server is started
  // in-process on first use and reused on subsequent invocations.
  let dashboardServer: DashboardServerHandle | null = null
  let broadcaster: EventBroadcaster | null = null
  let detachEvents: (() => void) | null = null
  const runOpenDashboard = () => {
    if (!dashboardServer) {
      try {
        broadcaster = createEventBroadcaster()
        dashboardServer = startDashboardServer({ events: broadcaster })
        const eventsConfig = pluginConfig.dashboard?.events
        // Server source (default) uses the in-process client so it forwards
        // whatever server this TUI is attached to — zero config for the common
        // case. A configured serverUrl targets a different/shared server.
        const forgeClient = eventsConfig?.serverUrl
          ? createForgeClientFromServerUrl(eventsConfig.serverUrl)
          : createForgeClient(api.client)
        detachEvents = startActivityForwarding(
          { source: eventsConfig?.source, types: eventsConfig?.types },
          { publish: broadcaster.publish, client: forgeClient, eventBus: api.event },
        )
      } catch (err) {
        // Clean up on failure so a retry starts fresh.
        detachEvents?.()
        broadcaster?.close()
        detachEvents = null
        broadcaster = null
        api.ui.toast({
          message: err instanceof Error ? err.message : 'Failed to start dashboard',
          variant: 'error',
          duration: 5000,
        })
        return
      }
    }
    const opened = openInBrowser(dashboardServer.url)
    api.ui.toast({
      message: opened
        ? `Forge dashboard: ${dashboardServer.url}`
        : `Forge dashboard running at ${dashboardServer.url}`,
      variant: 'info',
      duration: 5000,
    })
  }

  api.lifecycle.onDispose(() => {
    detachEvents?.()
    broadcaster?.close()
    detachEvents = null
    broadcaster = null
    if (dashboardServer) {
      dashboardServer.stop()
      dashboardServer = null
    }
  })

  const runBuildSandboxImage = () => {
    const buildContextDir = resolveBundledContainerDir()
    const image = pluginConfig.sandbox?.image ?? 'oc-forge-sandbox:latest'

    api.ui.dialog.setSize('medium')
    api.ui.dialog.replace(() => (
      <SandboxBuildDialog
        api={api}
        buildContextDir={buildContextDir}
        image={image}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: 'forge.dashboard',
        title: 'Forge: Open dashboard',
        desc: 'Start the Forge dashboard server and open it in the browser',
        category: 'Forge',
        namespace: 'palette',
        run: () => { runOpenDashboard() },
      },
      {
        name: 'forge.sandbox.buildImage',
        title: 'Forge: Build sandbox image',
        desc: 'Build the Docker sandbox image from the bundled Dockerfile',
        category: 'Forge',
        namespace: 'palette',
        run: () => { runBuildSandboxImage() },
      },
    ],
    bindings: [
      ...(opts.keybinds.dashboard
        ? [{ key: opts.keybinds.dashboard, cmd: 'forge.dashboard' as const }]
        : []),
    ],
  })

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
    connectPromise = connectForgeProject(api, directory, pluginConfig.loop?.allowExternalDirectories).then((connected) => untrack(() => {
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

    const planText = await currentClient.loadLatestPlan(sessionID)
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
