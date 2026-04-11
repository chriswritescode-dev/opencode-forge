import type { DockerService } from './docker'
import type { PluginConfig } from '../types'

export interface SandboxContext {
  docker: DockerService
  containerName: string
  hostDir: string
}

interface SandboxDeps {
  sandboxManager: { docker: DockerService; getActive(name: string): { containerName: string; projectDir: string } | null } | null
  loopService: { resolveWorktreeName(sessionId: string): string | null; getActiveState(name: string): { active: boolean; sandbox?: boolean } | null }
}

export function getSandboxForSession(deps: SandboxDeps, sessionId: string): SandboxContext | null {
  if (!deps.sandboxManager) return null
  const worktreeName = deps.loopService.resolveWorktreeName(sessionId)
  if (!worktreeName) return null
  const state = deps.loopService.getActiveState(worktreeName)
  if (!state?.active || !state.sandbox) return null
  const active = deps.sandboxManager.getActive(worktreeName)
  if (!active) return null
  return { docker: deps.sandboxManager.docker, containerName: active.containerName, hostDir: active.projectDir }
}

export function isSandboxEnabled(config: PluginConfig, sandboxManager: unknown): boolean {
  return config.sandbox?.mode === 'docker' && !!sandboxManager
}
