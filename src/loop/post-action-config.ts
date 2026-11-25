import type { PluginConfig } from '../types'
import type { LoopState } from './state'
import { resolveLoopPostActionAgent } from '../utils/loop-helpers'

export interface ResolvedPostActionConfig {
  enabled: boolean
  skill?: string
  prompt?: string
  model?: string
  variant?: string
  agent: string
}

export function resolvePostActionConfig(
  config: PluginConfig,
  state?: Pick<LoopState, 'postActionAgent' | 'postActionModel' | 'postActionVariant'> | null,
): ResolvedPostActionConfig {
  const pa = config.loop?.postAction
  const enabled = pa?.enabled === true && (!!pa?.skill || !!pa?.prompt)
  const agent = resolveLoopPostActionAgent(config, state)

  const stateModel = state?.postActionModel?.trim() || undefined
  const configModel = pa?.model?.trim() || undefined
  const stateVariant = state?.postActionVariant?.trim() || undefined
  const configVariant = pa?.variant?.trim() || undefined

  if (stateModel) {
    return { enabled, skill: pa?.skill, prompt: pa?.prompt, model: stateModel, variant: stateVariant, agent }
  }
  if (configModel) {
    const variant = state?.postActionVariant !== undefined ? stateVariant : configVariant
    return { enabled, skill: pa?.skill, prompt: pa?.prompt, model: configModel, variant, agent }
  }
  return { enabled, skill: pa?.skill, prompt: pa?.prompt, model: undefined, variant: undefined, agent }
}
