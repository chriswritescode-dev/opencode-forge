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

export function isSandboxEnabled(_config: PluginConfig, sandboxManager: unknown): boolean {
  return !!sandboxManager
}
