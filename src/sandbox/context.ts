import type { SandboxRuntime } from './msb'
import type { PluginConfig } from '../types'
import type { SandboxMount } from './path'

export interface SandboxContext {
  runtime: SandboxRuntime
  containerName: string
  hostDir: string
  mounts: SandboxMount[]
}

/**
 * Sandbox context note injected into the system prompt of every session whose tool calls are
 * routed into a container — sandbox loops, their Task-tool subagents, and sessions with the host
 * sandbox toggled on. Lives here, next to `SandboxContext`, because it describes the container
 * routing itself rather than anything loop-specific, and because subagents never see a loop
 * prompt body. Single source of truth.
 */
export const SANDBOX_CONTEXT_NOTE = [
  '[Sandbox] This session runs inside a container: bash tool commands execute in that container, not on the host. OS-specific commands or tools may differ from the host system.',
  'Focus on what the code does, not whether local tooling matches — this saves time and avoids false positives.',
  'Run long commands in the foreground with a raised bash timeout: if the sandbox stops while idle it reboots the VM, so backgrounded work (&, nohup, setsid) and in-memory state are not guaranteed to survive, though files on disk do.',
  'Passwordless sudo is available for installing missing tools system-wide.',
  'Docker is available inside the sandbox: run forge-dockerd-start to ensure the daemon is running (idempotent, safe to run any time).',
].join('\n')

export interface SandboxLoopContextState {
  loopName: string
  active: boolean
  sandbox?: boolean
  worktreeDir?: string
}

export interface SandboxContextManager {
  runtime: SandboxRuntime
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  getActive(worktreeName: string): { containerName: string; projectDir: string; mounts: SandboxMount[] } | null
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
  return {
    runtime: sandboxManager.runtime,
    containerName: active.containerName,
    hostDir: active.projectDir,
    mounts: active.mounts ?? [{ hostDir: active.projectDir, containerDir: active.projectDir }],
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
 * - a sandbox manager was constructed (msb mode active).
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
