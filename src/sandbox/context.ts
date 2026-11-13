import { SANDBOX_CACHE_DIR, type SandboxRuntime } from './msb'
import type { PluginConfig, SandboxMountConfig } from '../types'
import type { SandboxMount } from './path'
import type { ActiveSandbox, SandboxManager } from './manager'
import type { SandboxRuntimeSettings } from './loop-settings'
import { resolveLoopAllowedDirectories } from '../constants/loop'

export interface SandboxContext {
  runtime: SandboxRuntime
  containerName: string
  hostDir: string
  mounts: SandboxMount[]
  instanceId?: string
  settings?: SandboxRuntimeSettings
}

export function sandboxContextFromActive(runtime: SandboxRuntime, active: ActiveSandbox): SandboxContext {
  const context: SandboxContext = {
    runtime,
    containerName: active.containerName,
    hostDir: active.projectDir,
    mounts: active.mounts ?? [{ hostDir: active.projectDir, containerDir: active.projectDir }],
    instanceId: active.instanceId,
  }
  if (active.settings) context.settings = active.settings
  return context
}

const SHARED_WORKSPACE_ARTIFACTS_NOTE = 'The project directory is shared between the host and the container, so dependency directories and native build output created in the other environment (for example node_modules, .venv, virtualenvs, compiled extensions, and build/target directories) may be built for the wrong OS or architecture: delete them and reinstall or rebuild here rather than only rerunning an install that may report them as up to date.'

export const SANDBOX_CONTEXT_NOTE = [
  '[Sandbox] This session runs inside a container: bash tool commands execute in that container, not on the host. OS-specific commands or tools may differ from the host system.',
  'Environment-specific tooling that is missing or incompatible is not acceptable: install or reinstall the required tooling and dependencies in the container, rerun the intended checks, and do not misreport environment-induced failures as code defects.',
  SHARED_WORKSPACE_ARTIFACTS_NOTE,
  'Passwordless sudo is available for installing missing tools system-wide.',
  'Docker is available inside the sandbox: run forge-dockerd-start to ensure the daemon is running (idempotent, safe to run any time).',
  `Package and tool caches live on a dedicated disk mounted at ${SANDBOX_CACHE_DIR}; run forge-cache-prune to reclaim space when the disk fills (it clears caches while preserving installed toolchains).`,
  'Chromium (Playwright\'s browser build) is installed as chromium for headless browser automation; launch it with chromium --headless --no-sandbox --disable-dev-shm-usage.',
].join('\n')

export const SANDBOX_OFF_NOTE = [
  '[Sandbox] Execution has returned to the host environment. Container tools, packages, processes, and in-memory state must not be assumed to be available here.',
  'Earlier command output in this session may come from the container and does not describe the host.',
  'Install or reinstall the required host tooling and dependencies before rerunning any checks.',
  SHARED_WORKSPACE_ARTIFACTS_NOTE,
].join('\n')

export interface SandboxEnvironmentTransition {
  from?: string | null
  to?: string | null
}

function formatTransitionLine(
  transition: SandboxEnvironmentTransition | undefined,
  fromLabel: string,
  toLabel: string,
): string | null {
  const from = transition?.from?.trim()
  const to = transition?.to?.trim()
  if (!from && !to) return null
  return `[Sandbox] Environment changed: ${from ? `${fromLabel} (${from})` : `${fromLabel} (unknown)`} -> ${to ? `${toLabel} (${to})` : `${toLabel} (unknown)`}.`
}

export type SandboxChange = 'restarted' | 'recreated'

const SANDBOX_CHANGE_NOTES = {
  restarted: '[Sandbox] The sandbox was restarted to apply new resource settings. Its files and disks are unchanged, but processes started earlier (including the Docker daemon and any containers) are no longer running; restart the ones you still need.',
  recreated: '[Sandbox] The sandbox was recreated. Anything outside the mounted directories from before is gone, including installed packages, Docker data, and caches, and processes started earlier are no longer running; reinstall and restart what you still need.',
} satisfies Record<SandboxChange, string>

function formatMemory(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`
}

export function formatSandboxSettingsLine(settings: SandboxRuntimeSettings): string {
  const cpus = `${settings.cpus} CPU${settings.cpus === 1 ? '' : 's'}`
  const lan = settings.allowLan ? 'allowed' : 'blocked'
  return `[Sandbox] Resources: ${cpus}, ${formatMemory(settings.memoryMib)} memory. LAN (private network) access: ${lan}.`
}

export function detectSandboxChange(previous: SandboxContext | undefined, next: SandboxContext): SandboxChange | undefined {
  if (!previous || previous.containerName !== next.containerName) return undefined
  if (previous.instanceId && next.instanceId && previous.instanceId !== next.instanceId) return 'recreated'
  const before = previous.settings
  const after = next.settings
  if (before && after && (before.cpus !== after.cpus || before.memoryMib !== after.memoryMib)) return 'restarted'
  return undefined
}

export function buildSandboxContextNote(
  transition?: SandboxEnvironmentTransition,
  sandbox?: { settings?: SandboxRuntimeSettings; change?: SandboxChange },
): string {
  const lines = [
    formatTransitionLine(transition, 'host', 'container'),
    sandbox?.change ? SANDBOX_CHANGE_NOTES[sandbox.change] : null,
    sandbox?.settings ? formatSandboxSettingsLine(sandbox.settings) : null,
    SANDBOX_CONTEXT_NOTE,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

export function buildSandboxOffNote(transition?: SandboxEnvironmentTransition): string {
  const line = formatTransitionLine(transition, 'container', 'host')
  return line ? `${line}\n${SANDBOX_OFF_NOTE}` : SANDBOX_OFF_NOTE
}

export interface SandboxLoopContextState {
  loopName: string
  active: boolean
  sandbox?: boolean
  worktreeDir?: string
}

export interface SandboxContextManager {
  runtime: SandboxRuntime
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
}

export async function resolveSandboxContextForLoop(
  sandboxManager: SandboxContextManager | null | undefined,
  state: SandboxLoopContextState | null | undefined,
  logger?: Pick<Console, 'log' | 'error'>,
  opts?: { throwOnRestoreError?: boolean },
): Promise<SandboxContext | null> {
  if (!state?.active || !state.sandbox || !sandboxManager) return null

  if (state.worktreeDir) {
    try {
      await sandboxManager.ensureRunning(state.loopName, state.worktreeDir)
    } catch (err) {
      logger?.error(`[sandbox] ensureRunning failed for loop=${state.loopName}: ${err instanceof Error ? err.message : String(err)}`)
      if (opts?.throwOnRestoreError) throw err
      return null
    }
  }

  const active = sandboxManager.getActive(state.loopName)
  if (!active) return null
  return sandboxContextFromActive(sandboxManager.runtime, active)
}

export function isSandboxConfigEnabled(config: PluginConfig | undefined): boolean {
  return config?.sandbox?.enabled !== false
}

export function resolveSandboxMountConfigs(config: PluginConfig | undefined): SandboxMountConfig[] {
  return [
    ...(config?.sandbox?.mounts ?? []),
    ...resolveLoopAllowedDirectories(config).map((host) => ({ host, readonly: true })),
  ]
}

export function isSandboxEnabled(config: PluginConfig | undefined, sandboxManager: SandboxManager | null | undefined): boolean {
  if (!isSandboxConfigEnabled(config)) return false
  return !!sandboxManager
}
