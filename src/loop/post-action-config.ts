import type { PluginConfig } from '../types'

export interface ResolvedPostActionConfig {
  enabled: boolean
  skill?: string
  prompt?: string
  model?: string
}

/** Resolve the post-action config from a plugin config. Enabled requires enabled===true AND (skill or prompt). */
export function resolvePostActionConfig(config: PluginConfig): ResolvedPostActionConfig {
  const pa = config.loop?.postAction
  const enabled = pa?.enabled === true && (!!pa?.skill || !!pa?.prompt)
  return { enabled, skill: pa?.skill, prompt: pa?.prompt, model: pa?.model }
}
