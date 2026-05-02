import { describe, test, expect, mock } from 'bun:test'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import {
  fetchAvailableModels,
  flattenProviders,
  buildModelOptions,
  resolveModelSelectedIndex,
  buildDialogSelectOptions,
  getModelDisplayLabel,
  sortModelsByPriority,
  type ProviderInfo,
  type ModelInfo,
} from '../src/utils/tui-models'

function createMockApi(listFn: any, configProviders?: string[], configProvidersFn?: any): TuiPluginApi {
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
      } as any,
      config: {
        providers: configProvidersFn,
      } as any,
    } as any,
    ui: {
      toast: mock(() => {}),
      dialog: {
        clear: mock(() => {}),
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
  test('returns providers array on success using config.providers', async () => {
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

    const configProvidersMock = mock(() => Promise.resolve({ data: { providers: mockProviders } }))
    const listFn = mock(() => Promise.resolve({ data: { all: [], connected: [] } }))
    const mockApi = createMockApi(listFn, ['anthropic'], configProvidersMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('anthropic')
    expect(result.providers[0].name).toBe('Anthropic')
    expect(result.providers[0].models).toHaveLength(1)
    expect(result.providers[0].models[0].fullName).toBe('anthropic/claude-sonnet-4-20250514')
    expect(result.connectedProviderIds).toEqual(['anthropic'])
    expect(result.configuredProviderIds).toEqual(['anthropic'])
    expect(configProvidersMock).toHaveBeenCalled()
    expect(listFn).not.toHaveBeenCalled()
  })

  test('returns empty providers array when no providers exist', async () => {
    const mockApi = createMockApi(mock(() => Promise.resolve({ data: { all: [], connected: [] } })))

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(0)
    expect(result.connectedProviderIds).toEqual([])
  })

  test('returns error when API returns error', async () => {
    const mockApi = createMockApi(mock(() => Promise.resolve({ 
      error: { 
        data: { message: 'Authentication failed' },
        name: 'APIError',
      } 
    })), ['anthropic'])

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(0)
    expect(result.error).toBe('Authentication failed')
    expect(result.configuredProviderIds).toEqual(['anthropic'])
  })

  test('returns error when API throws', async () => {
    const mockApi = createMockApi(mock(() => Promise.reject(new Error('Network error'))), ['openai'])

    const result = await fetchAvailableModels(mockApi)

    expect(result.providers).toHaveLength(0)
    expect(result.error).toBe('Network error')
    expect(result.configuredProviderIds).toEqual(['openai'])
  })

  test('returns error when no data returned', async () => {
    const mockApi = createMockApi(mock(() => Promise.resolve({ data: null } as any)), ['google'])

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

    const configProvidersMock = mock(() => Promise.resolve({ data: { providers: mockProviders } }))
    const mockApi = createMockApi(mock(() => {}), [], configProvidersMock)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].models).toHaveLength(0)
  })

  test('falls back to provider.list when config.providers is unavailable', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet': {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            capabilities: { temperature: true, toolcall: true, reasoning: false, attachment: true },
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
            capabilities: { temperature: true, toolcall: true, reasoning: false, attachment: false },
          },
        },
      },
      {
        id: 'google',
        name: 'Google',
        models: {
          'gemini': {
            id: 'gemini',
            name: 'Gemini',
            capabilities: { temperature: true, toolcall: true, reasoning: false, attachment: false },
          },
        },
      },
    ]

    const listFn = mock(() => Promise.resolve({ data: { all: mockProviders, connected: ['anthropic'] } }))
    const mockApi = createMockApi(listFn, ['anthropic'], undefined)

    const result = await fetchAvailableModels(mockApi)

    expect(result.error).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('anthropic')
    expect(result.connectedProviderIds).toEqual(['anthropic'])
  })

  test('returns empty favorites when state has no favorite models', async () => {
    const configProvidersMock = mock(() => Promise.resolve({ data: { providers: [] } }))
    const mockApi = createMockApi(mock(() => {}), [], configProvidersMock)
    ;(mockApi.state as any).local = {}

    const result = await fetchAvailableModels(mockApi)

    expect(result.favoriteModels).toEqual([])
  })

  test('reads favorite models from state.local.model.favorite', async () => {
    const mockProviders: any = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude': {
            id: 'claude',
            name: 'Claude',
            capabilities: { temperature: true, toolcall: true, reasoning: false, attachment: true },
          },
        },
      },
    ]

    const configProvidersMock = mock(() => Promise.resolve({ data: { providers: mockProviders } }))
    const mockApi = createMockApi(mock(() => {}), [], configProvidersMock)
    ;(mockApi.state as any).local = {
      model: {
        favorite: [
          { providerID: 'anthropic', modelID: 'claude' },
        ],
      },
    }

    const result = await fetchAvailableModels(mockApi)

    expect(result.favoriteModels).toEqual(['anthropic/claude'])
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

describe('buildModelOptions', () => {
  test('builds options with Use default as first entry', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
    ]

    const result = buildModelOptions(models)

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Use default')
    expect(result[0].value).toBe('')
    expect(result[1].name).toBe('Claude')
    expect(result[1].value).toBe('anthropic/claude')
  })

  test('includes provider name and capabilities in description', () => {
    const models: ModelInfo[] = [
      {
        id: 'model-with-reasoning',
        name: 'Model With Reasoning',
        providerID: 'test',
        providerName: 'Test Provider',
        fullName: 'test/model-with-reasoning',
        capabilities: {
          reasoning: true,
          toolcall: true,
          temperature: false,
          attachment: false,
        },
      },
      {
        id: 'model-without-reasoning',
        name: 'Model Without Reasoning',
        providerID: 'test',
        providerName: 'Test Provider',
        fullName: 'test/model-without-reasoning',
        capabilities: {
          reasoning: false,
          toolcall: false,
          temperature: true,
          attachment: false,
        },
      },
    ]

    const result = buildModelOptions(models)

    expect(result[1].description).toContain('Test Provider')
    expect(result[1].description).toContain('Reasoning')
    expect(result[1].description).toContain('Tools')
    expect(result[2].description).not.toContain('Reasoning')
    expect(result[2].description).toContain('No tools')
  })

  test('returns only Use default when no models', () => {
    const result = buildModelOptions([])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Use default')
    expect(result[0].value).toBe('')
  })
})

describe('resolveModelSelectedIndex', () => {
  test('returns 0 when selectedValue is undefined', () => {
    const options = [
      { value: '' },
      { value: 'anthropic/claude' },
      { value: 'openai/gpt-4' },
    ]

    const result = resolveModelSelectedIndex(options, undefined)
    expect(result).toBe(0)
  })

  test('returns 0 when selectedValue is empty string', () => {
    const options = [
      { value: '' },
      { value: 'anthropic/claude' },
      { value: 'openai/gpt-4' },
    ]

    const result = resolveModelSelectedIndex(options, '')
    expect(result).toBe(0)
  })

  test('returns correct index when value is found', () => {
    const options = [
      { value: '' },
      { value: 'anthropic/claude' },
      { value: 'openai/gpt-4' },
    ]

    const result = resolveModelSelectedIndex(options, 'openai/gpt-4')
    expect(result).toBe(2)
  })

  test('returns 0 when value is not found (fallback to Use default)', () => {
    const options = [
      { value: '' },
      { value: 'anthropic/claude' },
      { value: 'openai/gpt-4' },
    ]

    const result = resolveModelSelectedIndex(options, 'nonexistent/model')
    expect(result).toBe(0)
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

  test('shows favorites before recents with Favorites category', () => {
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

    const result = buildDialogSelectOptions(
      models,
      ['google/gemini', 'openai/gpt-4'], // recents
      ['openai/gpt-4'] // favorites
    )

    expect(result[0].title).toBe('Use default')
    expect(result[1].title).toBe('GPT-4')
    expect(result[1].category).toBe('Favorites')
    expect(result[2].title).toBe('Gemini')
    expect(result[2].category).toBe('Recent')
    expect(result[3].title).toBe('Claude')
    expect(result[3].category).toBe('Anthropic')
  })

  test('hides disconnected favorites and recents from options', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude',
        name: 'Claude',
        providerID: 'anthropic',
        providerName: 'Anthropic',
        fullName: 'anthropic/claude',
      },
    ]

    const result = buildDialogSelectOptions(
      models,
      ['google/gemini'], // recents (disconnected)
      ['openai/gpt-4'] // favorites (disconnected)
    )

    expect(result).toHaveLength(2) // Use default + Claude
    expect(result[0].title).toBe('Use default')
    expect(result[1].title).toBe('Claude')
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

  test('prioritizes favorites before recents', () => {
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
      favorites: ['openai/gpt-4'],
      recents: ['google/gemini'],
      connectedProviderIds: ['anthropic', 'openai'],
    })

    expect(result.map(model => model.fullName)).toEqual([
      'openai/gpt-4', // favorite
      'google/gemini', // recent
      'anthropic/claude', // connected provider
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
})
