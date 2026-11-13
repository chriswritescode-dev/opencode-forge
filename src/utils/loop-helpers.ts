import { z } from 'zod'
import type { PluginConfig, Logger } from '../types'
import type { LoopService, LoopState } from '../loop'
import { parseModelString } from './model-fallback'

const fallbackModelRefSchema = z.looseObject({
  model: z.string(),
  variant: z.string().optional(),
})

type ModelRef = { providerID: string; modelID: string }
type LoopModelRole = 'code' | 'auditor'

interface LoopModelSelection {
  model: ModelRef | undefined
  source: string
}

export interface AuditorModelChoice {
  model: ModelRef | undefined
  variant: string | undefined
  source: string
}

export function buildAuditorModelChain(
  config: PluginConfig,
  state: LoopState | null | undefined,
): AuditorModelChoice[] {
  const selection = resolveLoopModelSelection(config, state, 'auditor')
  const chain: AuditorModelChoice[] = [{
    model: selection.model,
    variant: state?.auditorVariant,
    source: selection.source,
  }]

  const seen = new Set<string>()
  if (selection.model) {
    seen.add(`${selection.model.providerID}/${selection.model.modelID}`)
  }

  const fallbacks = config.auditorFallbackModels ?? []
  for (let i = 0; i < fallbacks.length; i++) {
    const entry = fallbacks[i]
    const asString = z.string().safeParse(entry)
    const asModel = fallbackModelRefSchema.safeParse(entry)
    const raw = asString.success ? asString.data : asModel.success ? asModel.data.model : undefined
    const variant = asModel.success ? asModel.data.variant || undefined : undefined
    const model = parseModelString(raw)
    if (!model) continue
    const key = `${model.providerID}/${model.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    chain.push({
      model,
      variant,
      source: `config.auditorFallbackModels[${i}]=${raw}${variant ? ` variant=${variant}` : ''}`,
    })
  }

  return chain
}

export function auditorModelChoiceAt(chain: AuditorModelChoice[], index: number): AuditorModelChoice {
  return chain[Math.min(Math.max(index, 0), chain.length - 1)]
}

export function nextAuditorFallbackIndex(chain: AuditorModelChoice[], index: number): number | null {
  return index + 1 < chain.length ? index + 1 : null
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

export function resolveLoopAuditorChoice(
  config: PluginConfig,
  loopService: LoopService,
  loopName: string,
  logger?: Logger,
): AuditorModelChoice {
  const state = loopService.getActiveState(loopName)
  const chain = buildAuditorModelChain(config, state)
  const index = state?.auditorFallbackIndex ?? 0
  const choice = auditorModelChoiceAt(chain, index)

  if (logger) {
    logger.log(`resolveLoopAuditorChoice(${loopName}): index=${index}/${chain.length - 1} from ${choice.source} → ${choice.model ? `${choice.model.providerID}/${choice.model.modelID}` : 'undefined (session model)'}`)
  }
  return choice
}

export function isAuditorPhase(phase: LoopState['phase'] | undefined): boolean {
  return phase === 'auditing'
}

export function usageRoleForPhase(phase: LoopState['phase'] | undefined): 'code' | 'auditor' {
  return isAuditorPhase(phase) ? 'auditor' : 'code'
}

export function standbyPhaseFor(phase: LoopState['phase']): LoopState['phase'] {
  return phase === 'auditing' ? 'coding' : 'auditing'
}

export function resolveUsageFallbackModelLabel(
  config: PluginConfig,
  state: LoopState,
  phase: LoopState['phase'],
): string | undefined {
  if (isAuditorPhase(phase)) {
    const choice = auditorModelChoiceAt(buildAuditorModelChain(config, state), state.auditorFallbackIndex ?? 0)
    if (choice.model) {
      return `${choice.model.providerID}/${choice.model.modelID}`
    }
    return state.auditorModel ?? state.executionModel ?? config.auditorModel ?? config.executionModel
  }
  return state.executionModel ?? config.executionModel
}

export { formatDuration, computeElapsedSeconds } from './duration'
