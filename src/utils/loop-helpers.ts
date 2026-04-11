import type { PluginConfig } from '../types'
import type { LoopService } from '../services/loop'
import { parseModelString } from './model-fallback'

export function resolveLoopModel(
  config: PluginConfig,
  loopService: LoopService,
  worktreeName: string,
): { providerID: string; modelID: string } | undefined {
  const state = loopService.getActiveState(worktreeName)
  if (state?.modelFailed) return undefined
  return parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`
}

export function computeElapsedSeconds(startedAt?: string, endedAt?: string): number {
  if (!startedAt) return 0
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  return Math.round((end - start) / 1000)
}
