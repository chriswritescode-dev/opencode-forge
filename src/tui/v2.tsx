/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { existsSync } from 'fs'
import { For, Show, createEffect, createMemo, createRoot, createSignal, onCleanup, type Accessor } from 'solid-js'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { DEFAULT_SANDBOX_IMAGE, formatTemplateBuildCommands, resolveTemplateBuildArgs } from '../sandbox/template'
import { loadPluginConfig, resolveBundledContainerDir } from '../setup'
import {
  FORGE_RPC,
  readForgeAmendmentDiff,
  readForgeAutoApproveChangedEvent,
  readForgeAutoApproveState,
  readForgeDashboardSummary,
  readForgeHostSandboxSetOutput,
  readForgeHostSandboxState,
  readForgeLoopDefaults,
  readForgeLoopDetail,
  readForgeLoopSidebar,
  readForgePlanDeleteOutput,
  readForgeProjectChangedEvent,
  readForgeProjectFindings,
  readForgeSessionPlan,
  readForgeVersion,
  readForgeWorktrees,
  type ForgeToastEvent,
  type ForgeWorktreesOutput,
} from '../host/forge-rpc'
import { FORGE_DASHBOARD_COMMAND, formatForgeTitle, resolveTuiOptions } from './options'
import { createDashboardStore } from './dashboard/store'
import { DashboardLoopPage, DashboardPage } from './dashboard/pages'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import { formatDuration } from '../utils/duration'
import { phaseLabel } from '../utils/phase-label'
import { isToastVariant } from '../utils/toast'
import { isWithinDir } from '../workspace/forge-naming'
import type { ForgeProjectClient } from './project-client'
import { createExecutionContextCache, type ExecutionContextCache } from '../utils/tui-execution-context-cache'
import { createV2TuiHost } from './host'
import { createForgePlanCommands } from './plan-commands'
import { openSandboxBuildDialog } from './sandbox-build-dialog'
import { attachV2LoopSessionFollower } from './session-follow'
import { readForgeSessionDelete, removeOrphanedLoopSessions, removeSessionBestEffort, type ForgeWorktreeList } from './loop-session-cleanup'
import { createForgeRpcCaller, createV2ForgeProjectClient, followRpcEvent } from './v2-client'
import { createHostSandboxToggle } from './host-sandbox'
import { editHostSandbox } from './host-sandbox-dialog'
import { createLoopSidebarStore, type LoopSidebarStore } from './loop-sidebar'
import { createSessionAutoApproveToggle } from './session-auto-approve'
import { deriveSessionSandboxDisplayStatus, type SessionSandboxPreference } from './session-sandbox-store'
import { VERSION } from '../version'

/** Most recent loops shown in the sidebar. */
const SIDEBAR_LOOP_LIMIT = 3

/** A failed worktrees lookup is remembered briefly so a flapping RPC is not retried on every session. */
const WORKTREES_NEGATIVE_CACHE_MS = 5000

/** Current location directory, or null when neither the context nor its default resolves. */
function resolveV2TuiDirectory(context: Plugin.Context): string | null {
  try {
    return context.location?.directory ?? context.data.location.default().directory
  } catch {
    return null
  }
}

/**
 * Project id for the current location, resolved through the client. Returns null
 * on any failure so callers render an empty sidebar instead of another project's
 * loops.
 */
export async function resolveV2TuiProjectId(context: Plugin.Context): Promise<string | null> {
  const directory = resolveV2TuiDirectory(context)
  if (!directory) return null
  return resolveV2TuiProjectIdForDirectory(context, directory)
}

async function resolveV2TuiProjectIdForDirectory(context: Plugin.Context, directory: string): Promise<string | null> {
  try {
    const info = await context.client.location.get({ location: { directory } })
    return info.project.id
  } catch {
    return null
  }
}

function readForgeToast(data: Readonly<Record<string, unknown>>): ForgeToastEvent | null {
  const { projectId, message, title, variant, duration } = data
  if (typeof projectId !== 'string' || typeof message !== 'string') return null
  return {
    projectId,
    message,
    ...(typeof title === 'string' ? { title } : {}),
    ...(isToastVariant(variant) ? { variant } : {}),
    ...(typeof duration === 'number' ? { duration } : {}),
  }
}

const MSB_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function SandboxStatusText(props: {
  context: Plugin.Context
  preference: Accessor<SessionSandboxPreference | null>
  sessionId: Accessor<string | null>
}) {
  const theme = () => props.context.theme
  const status = createMemo(() => deriveSessionSandboxDisplayStatus(props.preference(), props.sessionId() ?? undefined))
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (status() !== 'loading') return
    const timer = setInterval(() => setFrame((current) => (current + 1) % MSB_SPINNER_FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })

  const color = () => {
    const current = status()
    if (current === 'enabled') return theme().text.feedback.success.base
    if (current === 'failed') return theme().text.feedback.error.base
    return theme().text.muted
  }

  return (
    <text fg={color()}>
      {status() === 'loading' ? `· MSB ${MSB_SPINNER_FRAMES[frame()]}` : `· MSB ${status()}`}
    </text>
  )
}

function formatElapsed(ms: number): string {
  return formatDuration(Math.max(0, Math.floor(ms / 1000)))
}

/**
 * Detail of an expanded running loop: current phase with its elapsed time, then
 * section and total elapsed time. The row data arrives only with the
 * `loopsChanged`-driven refresh; the local clock only advances the displayed
 * times and stops when the row collapses.
 */
function LoopRunDetail(props: { context: Plugin.Context; loop: LoopSidebarRow }) {
  const theme = () => props.context.theme
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const progress = () => {
    const total = `${formatElapsed(now() - props.loop.startedAt)} total`
    return props.loop.totalSections > 0
      ? `Section ${props.loop.currentSectionIndex + 1}/${props.loop.totalSections} · ${total}`
      : total
  }
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text fg={theme().text.feedback.info.base}>
        {`${phaseLabel(props.loop.phase)} · ${formatElapsed(now() - props.loop.phaseStartedAt)}`}
      </text>
      <text fg={theme().text.muted}>{progress()}</text>
    </box>
  )
}

function ForgeLoopsSidebar(props: {
  context: Plugin.Context
  showVersion: boolean
  sandboxPreference: Accessor<SessionSandboxPreference | null>
  autoApprove: Accessor<boolean>
  currentSessionId: () => string | null
  loops: Accessor<LoopSidebarRow[]>
}) {
  const theme = () => props.context.theme
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const toggleExpanded = (loopName: string) => setExpanded((current) => {
    const next = new Set(current)
    if (!next.delete(loopName)) next.add(loopName)
    return next
  })
  const statusColor = (status: LoopSidebarRow['status']) => {
    const { text } = theme()
    if (status === 'running') return text.feedback.info.base
    if (status === 'completed') return text.feedback.success.base
    if (status === 'errored') return text.feedback.error.base
    if (status === 'stalled') return text.feedback.warning.base
    return text.muted
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={theme().text.base}>
          <b>{formatForgeTitle(props.showVersion)}</b>
        </text>
        <Show when={props.sandboxPreference()}>
          <SandboxStatusText context={props.context} preference={props.sandboxPreference} sessionId={props.currentSessionId} />
        </Show>
        <Show when={props.autoApprove()}>
          <text fg={theme().text.feedback.warning.base}>· AUTO</text>
        </Show>
      </box>
      <Show when={props.loops().length > 0} fallback={<text fg={theme().text.muted}>No loops</text>}>
        <For each={props.loops()}>
          {(loop) => {
            const running = loop.status === 'running'
            const isExpanded = () => running && expanded().has(loop.loopName)
            const marker = () => (!running ? '•' : isExpanded() ? '▾' : '▸')
            return (
              <box flexDirection="column">
                <box flexDirection="row" gap={1} onMouseUp={() => { if (running) toggleExpanded(loop.loopName) }}>
                  <text flexShrink={0} fg={statusColor(loop.status)}>{marker()}</text>
                  <text
                    flexGrow={1}
                    flexShrink={1}
                    wrapMode="none"
                    truncate
                    fg={loop.status === 'running' ? theme().text.base : theme().text.muted}
                  >
                    {loop.loopName}
                  </text>
                  <text flexShrink={0} fg={statusColor(loop.status)}>{loop.status}</text>
                  <text flexShrink={0} fg={theme().text.muted}>{`${loop.iteration}/${loop.maxIterations}`}</text>
                </box>
                <Show when={isExpanded()}>
                  <LoopRunDetail context={props.context} loop={loop} />
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

/**
 * V2 TUI surface: the dashboard pages and their `forge.dashboard` entry point,
 * execute-plan (which also pastes plans and restarts loops), sandbox-build
 * commands, loop session auto-follow, a loop sidebar, and the
 * missing-build-context toast. Returns the cleanup for all of them.
 */
export function setupForgeTuiV2(context: Plugin.Context): () => void {
  const pluginConfig = loadPluginConfig()
  const opts = resolveTuiOptions(pluginConfig.tui, context.options)

  const buildContextDir = resolveBundledContainerDir()
  if (isSandboxConfigEnabled(pluginConfig) && !existsSync(buildContextDir)) {
    context.ui.toast.show({
      title: 'Sandbox build context missing',
      message: `Sandboxing is enabled but the bundled build context is missing at ${buildContextDir}. Reinstall opencode-forge, then build the template: ${formatTemplateBuildCommands(buildContextDir, pluginConfig.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE, resolveTemplateBuildArgs(pluginConfig))}`,
      variant: 'warning',
      duration: 10_000,
    })
  }

  const lifecycle = new AbortController()
  const host = createV2TuiHost(context)

  /** The TUI can switch projects, so each location directory gets its own client and cache. */
  const projectClients = new Map<string, { client: ForgeProjectClient; cache: ExecutionContextCache }>()

  const ensureClient = async (): Promise<{ client: ForgeProjectClient; cache: ExecutionContextCache } | null> => {
    const directory = resolveV2TuiDirectory(context)
    const cached = directory ? projectClients.get(directory) : undefined
    if (cached) return cached
    const projectId = directory ? await resolveV2TuiProjectIdForDirectory(context, directory) : null
    if (lifecycle.signal.aborted) return null
    if (!directory || !projectId) {
      host.toast({ message: 'Forge could not resolve the current project', variant: 'warning', duration: 5000 })
      return null
    }
    const existing = projectClients.get(directory)
    if (existing) return existing
    const client = createV2ForgeProjectClient(context, {
      projectId,
      directory,
    })
    const entry = {
      client,
      cache: createExecutionContextCache(projectId, pluginConfig, () => client.loadExecutionContext()),
    }
    projectClients.set(directory, entry)
    return entry
  }

  const currentSessionId = (): string | null => {
    const route = context.ui.router.current()
    return route.type === 'session' ? route.sessionID : null
  }

  const call = createForgeRpcCaller(context, () => resolveV2TuiDirectory(context))

  const dashboardStore = createDashboardStore({
    readSummary: () => call((rpc, location) => rpc.dashboardSummary({}, location), readForgeDashboardSummary),
    readLoopDetail: (input) => call((rpc, location) => rpc.loopDetail(input, location), readForgeLoopDetail),
    readProjectFindings: (input) => call(
      (rpc, location) => rpc.projectFindings(input, location),
      readForgeProjectFindings,
    ),
    readAmendmentDiff: (input) => call((rpc, location) => rpc.amendmentDiff(input, location), readForgeAmendmentDiff),
    readSessionPlan: ({ projectId, sessionId }) => call(
      (rpc, location) => rpc.sessionPlan({ sessionId, projectId }, location),
      readForgeSessionPlan,
    ),
    deletePlan: ({ projectId, sessionId }) => call(
      (rpc, location) => rpc.planDelete({ projectId, sessionId }, location),
      readForgePlanDeleteOutput,
    ),
    currentDirectory: () => resolveV2TuiDirectory(context),
    resolveProjectId: (directory) => resolveV2TuiProjectIdForDirectory(context, directory),
    confirm: async (input) => (await context.ui.dialog.confirm(input)) === true,
    toast: (input) => host.toast(input),
  })

  const unregisterDashboardPage = context.ui.router.register({
    name: 'forge-dashboard',
    render: () => <DashboardPage context={context} store={dashboardStore} />,
  })
  const unregisterDashboardLoopPage = context.ui.router.register({
    name: 'forge-dashboard-loop',
    render: (input) => <DashboardLoopPage context={context} store={dashboardStore} data={input.data} />,
  })

  let worktreesCache: ForgeWorktreeList | null = null
  let worktreesFailure: { at: number; error: string } | null = null
  let worktreesRequest: Promise<ForgeWorktreesOutput> | null = null

  /**
   * The single worktrees lookup for this TUI. A success is cached for the TUI
   * lifetime; a failure is remembered for {@link WORKTREES_NEGATIVE_CACHE_MS}.
   * `fresh` bypasses both caches so a caller that must observe a worktree created
   * mid-operation reads the live list.
   */
  const loadWorktrees = (options?: { fresh?: boolean }): Promise<ForgeWorktreesOutput> => {
    if (!options?.fresh) {
      if (worktreesCache) return Promise.resolve(worktreesCache)
      if (worktreesFailure && Date.now() - worktreesFailure.at < WORKTREES_NEGATIVE_CACHE_MS) {
        return Promise.resolve({ error: worktreesFailure.error })
      }
      if (worktreesRequest) return worktreesRequest
    }
    const request = call((rpc, location) => rpc.worktrees({}, location), readForgeWorktrees)
      .then((result) => {
        if ('error' in result) {
          worktreesFailure = { at: Date.now(), error: result.error }
          return result
        }
        worktreesCache = result
        worktreesFailure = null
        return result
      })
    if (options?.fresh) return request
    worktreesRequest = request.finally(() => { worktreesRequest = null })
    return worktreesRequest
  }

  const loadWorktreesRoot = async (): Promise<string | null> => {
    const result = await loadWorktrees()
    return 'error' in result ? null : result.root
  }

  const planCommands = createForgePlanCommands({
    host,
    pluginConfig,
    currentSessionId,
    ensureClient,
  })

  const hostSandbox = createHostSandboxToggle({
    readState: () => call((rpc, location) => rpc.hostSandboxState({}, location), readForgeHostSandboxState),
    setState: (input) => call(
      (rpc, location) => rpc.hostSandboxSet(input, location),
      readForgeHostSandboxSetOutput,
    ),
    currentSessionId,
    toast: (input) => host.toast(input),
  })

  const autoApprove = createSessionAutoApproveToggle({
    currentSessionId,
    readState: (sessionId) => call((rpc, location) => rpc.autoApproveState({ sessionId }, location), readForgeAutoApproveState),
    setState: (sessionId, enabled) => call((rpc, location) => rpc.autoApproveSet({ sessionId, enabled }, location), readForgeAutoApproveState),
    isSandboxedSession: (id) => deriveSessionSandboxDisplayStatus(hostSandbox.preference(), id) === 'enabled',
    toast: (input) => host.toast(input),
  })

  let loopSidebar: LoopSidebarStore | null = null
  if (opts.sidebar) {
    const sidebar = createLoopSidebarStore({
      readLoops: () => call(
        (rpc, location) => rpc.loopSidebar({ limit: SIDEBAR_LOOP_LIMIT }, location),
        readForgeLoopSidebar,
      ),
    })
    loopSidebar = sidebar
    context.ui.slot({
      append: 'sidebar.content',
      render: () => (
        <ForgeLoopsSidebar
          context={context}
          showVersion={opts.showVersion}
          sandboxPreference={hostSandbox.preference}
          autoApprove={autoApprove.enabled}
          currentSessionId={currentSessionId}
          loops={sidebar.loops}
        />
      ),
    })
  }

  const detachSessionFollower = attachV2LoopSessionFollower(context, async (directory) => {
    const root = await loadWorktreesRoot()
    return root !== null && isWithinDir(root, directory)
  })

  // A keymap layer needs a component owner, so the command is registered from
  // the always-mounted app slot rather than from setup itself.
  context.ui.slot({
    append: 'app',
    render: () => {
      context.keymap.layer(() => ({
        mode: 'global',
        commands: [
          {
            id: FORGE_DASHBOARD_COMMAND.id,
            title: FORGE_DASHBOARD_COMMAND.title,
            description: FORGE_DASHBOARD_COMMAND.description,
            group: FORGE_DASHBOARD_COMMAND.group,
            palette: true,
            ...(opts.keybinds.dashboard ? { bind: opts.keybinds.dashboard } : {}),
            run: () => {
              dashboardStore.open(context.ui.router.current())
              context.ui.router.navigate({ type: 'plugin', name: 'forge-dashboard' })
            },
          },
          {
            id: 'forge.plan.execute',
            title: 'Execute plan',
            description: 'Run the session plan or a pasted plan with loop settings, or restart a loop',
            group: 'Forge',
            palette: true,
            ...(opts.keybinds.executePlan ? { bind: opts.keybinds.executePlan } : {}),
            run: () => { void planCommands.executePlan() },
          },
          {
            id: 'forge.sandbox.toggleHost',
            title: 'Toggle sandbox',
            description: 'Run this session\'s agent shell, glob, and grep calls in the sandbox or on the host, and set its CPUs, memory, and LAN access',
            group: 'Forge',
            palette: true,
            ...(opts.keybinds.toggleHostSandbox ? { bind: opts.keybinds.toggleHostSandbox } : {}),
            run: () => {
              void editHostSandbox({
                host,
                sandbox: hostSandbox,
                currentSessionId,
                loadDefaults: async () => {
                  const defaults = await call((rpc, location) => rpc.loopDefaults({}, location), readForgeLoopDefaults)
                  return 'error' in defaults ? null : defaults
                },
              })
            },
          },
          {
            id: 'forge.permissions.toggleAutoApprove',
            title: 'Toggle auto-approve',
            description: 'Allow or deny this session\'s permission requests without prompting',
            group: 'Forge',
            palette: true,
            ...(opts.keybinds.toggleAutoApprove ? { bind: opts.keybinds.toggleAutoApprove } : {}),
            run: () => { void autoApprove.toggle() },
          },
          {
            id: 'forge.sandbox.buildImage',
            title: 'Build sandbox template',
            description: 'Build the sandbox template image and load it into msb',
            group: 'Forge',
            palette: true,
            run: () => openSandboxBuildDialog(host, pluginConfig),
          },
        ],
      }))
      return null
    },
  })

  const eventController = new AbortController()
  const eventProjectIds = new Map<string, Promise<string | null>>()

  /**
   * Whether an RPC event for `projectId` belongs to the project the TUI currently shows, or null
   * when that is unknown because the lookup failed or the TUI moved to another location meanwhile.
   * The TUI can switch projects, so the id is resolved for the current location, cached per
   * directory, and a failed lookup is dropped so the next event retries it.
   */
  const isCurrentProject = async (projectId: string): Promise<boolean | null> => {
    const directory = resolveV2TuiDirectory(context)
    if (!directory) return null
    let lookup = eventProjectIds.get(directory)
    if (!lookup) {
      lookup = resolveV2TuiProjectIdForDirectory(context, directory)
      eventProjectIds.set(directory, lookup)
    }
    const current = await lookup
    if (current === null && eventProjectIds.get(directory) === lookup) eventProjectIds.delete(directory)
    if (current === null || resolveV2TuiDirectory(context) !== directory) return null
    return current === projectId
  }

  /**
   * Re-reads state for an RPC event unless it belongs to another project. An unknown current
   * project still refreshes: a refresh only re-reads the current location, and dropping the event
   * could lose the acknowledgement a pending host sandbox toggle waits for.
   */
  const refreshForProject = (projectId: string, refresh: () => void): void => {
    void isCurrentProject(projectId).then((current) => {
      if (!eventController.signal.aborted && current !== false) refresh()
    })
  }

  try {
    if (typeof context.client.rpc !== 'function') {
      throw new Error('context.client.rpc is unavailable')
    }
    const rpcEvents = context.client.rpc(FORGE_RPC).events
    const signal = eventController.signal
    const refreshLoops = (): void => {
      loopSidebar?.refresh()
      hostSandbox.refresh()
    }
    followRpcEvent((s) => rpcEvents.subscribe('toast', { signal: s }), (event) => {
      const toast = readForgeToast(event.data)
      if (!toast) return
      void isCurrentProject(toast.projectId).then((current) => {
        if (eventController.signal.aborted || current !== true) return
        context.ui.toast.show({
          title: toast.title,
          message: toast.message,
          variant: toast.variant,
          duration: toast.duration,
        })
      })
    }, { signal })
    followRpcEvent((s) => rpcEvents.subscribe('sessionDelete', { signal: s }), (event) => {
      const sessionID = readForgeSessionDelete(event.data)
      if (sessionID) void removeSessionBestEffort(context, sessionID)
    }, { signal })
    followRpcEvent((s) => rpcEvents.subscribe('loopsChanged', { signal: s }), (event) => {
      const changed = readForgeProjectChangedEvent(event.data)
      if (!changed) return
      dashboardStore.handleChange('loops', changed.projectId)
      refreshForProject(changed.projectId, refreshLoops)
    }, { signal, onResubscribed: () => { refreshLoops(); dashboardStore.handleResubscribed() } })
    followRpcEvent((s) => rpcEvents.subscribe('plansChanged', { signal: s }), (event) => {
      const changed = readForgeProjectChangedEvent(event.data)
      if (!changed) return
      dashboardStore.handleChange('plans', changed.projectId)
    }, { signal, onResubscribed: dashboardStore.handleResubscribed })
    followRpcEvent((s) => rpcEvents.subscribe('autoApproveChanged', { signal: s }), (event) => {
      const changed = readForgeAutoApproveChangedEvent(event.data)
      if (!changed) return
      refreshForProject(changed.projectId, autoApprove.refresh)
    }, { signal, onResubscribed: () => { autoApprove.refresh(); dashboardStore.handleResubscribed() } })
    followRpcEvent((s) => rpcEvents.subscribe('hostSandboxChanged', { signal: s }), (event) => {
      const changed = readForgeProjectChangedEvent(event.data)
      if (!changed) return
      refreshForProject(changed.projectId, hostSandbox.refresh)
    }, { signal, onResubscribed: () => { hostSandbox.refresh(); dashboardStore.handleResubscribed() } })
  } catch (err) {
    console.error('[forge] failed to subscribe to Forge RPC events', err)
  }

  const detachConnected = context.data.on('server.connected', () => {
    loopSidebar?.refresh()
    autoApprove.refresh()
    hostSandbox.refresh()
    dashboardStore.handleResubscribed()
  })

  let sessionChangeSeen = false
  const disposeSessionChange = createRoot((dispose) => {
    createEffect(() => {
      currentSessionId()
      if (!sessionChangeSeen) {
        sessionChangeSeen = true
        return
      }
      autoApprove.refresh()
      hostSandbox.refresh()
    })
    return dispose
  })

  void call((rpc, location) => rpc.version({}, location), readForgeVersion).then((result) => {
    if (lifecycle.signal.aborted) return
    const serverVersion = 'error' in result ? null : result.version
    if (serverVersion === VERSION) return
    context.ui.toast.show({
      message: `Forge server plugin ${serverVersion ?? 'unknown (older than this TUI)'} differs from TUI ${VERSION}; restart the OpenCode server`,
      variant: 'warning',
      duration: 10_000,
    })
  })

  void resolveV2TuiProjectId(context).then(async (projectId) => {
    if (!projectId || lifecycle.signal.aborted) return
    await removeOrphanedLoopSessions(context, projectId, loadWorktrees, lifecycle.signal)
  }).catch((err: unknown) => {
    console.error('[forge] failed to remove orphaned loop sessions', err)
  })

  return () => {
    lifecycle.abort()
    hostSandbox.dispose()
    autoApprove.dispose()
    loopSidebar?.dispose()
    unregisterDashboardPage()
    unregisterDashboardLoopPage()
    dashboardStore.dispose()
    detachSessionFollower()
    detachConnected()
    disposeSessionChange()
    eventController.abort()
  }
}
