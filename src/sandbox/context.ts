import type { DockerService } from './docker'
import type { PluginConfig } from '../types'

export interface SandboxContext {
  docker: DockerService
  containerName: string
  hostDir: string
}

export function isSandboxEnabled(config: PluginConfig, sandboxManager: unknown): boolean {
  return config.sandbox?.mode === 'docker' && !!sandboxManager
}
