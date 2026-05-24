/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js'
import { VERSION } from './version'
import { loadPluginConfig } from './setup'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { connectForgeProject, type ForgeProjectClient } from './utils/tui-client'

type TuiKeybinds = Record<string, string>

const DEFAULT_KEYBINDS: TuiKeybinds = {}

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

  createEffect(() => {
    if (!api.state.ready || client() || connectPromise) return
    void startClientConnection()
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
