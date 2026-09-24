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
 * Minimal V2 TUI surface: the dashboard command, a loop sidebar, and the
 * missing-build-context toast. Returns the dashboard server cleanup.
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
    toastController.abort()
    dashboard.dispose()
  }
}
