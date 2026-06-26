import type { DockerService } from './docker'
import type { PluginConfig } from '../types'
import type { SandboxMount } from './path'

export interface SandboxContext {
  docker: DockerService
  containerName: string
  hostDir: string
  mounts: SandboxMount[]
}

export interface SandboxLoopContextState {
  loopName: string
  active: boolean
  sandbox?: boolean
  worktreeDir?: string
}

export interface SandboxContextManager {
  docker: DockerService
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  getActive(worktreeName: string): { containerName: string; projectDir: string; mounts: SandboxMount[] } | null
  ensureRunning(worktreeName: string, projectDir: string, startedAt?: string): Promise<string>
}

export async function resolveSandboxContextForLoop(
  sandboxManager: SandboxContextManager | null | undefined,
  state: SandboxLoopContextState | null | undefined,
  logger?: Pick<Console, 'log'>,
  opts?: { throwOnRestoreError?: boolean },
): Promise<SandboxContext | null> {
  if (!state?.active || !state.sandbox || !sandboxManager) return null

  if (state.worktreeDir) {
    try {
      await sandboxManager.ensureRunning(state.loopName, state.worktreeDir)
    } catch (err) {
      logger?.log(`[sandbox] ensureRunning failed for loop=${state.loopName}: ${err instanceof Error ? err.message : String(err)}`)
      if (opts?.throwOnRestoreError) throw err
      return null
    }
  }

  const active = sandboxManager.getActive(state.loopName)
  if (!active) return null
  return {
    docker: sandboxManager.docker,
    containerName: active.containerName,
    hostDir: active.projectDir,
    mounts: active.mounts ?? [{ hostDir: active.projectDir, containerDir: '/workspace' }],
  }
}

/**
 * Whether the sandbox is enabled by configuration alone (the user has not opted out via
 * `sandbox.enabled: false`). This is the gate that decides whether the server constructs a
 * sandbox manager, and is also the only signal the TUI can evaluate (it has no manager), so
 * both sides share it to bake the correct bash/sh permission routing for new loop sessions.
 */
export function isSandboxConfigEnabled(config: PluginConfig | undefined): boolean {
  return config?.sandbox?.enabled !== false
}

/**
 * Determines whether sandboxed execution is in effect.
 *
 * A sandbox is only usable when BOTH conditions hold:
 * - the user has not opted out via `sandbox.enabled: false`, and
 * - a sandbox manager was constructed (Docker mode active).
 *
 * Honoring the config here (not just the manager's existence) keeps this the single
 * source of truth for the bash/sh permission routing: when the sandbox is off, loops
 * run worktree-only and host `bash` stays allowed rather than being denied in favor of
 * an `sh` tool that has no container to run in.
 */
export function isSandboxEnabled(config: PluginConfig | undefined, sandboxManager: unknown): boolean {
  if (!isSandboxConfigEnabled(config)) return false
  return !!sandboxManager
}
