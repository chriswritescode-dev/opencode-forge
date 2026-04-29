import type { PluginConfig, Logger } from '../types'
import type { LoopService, LoopState } from '../services/loop'
import { parseModelString } from './model-fallback'

type ModelRef = { providerID: string; modelID: string }
type LoopModelRole = 'code' | 'auditor'

export interface LoopModelSelection {
  model: ModelRef | undefined
  source: string
}

function firstParsedModel(candidates: Array<[string, string | undefined]>): LoopModelSelection {
  for (const [source, value] of candidates) {
    const model = parseModelString(value)
    if (model) return { model, source: `${source}=${value}` }
  }
  return { model: undefined, source: 'default/session model' }
}

export function resolveLoopModelSelection(
  config: PluginConfig,
  state: LoopState | null | undefined,
  role: LoopModelRole,
): LoopModelSelection {
  if (state?.modelFailed) {
    return { model: undefined, source: 'default/session model (configured model previously failed)' }
  }

  let candidates: Array<[string, string | undefined]>

  switch (role) {
    case 'auditor':
      candidates = [
        ['state.auditorModel', state?.auditorModel],
        ['state.executionModel', state?.executionModel],
        ['config.executionModel', config.executionModel],
      ]
      break
    case 'code':
      candidates = [
        ['state.executionModel', state?.executionModel],
        ['config.executionModel', config.executionModel],
      ]
      break
  }

  return firstParsedModel(candidates)
}

export function resolveLoopModel(
  config: PluginConfig,
  loopService: LoopService,
  loopName: string,
): { providerID: string; modelID: string } | undefined {
  const state = loopService.getActiveState(loopName)
  return resolveLoopModelSelection(config, state, 'code').model
}

export function resolveLoopAuditorModel(
  config: PluginConfig,
  loopService: LoopService,
  loopName: string,
  logger?: Logger,
): { providerID: string; modelID: string } | undefined {
  const state = loopService.getActiveState(loopName)
  const selection = resolveLoopModelSelection(config, state, 'auditor')

  if (logger) {
    logger.log(`resolveLoopAuditorModel(${loopName}): resolved from ${selection.source} → ${selection.model ? `${selection.model.providerID}/${selection.model.modelID}` : 'undefined (session model)'}`)
  }
  return selection.model
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
