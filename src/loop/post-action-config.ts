import type { PluginConfig } from '../types'

export interface ResolvedPostActionConfig {
  enabled: boolean
  skill?: string
  prompt?: string
  model?: string
}

export function resolvePostActionConfig(config: PluginConfig): ResolvedPostActionConfig {
  const pa = config.loop?.postAction
  const enabled = pa?.enabled === true && (!!pa?.skill || !!pa?.prompt)
  return { enabled, skill: pa?.skill, prompt: pa?.prompt, model: pa?.model }
}
