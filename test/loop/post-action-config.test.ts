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
      variant: undefined,
      agent: 'code-loop',
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
      variant: undefined,
      agent: 'code-loop',
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
      variant: undefined,
      agent: 'code-loop',
    })
  })

  it('enabled: true with model uses configured model and variant', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: 'custom/model',
          variant: 'high',
        },
      },
    }

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: true,
      skill: 'pr-review',
      prompt: undefined,
      model: 'custom/model',
      variant: 'high',
      agent: 'code-loop',
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
      variant: undefined,
      agent: 'code-loop',
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
    expect(result.variant).toBeUndefined()
    expect(result.agent).toBe('code-loop')
  })

  it('missing loop.postAction resolves to enabled: false', () => {
    const config: PluginConfig = {}

    expect(resolvePostActionConfig(config)).toEqual({
      enabled: false,
      skill: undefined,
      prompt: undefined,
      model: undefined,
      variant: undefined,
      agent: 'code-loop',
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
      variant: undefined,
      agent: 'code-loop',
    })
  })

  it('uses a configured post-action agent', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          agent: 'custom-post-action',
        },
      },
    }

    expect(resolvePostActionConfig(config).agent).toBe('custom-post-action')
  })

  it('a per-loop post-action agent overrides the configured agent', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          agent: 'custom-post-action',
        },
      },
    }

    expect(resolvePostActionConfig(config, { postActionAgent: 'loop-post-action' }).agent).toBe('loop-post-action')
  })

  it('a blank per-loop post-action agent falls back to the configured agent', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          agent: 'custom-post-action',
        },
      },
    }

    expect(resolvePostActionConfig(config, { postActionAgent: '  ' }).agent).toBe('custom-post-action')
  })

  it('a per-loop post-action model overrides the configured model and does not inherit the configured variant', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: 'config/model',
          variant: 'config-variant',
        },
      },
    }

    const result = resolvePostActionConfig(config, {
      postActionModel: 'loop/model',
      postActionVariant: undefined,
    })
    expect(result.model).toBe('loop/model')
    expect(result.variant).toBeUndefined()
  })

  it('a per-loop post-action model uses its own per-loop variant', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: 'config/model',
          variant: 'config-variant',
        },
      },
    }

    const result = resolvePostActionConfig(config, {
      postActionModel: 'loop/model',
      postActionVariant: 'loop-variant',
    })
    expect(result.model).toBe('loop/model')
    expect(result.variant).toBe('loop-variant')
  })

  it('falls back to the configured model and variant when no per-loop model is set', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: 'config/model',
          variant: 'config-variant',
        },
      },
    }

    const result = resolvePostActionConfig(config, {})
    expect(result.model).toBe('config/model')
    expect(result.variant).toBe('config-variant')
  })

  it('a per-loop post-action variant alone does not apply without a configured model', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
        },
      },
    }

    const result = resolvePostActionConfig(config, { postActionVariant: 'loop-variant' })
    expect(result.model).toBeUndefined()
    expect(result.variant).toBeUndefined()
  })

  it('trims configured and per-loop model and variant values', () => {
    const config: PluginConfig = {
      loop: {
        postAction: {
          enabled: true,
          skill: 'pr-review',
          model: '  config/model  ',
          variant: '  config-variant  ',
        },
      },
    }

    const result = resolvePostActionConfig(config, { postActionModel: '  loop/model  ', postActionVariant: '  loop-variant  ' })
    expect(result.model).toBe('loop/model')
    expect(result.variant).toBe('loop-variant')
  })
})
