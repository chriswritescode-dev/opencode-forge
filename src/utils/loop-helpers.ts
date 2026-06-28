import type { PluginConfig, Logger } from '../types'
import type { LoopService, LoopState } from '../loop'
import { parseModelString } from './model-fallback'

type ModelRef = { providerID: string; modelID: string }
type LoopModelRole = 'code' | 'auditor'

interface LoopModelSelection {
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

function resolveLoopModelSelection(
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

// Re-exported from the dependency-free duration module so existing importers
// keep their import path while the browser bundle can import the pure source.
export { formatDuration, computeElapsedSeconds } from './duration'
