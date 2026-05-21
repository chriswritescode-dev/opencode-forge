import type { DockerService } from './docker'
import type { PluginConfig } from '../types'

export interface SandboxContext {
  docker: DockerService
  containerName: string
  hostDir: string
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
  getActive(worktreeName: string): { containerName: string; projectDir: string } | null
}

export async function resolveSandboxContextForLoop(
  sandboxManager: SandboxContextManager | null | undefined,
  state: SandboxLoopContextState | null | undefined,
  logger?: Pick<Console, 'log'>,
  opts?: { throwOnRestoreError?: boolean },
): Promise<SandboxContext | null> {
  if (!state?.active || !state.sandbox || !sandboxManager) return null

  let active = sandboxManager.getActive(state.loopName)
  if (!active && state.worktreeDir) {
    try {
      await sandboxManager.restore(state.loopName, state.worktreeDir, new Date().toISOString())
      active = sandboxManager.getActive(state.loopName)
    } catch (err) {
      logger?.log(`[sandbox] restore failed for loop=${state.loopName}: ${err instanceof Error ? err.message : String(err)}`)
      if (opts?.throwOnRestoreError) throw err
      return null
    }
  }

  if (!active) return null
  return { docker: sandboxManager.docker, containerName: active.containerName, hostDir: active.projectDir }
}

export function isSandboxEnabled(_config: PluginConfig, sandboxManager: unknown): boolean {
  return !!sandboxManager
}
