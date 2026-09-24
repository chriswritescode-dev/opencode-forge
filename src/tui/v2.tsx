/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { existsSync } from 'fs'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { createDashboardLauncher } from '../dashboard/launch'
import { isSandboxConfigEnabled } from '../sandbox/context'
import { DEFAULT_SANDBOX_IMAGE, formatTemplateBuildCommands } from '../sandbox/template'
import { loadPluginConfig, resolveBundledContainerDir } from '../setup'
import { resolveForgeDbPath } from '../storage'
import { FORGE_RPC, type ForgeToastEvent } from '../host/forge-rpc'
import { FORGE_DASHBOARD_COMMAND, formatForgeTitle, resolveTuiOptions } from './options'
import {
  openLoopSidebarReader,
  SIDEBAR_RECENT_TERMINAL_LIMIT,
  type LoopSidebarReader,
} from '../utils/tui-loop-store'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import { isToastVariant } from '../utils/toast'
import { resolveForgeDataDir } from '../utils/opencode-paths'
import { isForgeWorktreeDir } from '../workspace/forge-naming'
import type { ForgeProjectClient } from '../utils/tui-client'
import { createExecutionContextCache, type ExecutionContextCache } from '../utils/tui-execution-context-cache'
import { createV2TuiHost } from './host'
import { createForgePlanCommands } from './plan-commands'
import { openSandboxBuildDialog } from './sandbox-build-dialog'
import { attachV2LoopSessionFollower } from './session-follow'
import { createV2ForgeProjectClient } from './v2-client'

/** Sidebar refresh cadence; loop rows are cheap local reads. */
const LOOP_REFRESH_INTERVAL_MS = 2000

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

function ForgeLoopsSidebar(props: { context: Plugin.Context; dbPath: string; showVersion: boolean }) {
  const [loops, setLoops] = createSignal<LoopSidebarRow[]>([])
  let projectId: string | null = null
  let disposed = false
  let reader: LoopSidebarReader | null = null
  let signature = ''

  const load = async () => {
    projectId ??= await resolveV2TuiProjectId(props.context)
    if (disposed || !projectId) return
    reader ??= openLoopSidebarReader(projectId, props.dbPath, SIDEBAR_RECENT_TERMINAL_LIMIT)
    const next = reader.read()
    const nextSignature = next
      .map((loop) => `${loop.loopName}|${loop.status}|${loop.iteration}|${loop.maxIterations}`)
      .join('\n')
    if (!disposed && nextSignature !== signature) {
      signature = nextSignature
      setLoops(next)
    }
  }

  createEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, LOOP_REFRESH_INTERVAL_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      reader?.close()
      reader = null
    })
  })

  const theme = () => props.context.theme

  return (
    <box flexDirection="column">
      <text fg={theme().text.base}>
        <b>{formatForgeTitle(props.showVersion)}</b>
      </text>
      <Show when={loops().length > 0} fallback={<text fg={theme().text.muted}>No loops</text>}>
        <For each={loops()}>
          {(loop) => (
            <text fg={loop.status === 'running' ? theme().text.base : theme().text.muted}>
              {`${loop.loopName} · ${loop.status} · ${loop.iteration}/${loop.maxIterations}`}
            </text>
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
      dbPath: forgeDbPath,
      signal: lifecycle.signal,
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

  const planCommands = createForgePlanCommands({
    host,
    pluginConfig,
    dbPath: forgeDbPath,
    projectDirectory: resolveV2TuiDirectory(context) ?? undefined,
    currentSessionId,
    ensureClient,
    cache: () => executionContextCache,
  })

  const dataDir = resolveForgeDataDir(pluginConfig.dataDir)
  const detachSessionFollower = attachV2LoopSessionFollower(context, (directory) => isForgeWorktreeDir(dataDir, directory))

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

  if (opts.sidebar) {
    context.ui.slot({
      append: 'sidebar.content',
      render: () => (
        <ForgeLoopsSidebar context={context} dbPath={forgeDbPath} showVersion={opts.showVersion} />
      ),
    })
  }

  const toastController = new AbortController()
  let toastProjectId: Promise<string | null> | null = null

  try {
    if (typeof context.client.rpc !== 'function') {
      throw new Error('context.client.rpc is unavailable')
    }
    context.client.rpc(FORGE_RPC).events.on('toast', (event) => {
      const toast = readForgeToast(event.data)
      if (!toast) return
      toastProjectId ??= resolveV2TuiProjectId(context)
      void toastProjectId.then((projectId) => {
        if (toastController.signal.aborted || !projectId || toast.projectId !== projectId) return
        context.ui.toast.show({
          title: toast.title,
          message: toast.message,
          variant: toast.variant,
          duration: toast.duration,
        })
      })
    }, { signal: toastController.signal })
  } catch (err) {
    console.error('[forge] failed to subscribe to toast RPC', err)
  }

  return () => {
    lifecycle.abort()
    detachSessionFollower()
    toastController.abort()
    dashboard.dispose()
  }
}
