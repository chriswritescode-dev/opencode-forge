import type { PluginConfig, Logger } from '../types'
import type { LoopService } from '../services/loop'
import { parseModelString } from './model-fallback'

export function resolveLoopModel(
  config: PluginConfig,
  loopService: LoopService,
  loopName: string,
): { providerID: string; modelID: string } | undefined {
  const state = loopService.getActiveState(loopName)
  if (state?.modelFailed) return undefined
  const hasExplicit = state?.executionModel !== undefined && state?.executionModel !== null
  if (hasExplicit) return parseModelString(state!.executionModel)
  return parseModelString(config.loop?.model)
    ?? parseModelString(config.executionModel)
}

export function resolveLoopAuditorModel(
  config: PluginConfig,
  loopService: LoopService,
  loopName: string,
  logger?: Logger,
): { providerID: string; modelID: string } | undefined {
  const state = loopService.getActiveState(loopName)

  // If auditorModel was explicitly set on the loop state (even as ''),
  // the user made a deliberate choice — don't fall through to config.
  // undefined means "not set" (e.g., loop launched via tool without override).
  const hasExplicitAuditor = state?.auditorModel !== undefined && state?.auditorModel !== null
  const resolved = hasExplicitAuditor
    ? parseModelString(state!.auditorModel)
    : parseModelString(config.auditorModel)
      ?? parseModelString(state?.executionModel)
      ?? parseModelString(config.loop?.model)
      ?? parseModelString(config.executionModel)

  if (logger) {
    const source = hasExplicitAuditor
      ? (parseModelString(state!.auditorModel) ? `state.auditorModel=${state!.auditorModel}` : 'state.auditorModel=(default/session model)')
      : parseModelString(config.auditorModel) ? `config.auditorModel=${config.auditorModel}`
      : parseModelString(state?.executionModel) ? `state.executionModel=${state?.executionModel}`
      : parseModelString(config.loop?.model) ? `config.loop.model=${config.loop?.model}`
      : parseModelString(config.executionModel) ? `config.executionModel=${config.executionModel}`
      : 'none'
    logger.log(`resolveLoopAuditorModel(${loopName}): resolved from ${source} → ${resolved ? `${resolved.providerID}/${resolved.modelID}` : 'undefined (session model)'}`)
  }
  return resolved
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
