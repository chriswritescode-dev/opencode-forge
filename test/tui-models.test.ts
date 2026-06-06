import { describe, test, expect, vi } from 'vitest'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import {
  fetchAvailableModels,
  flattenProviders,
  buildDialogSelectOptions,
  getModelDisplayLabel,
  sortModelsByPriority,
  getAvailableModelVariants,
  getVariantDisplayLabel,
  normalizeVariantForModel,
  deriveRecentModelsFromWorkspaces,
  deriveRecentModels,
  type ProviderInfo,
  type ModelInfo,
  type WorkspaceForRecents,
  type SessionForRecents,
  type DeriveRecentModelsInputs,
} from '../src/utils/tui-models'

function createMockApi(configProviders?: string[], providerListFn?: any): TuiPluginApi {
  const listFn = providerListFn ?? vi.fn(() => Promise.resolve({ data: { all: [], connected: [] } }))
  return {
    state: {
      config: {
        provider: Object.fromEntries((configProviders ?? []).map(id => [id, {}])),
      },
      path: {
        directory: '/test/project',
      },
    },
    client: {
      provider: {
        list: listFn,
      },
    } as any,
    ui: {
      toast: vi.fn(() => {}),
      dialog: {
        clear: vi.fn(() => {}),
      },
    },
    theme: {
      current: {
        text: '#ffffff',
        textMuted: '#888888',
        border: '#444444',
        borderActive: '#007acc',
        success: '#4caf50',
        error: '#f44336',
        warning: '#ff9800',
      },
    },
  } as unknown as TuiPluginApi
}

describe('fetchAvailableModels', () => {
  test('returns providers array on success using provider.list', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4-20250514': {
            id: 'claude-sonnet-4-20250514',
            name: 'Claude Sonnet 4',
            capabilities: {
              temperature: true,
              toolcall: true,
              reasoning: false,
              attachment: true,
            },
            cost: { input: 0.003, output: 0.015 },
          },
        },
      },
    ]

    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: mockProviders, connected: ['anthropic'] } }))
    const mockApi = createMockApi(['anthropic'], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('anthropic')
    expect(result.providers[0].name).toBe('Anthropic')
    expect(result.providers[0].models).toHaveLength(1)
    expect(result.providers[0].models[0].fullName).toBe('anthropic/claude-sonnet-4-20250514')
    expect(result.connectedProviderIds).toEqual(['anthropic'])
    expect(result.configuredProviderIds).toEqual(['anthropic'])
    expect(providerListMock).toHaveBeenCalled()
  })

  test('returns empty providers array when no providers exist', async () => {
    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: [], connected: [] } }))
    const mockApi = createMockApi([], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(0)
    expect(result.connectedProviderIds).toEqual([])
  })

  test('returns error when API returns error', async () => {
    const providerListMock = vi.fn(() => Promise.resolve({
      error: {
        data: { message: 'Authentication failed' },
        name: 'APIError',
      }
    }))
    const mockApi = createMockApi(['anthropic'], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(0)
    expect(result.error).toBe('Authentication failed')
    expect(result.configuredProviderIds).toEqual(['anthropic'])
  })

  test('returns error when API throws', async () => {
    const providerListMock = vi.fn(() => Promise.reject(new Error('Network error')))
    const mockApi = createMockApi(['openai'], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(0)
    expect(result.error).toBe('Network error')
    expect(result.configuredProviderIds).toEqual(['openai'])
  })

  test('returns error when no data returned', async () => {
    const providerListMock = vi.fn(() => Promise.resolve({ data: null }))
    const mockApi = createMockApi(['google'], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(0)
    expect(result.error).toBe('No provider data returned')
    expect(result.configuredProviderIds).toEqual(['google'])
  })

  test('handles providers with no models', async () => {
    const mockProviders: any = [
      {
        id: 'empty-provider',
        name: 'Empty Provider',
        models: {},
      },
    ]

    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: mockProviders, connected: ['empty-provider'] } }))
    const mockApi = createMockApi([], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].models).toHaveLength(0)
  })

  test('filters to connected providers only', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet': {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
          },
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-4': {
            id: 'gpt-4',
            name: 'GPT-4',
          },
        },
      },
    ]

    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: mockProviders, connected: ['anthropic'] } }))
    const mockApi = createMockApi([], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('anthropic')
    expect(result.connectedProviderIds).toEqual(['anthropic'])
  })

  test('includes releaseDate and cost in model info', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet': {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            release_date: '2024-01-01',
            cost: { input: 0.003, output: 0.015 },
            capabilities: {
              temperature: true,
              toolcall: true,
              reasoning: false,
              attachment: true,
            },
          },
        },
      },
    ]

    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: mockProviders, connected: ['anthropic'] } }))
    const mockApi = createMockApi([], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].models).toHaveLength(1)
    expect(result.providers[0].models[0].releaseDate).toBe('2024-01-01')
    expect(result.providers[0].models[0].cost).toEqual({ input: 0.003, output: 0.015 })
  })
})

describe('flattenProviders', () => {
  test('flattens multiple providers into single array', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            providerID: 'anthropic',
            providerName: 'Anthropic',
            fullName: 'anthropic/claude-sonnet',
          },
          {
            id: 'claude-opus',
            name: 'Claude Opus',
            providerID: 'anthropic',
            providerName: 'Anthropic',
            fullName: 'anthropic/claude-opus',
          },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          {
            id: 'gpt-4',
            name: 'GPT-4',
            providerID: 'openai',
            providerName: 'OpenAI',
            fullName: 'openai/gpt-4',
          },
        ],
      },
    ]

    const result = flattenProviders(providers)

    expect(result).toHaveLength(3)
    expect(result.map(m => m.fullName)).toEqual([
      'anthropic/claude-opus',
      'anthropic/claude-sonnet',
      'openai/gpt-4',
    ])
  })

  test('sorts models alphabetically by name', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'provider',
        name: 'Provider',
        models: [
          {
            id: 'z-model',
            name: 'Zebra Model',
            providerID: 'provider',
            providerName: 'Provider',
            fullName: 'provider/z-model',
          },
          {
            id: 'a-model',
            name: 'Alpha Model',
            providerID: 'provider',
            providerName: 'Provider',
            fullName: 'provider/a-model',
          },
          {
            id: 'm-model',
            name: 'Middle Model',
            providerID: 'provider',
            providerName: 'Provider',
            fullName: 'provider/m-model',
          },
        ],
      },
    ]

    const result = flattenProviders(providers)

    expect(result.map(m => m.name)).toEqual([
      'Alpha Model',
      'Middle Model',
      'Zebra Model',
    ])
  })

  test('returns empty array for empty providers', () => {
    const result = flattenProviders([])
    expect(result).toHaveLength(0)
  })
})

describe('buildDialogSelectOptions', () => {
  test('builds options with Use default first and models grouped by provider', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
        capabilities: { reasoning: true, toolcall: true },
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
        capabilities: { reasoning: false, toolcall: true },
      },
    ]

    const result = buildDialogSelectOptions(models)

    expect(result).toHaveLength(3)
    expect(result[0].title).toBe('Use default')
    expect(result[0].value).toBe('')
    expect(result[0].category).toBeUndefined()
    expect(result[1].title).toBe('Claude')
    expect(result[1].value).toBe('anthropic/claude')
    expect(result[1].category).toBe('Anthropic')
    expect(result[1].description).toBe('Reasoning')
    expect(result[2].title).toBe('GPT-4')
    expect(result[2].category).toBe('OpenAI')
    expect(result[2].description).toBeUndefined()
  })

  test('returns only Use default when no models', () => {
    const result = buildDialogSelectOptions([])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Use default')
  })

  test('shows recents at top with Recent category', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
      },
      {
        id: 'gemini',
        name: 'Gemini',
        providerID: 'google',
        providerName: 'Google',
        fullName: 'google/gemini',
      },
    ]

    const result = buildDialogSelectOptions(models, ['openai/gpt-4'])

    expect(result[0].title).toBe('Use default')
    expect(result[1].title).toBe('GPT-4')
    expect(result[1].category).toBe('Recent')
    expect(result[2].title).toBe('Claude')
    expect(result[2].category).toBe('Anthropic')
    expect(result[3].title).toBe('Gemini')
    expect(result[3].category).toBe('Google')
  })

  test('does not duplicate model in provider section when in recents', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
      },
    ]

    const result = buildDialogSelectOptions(models, ['openai/gpt-4'])

    // default + recent + provider = 3, no duplicates in provider section
    expect(result).toHaveLength(3)
    expect(result.filter(r => r.value === 'anthropic/claude')).toHaveLength(1)
    expect(result.filter(r => r.value === 'openai/gpt-4')).toHaveLength(1)
  })

})

describe('sortModelsByPriority', () => {
  test('prioritizes recents before provider priority', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
      },
      {
        id: 'gemini',
        name: 'Gemini',
        providerID: 'google',
        providerName: 'Google',
        fullName: 'google/gemini',
      },
    ]

    const result = sortModelsByPriority(models, {
      recents: ['google/gemini'],
      connectedProviderIds: ['anthropic'],
      configuredProviderIds: ['openai'],
    })

    expect(result.map(model => model.fullName)).toEqual([
      'google/gemini',
      'anthropic/claude',
      'openai/gpt-4',
    ])
  })

  test('prioritizes connected providers before configured providers', () => {
    const models: ModelInfo[] = [
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
      },
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
      {
        id: 'gemini',
        name: 'Gemini',
        providerID: 'google',
        providerName: 'Google',
        fullName: 'google/gemini',
      },
    ]

    const result = sortModelsByPriority(models, {
      connectedProviderIds: ['anthropic'],
      configuredProviderIds: ['openai'],
    })

    expect(result.map(model => model.fullName)).toEqual([
      'anthropic/claude',
      'openai/gpt-4',
      'google/gemini',
    ])
  })

  test('does not mutate input array', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerID: 'openai',
        providerName: 'OpenAI',
        fullName: 'openai/gpt-4',
      },
    ]
    const original = [...models]

    sortModelsByPriority(models, {
      recents: ['openai/gpt-4'],
      connectedProviderIds: ['anthropic'],
    })

    expect(models).toEqual(original)
  })
})

describe('getModelDisplayLabel', () => {
  const models: ModelInfo[] = [
    {
      id: 'claude',
      name: 'Claude Sonnet',
      providerID: 'anthropic',
      providerName: 'Anthropic',
      fullName: 'anthropic/claude',
    },
  ]

  test('returns "default" for empty value', () => {
    expect(getModelDisplayLabel('', models)).toBe('default')
  })

  test('returns model name when found', () => {
    expect(getModelDisplayLabel('anthropic/claude', models)).toBe('Claude Sonnet')
  })

  test('returns raw value when not found', () => {
    expect(getModelDisplayLabel('unknown/model', models)).toBe('unknown/model')
  })

  test('returns fallback model name when value empty and fallback resolves in models', () => {
    expect(getModelDisplayLabel('', models, 'anthropic/claude')).toBe('Claude Sonnet')
  })

  test('returns raw fallback fullName when value empty and fallback not in models', () => {
    expect(getModelDisplayLabel('', models, 'unknown/model')).toBe('unknown/model')
  })

  test('returns "default" when value empty and fallback empty', () => {
    expect(getModelDisplayLabel('', models, '')).toBe('default')
  })

  test('returns "default" when value empty and fallback undefined', () => {
    expect(getModelDisplayLabel('', models)).toBe('default')
  })

  test('ignores fallback when value is non-empty', () => {
    expect(getModelDisplayLabel('anthropic/claude', models, 'unknown/model')).toBe('Claude Sonnet')
  })
})

describe('fetchAvailableModels with variants', () => {
  test('preserves variants from provider model data', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet': {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            variants: {
              default: { name: 'Default' },
              'thinking-max': { name: 'Thinking Max' },
            },
          },
        },
      },
    ]

    const providerListMock = vi.fn(() => Promise.resolve({ data: { all: mockProviders, connected: ['anthropic'] } }))
    const mockApi = createMockApi(['anthropic'], providerListMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers[0].models[0].variants).toEqual({
      default: { name: 'Default' },
      'thinking-max': { name: 'Thinking Max' },
    })
  })
})

describe('getAvailableModelVariants', () => {
  test('returns empty array when model is null', () => {
    expect(getAvailableModelVariants(null)).toEqual([])
  })

  test('returns empty array when model has no variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
    }
    expect(getAvailableModelVariants(model)).toEqual([])
  })

  test('excludes disabled variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { disabled: false },
        legacy: { disabled: true },
        active: {},
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result).toHaveLength(2)
    expect(result.map(v => v.id)).toEqual(['default', 'active'])
  })

  test('uses configured names/descriptions when present', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { name: 'Default Variant', description: 'The default configuration' },
        'thinking-max': { thinkingBudget: 32000 },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('Default Variant')
    expect(result[0].description).toBe('The default configuration')
    expect(result[1].label).toBe('Thinking Max')
    expect(result[1].description).toBe('Thinking budget: 32000')
  })

  test('generates labels from kebab-case and snake_case keys', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        'thinking-max': {},
        reasoning_high: {},
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result.map(v => v.label)).toEqual(['Thinking Max', 'Reasoning High'])
  })

  test('generates descriptions from reasoningEffort field', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        high: { reasoningEffort: 'high' },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].description).toBe('Reasoning: high')
  })

  test('generates descriptions from thinking field', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { thinking: 'low' },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].description).toBe('Thinking: low')
  })

  test('generates descriptions from reasoning_effort field', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        mid: { reasoning_effort: 'medium' },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].description).toBe('Reasoning: medium')
  })

  test('generates descriptions from thinking_budget field', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { thinking_budget: 16000 },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].description).toBe('Thinking budget: 16000')
  })

  test('returns undefined description when no relevant fields present', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { unrelated_field: 'value' },
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].description).toBeUndefined()
  })

  test('preserves variant key as id', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        'custom-id': {},
      },
    }
    const result = getAvailableModelVariants(model)
    expect(result[0].id).toBe('custom-id')
  })
})

describe('getVariantDisplayLabel', () => {
  test('returns "default" for undefined variant', () => {
    expect(getVariantDisplayLabel(undefined)).toBe('default')
  })

  test('returns "default" for empty string', () => {
    expect(getVariantDisplayLabel('')).toBe('default')
  })

  test('returns friendly label for known variant', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        'thinking-max': { name: 'Thinking Max' },
      },
    }
    expect(getVariantDisplayLabel('thinking-max', model)).toBe('Thinking Max')
  })

  test('returns raw string for unknown variant', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: {},
      },
    }
    expect(getVariantDisplayLabel('unknown-variant', model)).toBe('unknown-variant')
  })

  test('returns raw string when model is null', () => {
    expect(getVariantDisplayLabel('some-variant', null)).toBe('some-variant')
  })

  test('returns raw string when model has no variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
    }
    expect(getVariantDisplayLabel('some-variant', model)).toBe('some-variant')
  })
})

describe('normalizeVariantForModel', () => {
  test('returns empty string for undefined variant', () => {
    expect(normalizeVariantForModel(undefined)).toBe('')
  })

  test('returns empty string for empty string', () => {
    expect(normalizeVariantForModel('')).toBe('')
  })

  test('returns empty string when model has no variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
    }
    expect(normalizeVariantForModel('some-variant', model)).toBe('')
  })

  test('returns variant when it exists in available variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        'thinking-max': {},
        default: {},
      },
    }
    expect(normalizeVariantForModel('thinking-max', model)).toBe('thinking-max')
    expect(normalizeVariantForModel('default', model)).toBe('default')
  })

  test('returns empty string when variant is not in available variants', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: {},
      },
    }
    expect(normalizeVariantForModel('thinking-max', model)).toBe('')
  })

  test('returns empty string when variant is disabled', () => {
    const model: ModelInfo = {
      id: 'test',
      name: 'Test',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test',
      variants: {
        default: { disabled: false },
        legacy: { disabled: true },
      },
    }
    expect(normalizeVariantForModel('legacy', model)).toBe('')
    expect(normalizeVariantForModel('default', model)).toBe('default')
  })

  test('clears invalid variants when switching models', () => {
    const modelA: ModelInfo = {
      id: 'test-a',
      name: 'Test A',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test-a',
      variants: {
        'thinking-max': {},
      },
    }

    const modelB: ModelInfo = {
      id: 'test-b',
      name: 'Test B',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/test-b',
      variants: {
        default: {},
      },
    }

    // User had thinking-max on modelA, now switching to modelB which doesn't have it
    expect(normalizeVariantForModel('thinking-max', modelA)).toBe('thinking-max')
    expect(normalizeVariantForModel('thinking-max', modelB)).toBe('')
  })

  test('returns empty string when model is null (regression: use-default model)', () => {
    // Bug 2 fix: When a user selects "Use default" for a model (empty string),
    // the component must resolve the OpenCode default model first before normalizing.
    // This test verifies that passing null directly returns empty string.
    expect(normalizeVariantForModel('thinking-max', null)).toBe('')
  })

  test('preserves variant when effective model supports it (regression: use-default variant)', () => {
    // Bug 2 fix: When the effective model supports a variant, it should be preserved.
    const defaultModel: ModelInfo = {
      id: 'default',
      name: 'Default',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/default',
      variants: {
        'thinking-max': {},
        default: {},
      },
    }
    // Even if we started from null, normalizing against the resolved default model preserves the variant
    expect(normalizeVariantForModel('thinking-max', defaultModel)).toBe('thinking-max')
  })

  test('returns empty string when variant is not available in effective model', () => {
    // Variant 'thinking-max' is not in the model's available variants
    const modelWithoutThinking: ModelInfo = {
      id: 'no-thinking',
      name: 'No Thinking',
      providerID: 'provider',
      providerName: 'Provider',
      fullName: 'provider/no-thinking',
      variants: {
        default: {},
      },
    }
    expect(normalizeVariantForModel('thinking-max', modelWithoutThinking)).toBe('')
  })
})

describe('deriveRecentModelsFromWorkspaces', () => {
  const PROJECT_A = 'project-a'
  const PROJECT_B = 'project-b'

  function forgeWs(input: {
    timeUsed?: number | string
    projectID?: string
    executionModel?: string | null
    auditorModel?: string | null
    extraOverride?: unknown
  }): WorkspaceForRecents {
    const forgeLoop: Record<string, unknown> = {}
    if (input.executionModel !== undefined && input.executionModel !== null) {
      forgeLoop.executionModel = input.executionModel
    }
    if (input.auditorModel !== undefined && input.auditorModel !== null) {
      forgeLoop.auditorModel = input.auditorModel
    }
    return {
      type: 'forge',
      ...(input.projectID !== undefined ? { projectID: input.projectID } : {}),
      ...(input.timeUsed !== undefined ? { timeUsed: input.timeUsed } : {}),
      extra: input.extraOverride !== undefined ? input.extraOverride : { forgeLoop },
    }
  }

  test('returns empty array for empty workspace list', () => {
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, [])).toEqual([])
  })

  test('returns empty array when no workspace is type=forge', () => {
    const workspaces: WorkspaceForRecents[] = [
      { type: 'local', projectID: PROJECT_A, timeUsed: 1, extra: { forgeLoop: { executionModel: 'anthropic/claude' } } },
      { type: 'worktree', projectID: PROJECT_A, timeUsed: 2, extra: { forgeLoop: { executionModel: 'openai/gpt-5' } } },
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([])
  })

  test('extracts executionModel from a single forge workspace', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'anthropic/claude-sonnet-4' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude-sonnet-4',
    ])
  })

  test('records executionModel before auditorModel within the same workspace', () => {
    const workspaces = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 1,
        executionModel: 'anthropic/claude-sonnet-4',
        auditorModel: 'openai/gpt-5',
      }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ])
  })

  test('sorts workspaces by timeUsed descending', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'older/older' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 300, executionModel: 'newest/newest' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'middle/middle' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'newest/newest',
      'middle/middle',
      'older/older',
    ])
  })

  test('dedupes a model that appears in multiple workspaces, preserving first (most recent) occurrence', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 300, executionModel: 'anthropic/claude-sonnet-4' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'openai/gpt-5' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'anthropic/claude-sonnet-4' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ])
  })

  test('dedupes executionModel against auditorModel from earlier workspace', () => {
    const workspaces = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 300,
        executionModel: 'anthropic/claude-sonnet-4',
        auditorModel: 'openai/gpt-5',
      }),
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 200,
        executionModel: 'openai/gpt-5',
        auditorModel: 'google/gemini-2',
      }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
      'google/gemini-2',
    ])
  })

  test('excludes workspaces whose projectID differs from the requested projectId', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'anthropic/claude' }),
      forgeWs({ projectID: PROJECT_B, timeUsed: 300, executionModel: 'foreign/model' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude',
    ])
  })

  test('includes workspaces with no projectID (forward-compat)', () => {
    const workspaces = [
      forgeWs({ timeUsed: 100, executionModel: 'legacy/model' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'legacy/model',
    ])
  })

  test('skips workspaces with non-object extra', () => {
    const workspaces: WorkspaceForRecents[] = [
      { type: 'forge', projectID: PROJECT_A, timeUsed: 300, extra: null },
      { type: 'forge', projectID: PROJECT_A, timeUsed: 200, extra: 'oops' as unknown },
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'anthropic/claude' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude',
    ])
  })

  test('skips workspaces whose extra lacks a forgeLoop object', () => {
    const workspaces: WorkspaceForRecents[] = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 400, extraOverride: { somethingElse: 1 } }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 300, extraOverride: { forgeLoop: null } }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, extraOverride: { forgeLoop: 'not-an-object' } }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'anthropic/claude' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude',
    ])
  })

  test('ignores empty / non-string model fields', () => {
    const workspaces: WorkspaceForRecents[] = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 400, executionModel: '' }),
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 300,
        extraOverride: { forgeLoop: { executionModel: 42, auditorModel: { wrong: 'shape' } } },
      }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'anthropic/claude' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)).toEqual([
      'anthropic/claude',
    ])
  })

  test('treats non-finite timeUsed values ("NaN", "Infinity", missing) as 0 for sort', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 'NaN', executionModel: 'nan/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 'Infinity', executionModel: 'inf/model' }),
      forgeWs({ projectID: PROJECT_A, executionModel: 'missing/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'real/model' }),
    ]
    const result = deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)
    // 'real/model' must come first (timeUsed=1 vs all-zero others).
    expect(result[0]).toBe('real/model')
    // The other three sort relatively to each other in stable input order.
    expect(result.slice(1).sort()).toEqual(['inf/model', 'missing/model', 'nan/model'].sort())
  })

  test('caps the result at RECENT_MODELS_MAX (10) by default', () => {
    const workspaces: WorkspaceForRecents[] = []
    for (let i = 0; i < 15; i++) {
      workspaces.push(forgeWs({
        projectID: PROJECT_A,
        timeUsed: 1000 - i,
        executionModel: `prov-${i}/model-${i}`,
      }))
    }
    const result = deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces)
    expect(result).toHaveLength(10)
    expect(result[0]).toBe('prov-0/model-0')
    expect(result[9]).toBe('prov-9/model-9')
  })

  test('honors a custom `max` option', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 3, executionModel: 'a/a' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 2, executionModel: 'b/b' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'c/c' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces, { max: 2 })).toEqual([
      'a/a',
      'b/b',
    ])
  })

  test('returns [] when max is 0 or negative', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'a/a' }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces, { max: 0 })).toEqual([])
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces, { max: -5 })).toEqual([])
  })

  test('stops scanning once the cap is reached (executionModel-then-auditor ordering preserved at boundary)', () => {
    const workspaces = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 100,
        executionModel: 'first/exec',
        auditorModel: 'first/audit',
      }),
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 50,
        executionModel: 'second/exec',
        auditorModel: 'second/audit',
      }),
    ]
    expect(deriveRecentModelsFromWorkspaces(PROJECT_A, workspaces, { max: 3 })).toEqual([
      'first/exec',
      'first/audit',
      'second/exec',
    ])
  })
})

describe('deriveRecentModels (layered)', () => {
  const PROJECT_A = 'project-a'
  const PROJECT_B = 'project-b'

  function emptyInputs(): DeriveRecentModelsInputs {
    return {
      sessions: [],
      workspaces: [],
      openCodeFavorites: [],
      openCodeDefault: undefined,
    }
  }

  function session(input: {
    projectID?: string
    providerID?: string
    id?: string
    variant?: string
    updated?: number
  }): SessionForRecents {
    return {
      projectID: input.projectID ?? PROJECT_A,
      model:
        input.providerID === undefined || input.id === undefined
          ? null
          : { providerID: input.providerID, id: input.id, ...(input.variant !== undefined ? { variant: input.variant } : {}) },
      time: { updated: input.updated ?? 0 },
    }
  }

  function forgeWs(input: {
    timeUsed?: number
    projectID?: string
    executionModel?: string
    auditorModel?: string
  }): WorkspaceForRecents {
    const forgeLoop: Record<string, unknown> = {}
    if (input.executionModel) forgeLoop.executionModel = input.executionModel
    if (input.auditorModel) forgeLoop.auditorModel = input.auditorModel
    return {
      type: 'forge',
      ...(input.projectID !== undefined ? { projectID: input.projectID } : {}),
      ...(input.timeUsed !== undefined ? { timeUsed: input.timeUsed } : {}),
      extra: { forgeLoop },
    }
  }

  test('returns empty array when all inputs are empty', () => {
    expect(deriveRecentModels(PROJECT_A, emptyInputs())).toEqual([])
  })

  test('returns empty array when max <= 0 even with populated inputs', () => {
    const inputs: DeriveRecentModelsInputs = {
      sessions: [session({ providerID: 'anthropic', id: 'claude', updated: 100 })],
      workspaces: [forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'a/b' })],
      openCodeFavorites: ['x/y'],
      openCodeDefault: 'z/w',
    }
    expect(deriveRecentModels(PROJECT_A, inputs, { max: 0 })).toEqual([])
    expect(deriveRecentModels(PROJECT_A, inputs, { max: -1 })).toEqual([])
  })

  describe('sessions layer', () => {
    test('extracts model fullnames from sessions for the requested project', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'anthropic', id: 'claude-sonnet-4', updated: 100 }),
          session({ providerID: 'openai', id: 'gpt-5', updated: 200 }),
        ],
      }
      // Sorted by time.updated desc
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'openai/gpt-5',
        'anthropic/claude-sonnet-4',
      ])
    })

    test('excludes sessions from other projects', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ projectID: PROJECT_A, providerID: 'anthropic', id: 'claude', updated: 100 }),
          session({ projectID: PROJECT_B, providerID: 'foreign', id: 'model', updated: 200 }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['anthropic/claude'])
    })

    test('skips sessions with null/missing model', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          { projectID: PROJECT_A, model: null, time: { updated: 300 } },
          { projectID: PROJECT_A, time: { updated: 200 } },
          session({ providerID: 'anthropic', id: 'claude', updated: 100 }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['anthropic/claude'])
    })

    test('skips sessions with malformed model (empty providerID or id)', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          { projectID: PROJECT_A, model: { providerID: '', id: 'model' }, time: { updated: 300 } },
          { projectID: PROJECT_A, model: { providerID: 'prov', id: '' }, time: { updated: 200 } },
          session({ providerID: 'anthropic', id: 'claude', updated: 100 }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['anthropic/claude'])
    })

    test('dedupes the same model across multiple sessions, preserving most-recent occurrence', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'anthropic', id: 'claude', updated: 300 }),
          session({ providerID: 'openai', id: 'gpt-5', updated: 200 }),
          session({ providerID: 'anthropic', id: 'claude', updated: 100 }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'anthropic/claude',
        'openai/gpt-5',
      ])
    })

    test('ignores `variant` when building the fullname', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'anthropic', id: 'claude', variant: 'thinking', updated: 100 }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['anthropic/claude'])
    })
  })

  describe('workspaces layer', () => {
    test('surfaces models that sessions did not capture (e.g. auditor model)', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'anthropic', id: 'claude-sonnet-4', updated: 200 }),
        ],
        workspaces: [
          forgeWs({
            projectID: PROJECT_A,
            timeUsed: 100,
            executionModel: 'anthropic/claude-sonnet-4',
            auditorModel: 'openai/gpt-5',
          }),
        ],
      }
      // Session contributes claude-sonnet-4; workspace adds gpt-5 (auditor).
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'anthropic/claude-sonnet-4',
        'openai/gpt-5',
      ])
    })

    test('workspace layer runs after sessions: session order wins on overlap', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'openai', id: 'gpt-5', updated: 100 }),
        ],
        workspaces: [
          forgeWs({
            projectID: PROJECT_A,
            timeUsed: 1000, // even with much higher recency, sessions are layered first
            executionModel: 'anthropic/claude-sonnet-4',
            auditorModel: 'openai/gpt-5',
          }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'openai/gpt-5',
        'anthropic/claude-sonnet-4',
      ])
    })

    test('workspaces from other projects do not leak into the result', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        workspaces: [
          forgeWs({ projectID: PROJECT_B, timeUsed: 100, executionModel: 'foreign/model' }),
          forgeWs({ projectID: PROJECT_A, timeUsed: 50, executionModel: 'mine/model' }),
        ],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['mine/model'])
    })
  })

  describe('favorites layer', () => {
    test('surfaces favorites after sessions + workspaces', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [session({ providerID: 'openai', id: 'gpt-5', updated: 100 })],
        openCodeFavorites: ['anthropic/claude', 'google/gemini'],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'openai/gpt-5',
        'anthropic/claude',
        'google/gemini',
      ])
    })

    test('favorites preserve the order they were provided', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        openCodeFavorites: ['z/last', 'a/first', 'm/middle'],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'z/last',
        'a/first',
        'm/middle',
      ])
    })

    test('favorites already present in earlier layers are deduped (first occurrence wins)', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [session({ providerID: 'anthropic', id: 'claude', updated: 100 })],
        openCodeFavorites: ['anthropic/claude', 'openai/gpt-5'],
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'anthropic/claude',
        'openai/gpt-5',
      ])
    })
  })

  describe('default layer', () => {
    test('global default appears last when no earlier layer surfaced it', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [session({ providerID: 'openai', id: 'gpt-5', updated: 100 })],
        openCodeDefault: 'anthropic/claude',
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'openai/gpt-5',
        'anthropic/claude',
      ])
    })

    test('global default is deduped if an earlier layer already surfaced it', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [session({ providerID: 'anthropic', id: 'claude', updated: 100 })],
        openCodeDefault: 'anthropic/claude',
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['anthropic/claude'])
    })

    test('empty/undefined default is a no-op', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [session({ providerID: 'openai', id: 'gpt-5', updated: 100 })],
        openCodeDefault: undefined,
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual(['openai/gpt-5'])
      const inputs2: DeriveRecentModelsInputs = { ...inputs, openCodeDefault: '' }
      expect(deriveRecentModels(PROJECT_A, inputs2)).toEqual(['openai/gpt-5'])
    })
  })

  describe('cap and composition', () => {
    test('respects the cap and stops scanning early', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: [
          session({ providerID: 'p1', id: 'm1', updated: 500 }),
          session({ providerID: 'p2', id: 'm2', updated: 400 }),
          session({ providerID: 'p3', id: 'm3', updated: 300 }),
        ],
        workspaces: [
          forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'p4/m4' }),
        ],
        openCodeFavorites: ['p5/m5'],
        openCodeDefault: 'p6/m6',
      }
      expect(deriveRecentModels(PROJECT_A, inputs, { max: 2 })).toEqual([
        'p1/m1',
        'p2/m2',
      ])
    })

    test('full composition: all four layers contribute in priority order', () => {
      const inputs: DeriveRecentModelsInputs = {
        sessions: [
          session({ providerID: 'session', id: 'recent', updated: 100 }),
        ],
        workspaces: [
          forgeWs({
            projectID: PROJECT_A,
            timeUsed: 50,
            executionModel: 'session/recent', // duplicate of session
            auditorModel: 'workspace/auditor',
          }),
        ],
        openCodeFavorites: ['favorite/explicit', 'session/recent'],
        openCodeDefault: 'global/default',
      }
      expect(deriveRecentModels(PROJECT_A, inputs)).toEqual([
        'session/recent',
        'workspace/auditor',
        'favorite/explicit',
        'global/default',
      ])
    })

    test('caps at RECENT_MODELS_MAX (10) by default', () => {
      const inputs: DeriveRecentModelsInputs = {
        ...emptyInputs(),
        sessions: Array.from({ length: 15 }, (_, i) =>
          session({ providerID: `p${i}`, id: `m${i}`, updated: 1000 - i }),
        ),
      }
      const result = deriveRecentModels(PROJECT_A, inputs)
      expect(result).toHaveLength(10)
      expect(result[0]).toBe('p0/m0')
      expect(result[9]).toBe('p9/m9')
    })
  })
})
