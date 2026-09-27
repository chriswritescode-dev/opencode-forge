/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { existsSync } from 'fs'
import { For, Show, createEffect, createMemo, createRoot, createSignal, onCleanup, type Accessor } from 'solid-js'
import { createDashboardLauncher } from '../dashboard/launch'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { DEFAULT_SANDBOX_IMAGE, formatTemplateBuildCommands } from '../sandbox/template'
import { loadPluginConfig, resolveBundledContainerDir } from '../setup'
import { resolveForgeDbPath } from '../storage'
import {
  FORGE_RPC,
  readForgeAutoApproveChangedEvent,
  readForgeAutoApproveState,
  readForgeHostSandboxChangedEvent,
  readForgeHostSandboxSetOutput,
  readForgeHostSandboxState,
  readForgeLoopSidebar,
  readForgeLoopsChangedEvent,
  readForgeVersion,
  readForgeWorktrees,
  type ForgeToastEvent,
  type ForgeWorktreesOutput,
} from '../host/forge-rpc'
import { FORGE_DASHBOARD_COMMAND, formatForgeTitle, resolveTuiOptions } from './options'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import { isToastVariant } from '../utils/toast'
import { isWithinDir } from '../workspace/forge-naming'
import type { ForgeProjectClient } from './project-client'
import { createExecutionContextCache, type ExecutionContextCache } from '../utils/tui-execution-context-cache'
import { createV2TuiHost } from './host'
import { createForgePlanCommands } from './plan-commands'
import { openSandboxBuildDialog } from './sandbox-build-dialog'
import { attachV2LoopSessionFollower } from './session-follow'
import { readForgeSessionDelete, removeOrphanedLoopSessions, removeSessionBestEffort, type ForgeWorktreeList } from './loop-session-cleanup'
import { createForgeRpcCaller, createV2ForgeProjectClient } from './v2-client'
import { createHostSandboxToggle } from './host-sandbox'
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

function ForgeLoopsSidebar(props: {
  context: Plugin.Context
  showVersion: boolean
  sandboxPreference: Accessor<SessionSandboxPreference | null>
  autoApprove: Accessor<boolean>
  currentSessionId: () => string | null
  loops: Accessor<LoopSidebarRow[]>
}) {
  const theme = () => props.context.theme
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
          {(loop) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={statusColor(loop.status)}>•</text>
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
          )}
        </For>
      </Show>
    </box>
  )
}

/**
 * V2 TUI surface: the dashboard, execute-plan, restart-loop, and sandbox-build
 * commands, loop session auto-follow, a loop sidebar, and the missing-build-context
 * toast. Returns the cleanup for all of them.
 */
export function setupForgeTuiV2(context: Plugin.Context): () => void {
  const pluginConfig = loadPluginConfig()
  const opts = resolveTuiOptions(pluginConfig.tui, context.options)
  const forgeDbPath = resolveForgeDbPath(pluginConfig.dataDir)

  const buildContextDir = resolveBundledContainerDir()
  if (isSandboxConfigEnabled(pluginConfig) && !existsSync(buildContextDir)) {
    context.ui.toast.show({
      title: 'Sandbox build context missing',
      message: `Sandboxing is enabled but the bundled build context is missing at ${buildContextDir}. Reinstall opencode-forge, then build the template: ${formatTemplateBuildCommands(buildContextDir, pluginConfig.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE)}`,
      variant: 'warning',
      duration: 10_000,
    })
  }

  const dashboard = createDashboardLauncher({
    dbPath: forgeDbPath,
    config: pluginConfig,
    toast: (input) => context.ui.toast.show(input),
  })

  const lifecycle = new AbortController()
  let defaultModel = ''
  const host = createV2TuiHost(context, () => defaultModel)
  let projectClient: ForgeProjectClient | null = null
  let executionContextCache: ExecutionContextCache | null = null

  const ensureClient = async (): Promise<ForgeProjectClient | null> => {
    if (projectClient) return projectClient
    const directory = resolveV2TuiDirectory(context)
    const projectId = await resolveV2TuiProjectId(context)
    if (lifecycle.signal.aborted) return null
    if (!directory || !projectId) {
      host.toast({ message: 'Forge could not resolve the current project', variant: 'warning', duration: 5000 })
      return null
    }
    const created = createV2ForgeProjectClient(context, {
      projectId,
      directory,
      onDefaultModel: (model) => { defaultModel = model },
    })
    projectClient ??= created
    executionContextCache ??= createExecutionContextCache(projectId, pluginConfig, () => created.loadExecutionContext())
    return projectClient
  }

  const currentSessionId = (): string | null => {
    const route = context.ui.router.current()
    return route.type === 'session' ? route.sessionID : null
  }

  const call = createForgeRpcCaller(context, () => resolveV2TuiDirectory(context))

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
    cache: () => executionContextCache,
  })

  const hostSandbox = createHostSandboxToggle({
    readState: () => call((rpc, location) => rpc.hostSandboxState({}, location), readForgeHostSandboxState),
    setState: (sessionId, enabled) => call(
      (rpc, location) => rpc.hostSandboxSet({ sessionId, enabled }, location),
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
            run: () => dashboard.open(),
          },
          {
            id: 'forge.plan.execute',
            title: 'Execute plan',
            description: 'Open the execution dialog for the current session plan, or paste one if none is found',
            group: 'Forge',
            palette: true,
            ...(opts.keybinds.executePlan ? { bind: opts.keybinds.executePlan } : {}),
            run: () => { void planCommands.executePlan() },
          },
          {
            id: 'forge.plan.executePasted',
            title: 'Execute pasted plan',
            description: 'Paste a marked or unmarked plan and open the execution dialog',
            group: 'Forge',
            palette: true,
            run: () => { void planCommands.executePastedPlan() },
          },
          {
            id: 'forge.loop.restart',
            title: 'Restart loop',
            description: 'Change the execution and auditor models and restart a running or stopped loop from persisted progress',
            group: 'Forge',
            palette: true,
            run: () => { void planCommands.restartLoop() },
          },
          {
            id: 'forge.sandbox.toggleHost',
            title: 'Toggle host sandbox',
            description: 'Run this session\'s agent shell, glob, and grep calls in the sandbox, or back on the host',
            group: 'Forge',
            palette: true,
            ...(opts.keybinds.toggleHostSandbox ? { bind: opts.keybinds.toggleHostSandbox } : {}),
            run: () => { void hostSandbox.toggle() },
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
  let eventProjectId: Promise<string | null> | null = null

  const withProjectId = (handler: (projectId: string) => void): void => {
    eventProjectId ??= resolveV2TuiProjectId(context)
    void eventProjectId.then((projectId) => {
      if (eventController.signal.aborted || !projectId) return
      handler(projectId)
    })
  }

  try {
    if (typeof context.client.rpc !== 'function') {
      throw new Error('context.client.rpc is unavailable')
    }
    const rpcEvents = context.client.rpc(FORGE_RPC).events
    rpcEvents.on('toast', (event) => {
      const toast = readForgeToast(event.data)
      if (!toast) return
      withProjectId((projectId) => {
        if (toast.projectId !== projectId) return
        context.ui.toast.show({
          title: toast.title,
          message: toast.message,
          variant: toast.variant,
          duration: toast.duration,
        })
      })
    }, { signal: eventController.signal })
    rpcEvents.on('sessionDelete', (event) => {
      const sessionID = readForgeSessionDelete(event.data)
      if (sessionID) void removeSessionBestEffort(context, sessionID)
    }, { signal: eventController.signal })
    rpcEvents.on('loopsChanged', (event) => {
      const changed = readForgeLoopsChangedEvent(event.data)
      if (!changed) return
      withProjectId((projectId) => {
        if (changed.projectId !== projectId) return
        loopSidebar?.refresh()
        hostSandbox.refresh()
      })
    }, { signal: eventController.signal })
    rpcEvents.on('autoApproveChanged', (event) => {
      const changed = readForgeAutoApproveChangedEvent(event.data)
      if (!changed) return
      withProjectId((projectId) => {
        if (changed.projectId !== projectId) return
        autoApprove.refresh()
      })
    }, { signal: eventController.signal })
    rpcEvents.on('hostSandboxChanged', (event) => {
      const changed = readForgeHostSandboxChangedEvent(event.data)
      if (!changed) return
      withProjectId((projectId) => {
        if (changed.projectId !== projectId) return
        hostSandbox.refresh()
      })
    }, { signal: eventController.signal })
  } catch (err) {
    console.error('[forge] failed to subscribe to Forge RPC events', err)
  }

  const detachConnected = context.data.on('server.connected', () => {
    loopSidebar?.refresh()
    autoApprove.refresh()
    hostSandbox.refresh()
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
    detachSessionFollower()
    detachConnected()
    disposeSessionChange()
    eventController.abort()
    dashboard.dispose()
  }
}
