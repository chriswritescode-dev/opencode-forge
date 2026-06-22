import { describe, it, expect } from 'vitest'
import { resolvePostActionConfig } from '../../src/loop/post-action-config'
import type { PluginConfig } from '../../src/types'

describe('resolvePostActionConfig', () => {
  it('enabled: true with skill enables the action and preserves skill', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: true,
      skill: 'pr-review',
      prompt: undefined,
      model: undefined,
    })
  })

  it('enabled: true with prompt enables the action and preserves prompt', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          prompt: 'Run post-action smoke review',
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: true,
      skill: undefined,
      prompt: 'Run post-action smoke review',
      model: undefined,
    })
  })

  it('enabled: true with both skill and prompt enables and preserves both', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          prompt: 'Double-check licensing headers',
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: true,
      skill: 'pr-review',
      prompt: 'Double-check licensing headers',
      model: undefined,
    })
  })

  it('enabled: true with model uses configured model', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: 'custom/model',
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: true,
      skill: 'pr-review',
      prompt: undefined,
      model: 'custom/model',
    })
  })

  it('enabled: true with neither skill nor prompt resolves to enabled: false', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: false,
      skill: undefined,
      prompt: undefined,
      model: undefined,
    })
  })

  it('enabled: false with a skill resolves to enabled: false but still returns configured metadata', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: false,
          skill: 'pr-review',
        },
      },
    }

    const result = resolvePostActionConfig(config)
    expect(result.enabled).toBe(false)
    expect(result.skill).toBe('pr-review')
    expect(result.prompt).toBeUndefined()
    expect(result.model).toBeUndefined()
  })

  it('missing loop.postAction resolves to enabled: false', () => {
    const config: PluginConfig = {}

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: false,
      skill: undefined,
      prompt: undefined,
      model: undefined,
    })
  })

  it('loop configured but no postAction resolves to enabled: false', () => {
    const config: PluginConfig = {
      loop: {
        enabled: true,
        defaultMaxIterations: 5,
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: false,
      skill: undefined,
      prompt: undefined,
      model: undefined,
    })
  })
})
