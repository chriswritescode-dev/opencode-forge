/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from 'solid-js'
import { VERSION } from './version'
import { loadPluginConfig, resolveBundledContainerDir } from './setup'
import { resolveForgeDbPath, resolveDataDir } from './storage'
import type { ExecutionContextCache } from './utils/tui-execution-context-cache'
import { createExecutionContextCache } from './utils/tui-execution-context-cache'
import type { PluginConfig } from './types'
import { DEFAULT_SANDBOX_IMAGE } from './sandbox/template'
import { SandboxBuildDialog } from './tui/sandbox-build-dialog'
import { isSandboxConfigEnabled } from './sandbox/context'
import { existsSync } from 'fs'
import { resolveLoopPermissionOptions } from './constants/loop'
import { emitLoopPermissionConfigWarnings } from './utils/loop-permission-warnings'
import { connectForgeProject, resolveTuiProjectIdOnce, type ForgeProjectClient } from './utils/tui-client'
import { createForgeClient } from './client/sdk-adapter'
import { ExecutePlanPanel, type ExecutePlanPanelProps } from './tui/execute-plan-panel'
import {
  awaitSessionSandboxState,
  beginSessionSandboxStateRequest,
  deriveSandboxPollDelayMs,
  deriveSessionSandboxDisplayStatus,
  hostSandboxToggleBlocked,
  readSessionSandboxPreference,
} from './tui/session-sandbox-store'
import type { SessionSandboxPreference } from './tui/session-sandbox-store'
import { attachLoopSessionFollower, getCurrentRouteSessionId } from './tui/session-follow'
import { openInBrowser, startDashboardServer, type DashboardServerHandle } from './dashboard/launch'
import { describeDashboardBinding } from './dashboard/config'
import { normalizePastedPlanText } from './utils/marked-plan-parser'

type TuiKeybinds = {
  executePlan: string
  dashboard: string
  toggleHostSandbox: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  executePlan: '<leader>f',
  dashboard: '',
  toggleHostSandbox: '',
}

type TuiOptions = {
  sidebar: boolean
  showVersion: boolean
  keybinds: TuiKeybinds
}

type ForgeConnectionStatus = 'connecting' | 'connected' | 'unavailable'

const MSB_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function SandboxLoadingSpinner(props: { api: TuiPluginApi }) {
  const [frame, setFrame] = createSignal(0)
  const animationsEnabled = () => props.api.kv.get('animations_enabled', true)

  createEffect(() => {
    if (!animationsEnabled()) return
    const timer = setInterval(() => setFrame((current) => (current + 1) % MSB_SPINNER_FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })

  return <text fg={props.api.theme.current.textMuted}>{animationsEnabled() ? MSB_SPINNER_FRAMES[frame()] : '⋯'}</text>
}

function SandboxStatusText(props: { api: TuiPluginApi; preference: () => SessionSandboxPreference | null; sessionId?: string }) {
  const theme = () => props.api.theme.current
  const status = createMemo(() => deriveSessionSandboxDisplayStatus(props.preference(), props.sessionId))
  const statusColor = () => {
    const current = status()
    if (current === 'enabled') return theme().secondary
    if (current === 'failed') return theme().error
    return theme().textMuted
  }
  // Secondary while the sandbox is actually acknowledged ON, so an active sandbox stands out
  // against the muted status line instead of reading as ordinary chrome.
  return (
    <Show
      when={status() === 'loading'}
      fallback={<text fg={statusColor()}>· MSB {status()}</text>}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme().textMuted}>· MSB</text>
        <SandboxLoadingSpinner api={props.api} />
      </box>
    </Show>
  )
}

function ForgeSidebarStatus(props: {
  api: TuiPluginApi
  opts: TuiOptions
  status: () => ForgeConnectionStatus
  preference: () => SessionSandboxPreference | null
  sessionId?: string
}) {
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
          <SandboxStatusText api={props.api} preference={props.preference} sessionId={props.sessionId} />
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
  preference: () => SessionSandboxPreference | null
  sessionId?: string
}) {
  const currentClient = createMemo(() => props.client())

  return (
    <Show
      when={currentClient()}
      fallback={<ForgeSidebarStatus api={props.api} opts={props.opts} status={props.status} preference={props.preference} sessionId={props.sessionId} />}
    >
      {(client) => <Sidebar api={props.api} client={client()} cache={props.cache} pluginConfig={props.pluginConfig} opts={props.opts} preference={props.preference} sessionId={props.sessionId} />}
    </Show>
  )
}

function Sidebar(props: {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: () => ExecutionContextCache | null
  pluginConfig: PluginConfig
  opts: TuiOptions
  preference: () => SessionSandboxPreference | null
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
          <SandboxStatusText api={props.api} preference={props.preference} sessionId={props.sessionId} />
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
function ExecutionDialog(props: Omit<ExecutePlanPanelProps, 'onBack' | 'onExecuted' | 'onSelectionChanged'>) {
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
        initialTarget={props.initialTarget}
        projectDirectory={props.projectDirectory}
        onBack={() => props.api.ui.dialog.clear()}
        onSelectionChanged={({ executionModel, auditorModel, executionVariant, auditorVariant, loopName, target }) => {
          props.cache?.setSelectionOverride({ executionModel, auditorModel, executionVariant, auditorVariant })
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
              initialTarget={target}
              projectDirectory={props.projectDirectory}
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
  // Every TUI reader of the forge database resolves it here so a configured
  // `dataDir` cannot leave the dashboard and the execute-plan dialog pointed at
  // different databases.
  const forgeDbPath = resolveForgeDbPath(pluginConfig.dataDir)
  const opts: TuiOptions = {
    sidebar: tuiConfig?.sidebar ?? true,
    showVersion: tuiConfig?.showVersion ?? true,
    keybinds: { ...DEFAULT_KEYBINDS, ...tuiConfig?.keybinds },
  }

  createEffect(() => {
    if (!api.state.ready) return
    emitLoopPermissionConfigWarnings(pluginConfig, pluginConfig.dataDir || resolveDataDir(), directory, {
      logger: console,
      onWarnings: (warnings) => {
        api.ui.toast({ title: 'Forge loop permissions', message: warnings.join(' '), variant: 'warning', duration: 10_000 })
      },
    })
  })

  // Shared disposal flag for the sidebar client and the sandbox preference
  // init/toggle paths. Registered here so it also guards work that runs with
  // the sidebar disabled.
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let sandboxPollTimer: ReturnType<typeof setTimeout> | null = null
  let toggleWaiterController: AbortController | null = null
  api.lifecycle.onDispose(() => {
    disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (sandboxPollTimer) {
      clearTimeout(sandboxPollTimer)
      sandboxPollTimer = null
    }
    if (toggleWaiterController) {
      toggleWaiterController.abort()
      toggleWaiterController = null
    }
  })

  const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })

  const [sandboxProjectId, setSandboxProjectId] = createSignal<string | null>(null)
  const [sandboxPreference, setSandboxPreference] = createSignal<SessionSandboxPreference | null>(null)
  let sandboxInitStarted = false

  const preferenceFieldsEqual = (
    a: SessionSandboxPreference | null,
    b: SessionSandboxPreference | null,
  ): boolean => {
    if (a === b) return true
    if (!a || !b) return false
    return (
      JSON.stringify(a.desired) === JSON.stringify(b.desired) &&
      JSON.stringify(a.applied) === JSON.stringify(b.applied) &&
      JSON.stringify(a.controller) === JSON.stringify(b.controller) &&
      JSON.stringify(a.activeLoopSandboxes) === JSON.stringify(b.activeLoopSandboxes)
    )
  }

  const refreshSandboxAcknowledgement = (projectId: string): SessionSandboxPreference | null => {
    if (disposed) return null
    // When sandboxing is disabled by configuration the server never constructs a
    // reconciler or uses that sandbox, so any persisted ON must not be displayed.
    if (!isSandboxConfigEnabled(pluginConfig)) {
      if (!disposed) setSandboxPreference(null)
      return null
    }
    const pref = readSessionSandboxPreference(projectId, forgeDbPath)
    if (!disposed && !preferenceFieldsEqual(sandboxPreference(), pref)) setSandboxPreference(pref)
    return pref
  }

  // Shared acknowledgement-following loop. Whenever a new desired revision is
  // written (initial restore or a toggle) it keeps polling the local preference
  // pair until it settles, updating the acknowledged signal each step. This runs
  // independently of the command timeout so a late acknowledgement — one the
  // server applies after the toggle's 15s wait expires — still reaches the
  // sidebar instead of leaving it stale until restart.
  const ensureSandboxPolling = (projectId: string): void => {
    if (disposed || sandboxPollTimer || !opts.sidebar) return
    const step = (): void => {
      if (disposed || !opts.sidebar) return
      sandboxPollTimer = null
      if (!isSandboxConfigEnabled(pluginConfig)) return
      const pref = refreshSandboxAcknowledgement(projectId)
      if (!pref) return
      sandboxPollTimer = setTimeout(step, deriveSandboxPollDelayMs(pref))
    }
    step()
  }

  createEffect(() => {
    if (!api.state.ready || sandboxInitStarted) return
    sandboxInitStarted = true
    void (async () => {
      let projectId: string | null = null
      let delayMs = 1000
      for (let attempt = 1; attempt <= 4 && !disposed && !projectId; attempt++) {
        projectId = await resolveTuiProjectIdOnce(api, directory)
        if (disposed || projectId || attempt === 4) break
        await sleepAbortable(delayMs, api.lifecycle.signal)
        delayMs *= 2
      }
      if (disposed) return
      setSandboxProjectId(projectId)
      if (!projectId) return
      // Poll until the preference pair settles. On a clean restart the applied
      // row can lag the persisted desired state while the server reconciles, so
      // a single read would leave ON invisible forever. ensureSandboxPolling
      // reuses the store reader and stops as soon as the pair is settled.
      ensureSandboxPolling(projectId)
    })()
  })

  const runToggleHostSandbox = async () => {
    const toggleBlocked = hostSandboxToggleBlocked(isSandboxConfigEnabled(pluginConfig))
    if (toggleBlocked) {
      api.ui.toast({ message: toggleBlocked, variant: 'warning', duration: 5000 })
      return
    }
    const sessionId = getCurrentRouteSessionId(api)
    if (!sessionId) {
      api.ui.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    // Re-resolve the project ID lazily when a prior attempt failed so a transient
    // discovery failure does not permanently disable the toggle for this process.
    let projectId = sandboxProjectId()
    if (!projectId) {
      projectId = await resolveTuiProjectIdOnce(api, directory)
      if (disposed) return
      setSandboxProjectId(projectId)
    }
    // Each failure below reports a distinct cause. The TUI has no usable log sink (console output
    // corrupts the rendered screen, which is why the msb runtime here is given a no-op logger), so
    // the reason has to travel in the toast or it is lost entirely.
    if (!projectId) {
      api.ui.toast({ message: 'Sandbox toggle unavailable: could not resolve this project', variant: 'warning', duration: 5000 })
      return
    }
    if (!existsSync(forgeDbPath)) {
      api.ui.toast({ message: `Sandbox toggle unavailable: no Forge database at ${forgeDbPath}`, variant: 'warning', duration: 5000 })
      return
    }
    const pref = readSessionSandboxPreference(projectId, forgeDbPath)
    // A snapshot flagged as unavailable (missing/uninitialized table) must not be treated as "no
    // persisted state": deriving from null here could issue an ON request that the server never
    // acknowledges, or misreport the current state. Reject it before deriving or writing.
    if (pref.unavailable) {
      const reason = pref.unavailableReason ?? 'unknown reason'
      api.ui.toast({ message: `Sandbox toggle unavailable: Forge preferences unreadable (${reason})`, variant: 'warning', duration: 5000 })
      return
    }
    const { desired } = pref
    const turningOff = desired?.enabled === true && desired.sessionId === sessionId
    const nextEnabled = !turningOff
    let revision: string | null = null
    let waiterController: AbortController | null = null
    try {
      revision = beginSessionSandboxStateRequest(projectId, forgeDbPath, {
        sessionId,
        enabled: nextEnabled,
      })
      if (disposed) return
      // Immediately re-derive the acknowledged state from the authoritative
      // desired/applied pair. The new desired revision supersedes the prior
      // applied acknowledgement, so a stale ON (previous revision/session) is
      // cleared before the request even resolves.
      refreshSandboxAcknowledgement(projectId)
      // Follow this desired revision to its acknowledgement independently of the
      // command timeout, so a late server apply still reaches the sidebar.
      ensureSandboxPolling(projectId)
      if (toggleWaiterController) toggleWaiterController.abort()
      waiterController = new AbortController()
      toggleWaiterController = waiterController
      const signal = AbortSignal.any([waiterController.signal, api.lifecycle.signal])
      const applied = await awaitSessionSandboxState(projectId, forgeDbPath, revision, {
        timeoutMs: 15_000,
        pollMs: 250,
        signal,
      })
      if (toggleWaiterController === waiterController) toggleWaiterController = null
      if (disposed) return
      // Re-read the authoritative desired/applied pair before publishing state or
      // success. A superseded acknowledgement (a newer toggle already moved the
      // desired revision) must not render stale ON; only a current revision still
      // warrants a success toast.
      const pref = refreshSandboxAcknowledgement(projectId)
      if (pref?.desired && pref.desired.revision === applied.revision) {
        api.ui.toast({
          message: `Host sandbox ${applied.enabled ? 'enabled' : 'disabled'} for this session`,
          variant: 'success',
          duration: 4000,
        })
      }
    } catch (err) {
      if (waiterController && toggleWaiterController === waiterController) toggleWaiterController = null
      if (disposed) return
      // The failed request may have superseded a prior acknowledged state with a
      // new desired revision that never got applied. Re-read the authoritative
      // pair and re-derive so a stale ON for the previous session is cleared.
      const pref = refreshSandboxAcknowledgement(projectId)
      // Suppress errors for superseded requests: when a newer toggle already
      // moved the desired revision, this waiter is stale and must not report a
      // false failure long after the latest request succeeded.
      if (pref?.desired && revision && pref.desired.revision !== revision) return
      const message = err instanceof Error ? err.message : String(err)
      const guidance = nextEnabled ? 'Toggle off, then on to retry.' : 'Toggle again to retry disabling.'
      api.ui.toast({
        message: `Sandbox toggle failed: ${message}. ${guidance}`,
        variant: 'error',
        duration: 6000,
      })
    }
  }

  // Auto-follow loop session rotations. Runs independently of the sidebar
  // option so users with the sidebar disabled still get follow-on-rotation.
  const detachSessionFollower = attachLoopSessionFollower(api)
  api.lifecycle.onDispose(detachSessionFollower)

  // Dashboard command. Registered independently of the sidebar option so it is
  // available even when the sidebar is disabled. The bind host/port come from
  // `dashboard.*` in the plugin config (resolved via `startDashboardServer`),
  // and the HTTP server is started in-process on first use and reused on
  // subsequent invocations.
  let dashboardServer: DashboardServerHandle | null = null
  const runOpenDashboard = () => {
    if (!dashboardServer) {
      try {
        dashboardServer = startDashboardServer({
          dbPath: forgeDbPath,
          config: pluginConfig,
          client: createForgeClient(api.client),
        })
      } catch (err) {
        api.ui.toast({
          message: err instanceof Error ? err.message : 'Failed to start dashboard',
          variant: 'error',
          duration: 5000,
        })
        return
      }
    }
    const notice = describeDashboardBinding(dashboardServer)
    const opened = openInBrowser(dashboardServer.localUrl)
    const details = [
      ...(notice.localUrl ? [`Local: ${notice.localUrl}`] : []),
      ...dashboardServer.warnings,
      ...(notice.warning ? [notice.warning] : []),
    ]
    const alert = Boolean(notice.warning) || dashboardServer.warnings.length > 0
    api.ui.toast({
      title: `Forge dashboard: ${notice.url}`,
      message: details.length > 0
        ? details.join('\n')
        : opened
          ? 'Opened in your browser.'
          : 'Could not open a browser automatically; open the URL manually.',
      variant: alert ? 'warning' : 'info',
      duration: alert ? 10_000 : 5000,
    })
  }

  api.lifecycle.onDispose(() => {
    if (dashboardServer) {
      dashboardServer.stop()
      dashboardServer = null
    }
  })

  const runBuildSandboxImage = () => {
    const buildContextDir = resolveBundledContainerDir()
    const image = pluginConfig.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE
    const browserControl = pluginConfig.sandbox?.imageFeatures?.browserControl === true

    api.ui.dialog.setSize('medium')
    api.ui.dialog.replace(() => (
      <SandboxBuildDialog
        api={api}
        buildContextDir={buildContextDir}
        image={image}
        browserControl={browserControl}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: 'forge.dashboard',
        title: 'Open dashboard',
        desc: 'Start the Forge dashboard server and open it in the browser',
        category: 'Forge',
        namespace: 'palette',
        run: () => { runOpenDashboard() },
      },
      {
        name: 'forge.sandbox.buildImage',
        title: 'Build sandbox template',
        desc: 'Build the sandbox template image and load it into msb',
        category: 'Forge',
        namespace: 'palette',
        run: () => { runBuildSandboxImage() },
      },
      {
        name: 'forge.sandbox.toggleHost',
        title: 'Toggle host sandbox',
        desc: 'Enable or disable the host sandbox for the current session',
        category: 'Forge',
        namespace: 'palette',
        run: () => { void runToggleHostSandbox() },
      },
    ],
    bindings: [
      ...(opts.keybinds.dashboard
        ? [{ key: opts.keybinds.dashboard, cmd: 'forge.dashboard' as const }]
        : []),
      ...(opts.keybinds.toggleHostSandbox
        ? [{ key: opts.keybinds.toggleHostSandbox, cmd: 'forge.sandbox.toggleHost' as const }]
        : []),
    ],
  })

  if (!opts.sidebar) return

  const [client, setClient] = createSignal<ForgeProjectClient | null>(null)
  const [connectionStatus, setConnectionStatus] = createSignal<ForgeConnectionStatus>('connecting')
  const [executionContextCache, setExecutionContextCache] = createSignal<ExecutionContextCache | null>(null)
  let connectPromise: Promise<ForgeProjectClient | null> | null = null
  let unavailableToastShown = false

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
    connectPromise = connectForgeProject(api, directory, resolveLoopPermissionOptions(pluginConfig), forgeDbPath).then((connected) => untrack(() => {
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
        projectDirectory={directory}
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
        title: 'Execute plan',
        desc: 'Open the execution dialog for the current session plan, or paste one if none is found',
        category: 'Forge',
        namespace: 'palette',
        run: () => { void runExecutePlan() },
      },
      {
        name: 'forge.plan.executePasted',
        title: 'Execute pasted plan',
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
          preference={sandboxPreference}
          sessionId={slotProps.session_id}
        />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
