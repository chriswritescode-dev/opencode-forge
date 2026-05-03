import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createExecutionContextCache } from '../../src/utils/tui-execution-context-cache'
import type { ExecutionPreferences } from '../../src/utils/tui-execution-preferences'
import type { PluginConfig } from '../../src/types'
import type { ProviderInfo } from '../../src/utils/tui-models'

describe('createExecutionContextCache', () => {
  const mockProjectId = 'test-project'
  const mockPluginConfig: PluginConfig = {
    executionModel: 'anthropic/claude-sonnet-4',
    auditorModel: 'anthropic/claude-3-5-sonnet',
  }

  const mockProviders: ProviderInfo[] = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-sonnet-4',
          name: 'Claude Sonnet 4',
          providerID: 'anthropic',
          providerName: 'Anthropic',
          fullName: 'anthropic/claude-sonnet-4',
        },
        {
          id: 'claude-3-5-sonnet',
          name: 'Claude 3.5 Sonnet',
          providerID: 'anthropic',
          providerName: 'Anthropic',
          fullName: 'anthropic/claude-3-5-sonnet',
        },
      ],
    },
  ]

  const mockLoadFn = vi.fn<() => Promise<{
    preferences: ExecutionPreferences | null
    models: {
      providers: unknown[]
      connectedProviderIds?: string[]
      configuredProviderIds?: string[]
      error?: string
    }
  }>>()

  let persistedRecents: string[] = []
  const mockGetRecentModels = vi.fn(() => [...persistedRecents])
  const mockRecordRecentModel = vi.fn((_: string, model: string) => {
    persistedRecents = [model, ...persistedRecents.filter(m => m !== model)]
  })

  beforeEach(() => {
    mockLoadFn.mockReset()
    persistedRecents = []
    mockGetRecentModels.mockClear()
    mockRecordRecentModel.mockClear()
  })

  describe('snapshot', () => {
    it('returns null before first load', async () => {
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      expect(cache.snapshot()).toBeNull()
    })

    it('returns a value after ensureLoaded resolves', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const snap = cache.snapshot()
      expect(snap).not.toBeNull()
      expect(snap!.models).toHaveLength(2)
    })
  })

  describe('ensureLoaded', () => {
    it('concurrent calls share a single in-flight fetch', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const [result1, result2] = await Promise.all([
        cache.ensureLoaded(),
        cache.ensureLoaded(),
      ])

      expect(mockLoadFn).toHaveBeenCalledTimes(1)
      expect(result1).toBe(result2)
    })

    it('returns merged snapshot with defaults from resolveExecutionDialogDefaults', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('anthropic/claude-sonnet-4')
      expect(snap.defaults.auditorModel).toBe('anthropic/claude-3-5-sonnet')
      expect(snap.defaults.mode).toBe('Loop (worktree)')
    })

    it('models are flattened and sorted', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(snap.models).toHaveLength(2)
      expect(snap.models[0].fullName).toBe('anthropic/claude-3-5-sonnet')
    })

    it('recents are loaded from getRecentModels', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(Array.isArray(snap.recents)).toBe(true)
      expect(mockGetRecentModels).toHaveBeenCalledWith(mockProjectId)
    })

    it('favorites default to empty array', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(snap).toBeDefined()
    })
  })

  describe('recordRecent', () => {
    it('updates recents array and moves to front', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      cache.recordRecent('anthropic/claude-sonnet-4')
      expect(cache.snapshot()!.recents[0]).toBe('anthropic/claude-sonnet-4')
      expect(mockRecordRecentModel).toHaveBeenCalledWith(mockProjectId, 'anthropic/claude-sonnet-4')

      cache.recordRecent('anthropic/claude-3-5-sonnet')
      expect(cache.snapshot()!.recents[0]).toBe('anthropic/claude-3-5-sonnet')
      expect(cache.snapshot()!.recents[1]).toBe('anthropic/claude-sonnet-4')
    })

    it('deduplicates on repeat and moves to front', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      cache.recordRecent('model-a')
      cache.recordRecent('model-b')
      const beforeRepeat = cache.snapshot()!.recents
      expect(beforeRepeat[0]).toBe('model-b')
      
      cache.recordRecent('model-a')
      const afterRepeat = cache.snapshot()!.recents
      expect(afterRepeat[0]).toBe('model-a')
      expect(afterRepeat[1]).toBe('model-b')
    })

    it('skips empty strings', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const before = [...cache.snapshot()!.recents]
      cache.recordRecent('')
      const after = cache.snapshot()!.recents
      
      expect(after).toEqual(before)
      expect(mockRecordRecentModel).not.toHaveBeenCalled()
    })
  })

  describe('onChange', () => {
    it('listener is invoked on refresh', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const listener = vi.fn()

      cache.onChange(listener)
      await cache.refresh()

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('listener is invoked on recordRecent', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const listener = vi.fn()
      cache.onChange(listener)

      cache.recordRecent('anthropic/claude-sonnet-4')

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('unsubscribe stops notifications', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const listener = vi.fn()
      const unsub = cache.onChange(listener)
      unsub()

      cache.recordRecent('anthropic/claude-sonnet-4')

      expect(listener).not.toHaveBeenCalled()
    })

    it('onChange delivers existing snapshot to listeners that subscribe after refresh', async () => {
      mockLoadFn.mockResolvedValue({
        preferences: {
          mode: 'Loop',
          executionModel: 'anthropic/claude-sonnet-4',
          auditorModel: 'anthropic/claude-3-5-sonnet',
        },
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      await cache.ensureLoaded()

      const seen: Array<unknown> = []
      cache.onChange((s) => seen.push(s))

      await new Promise(resolve => queueMicrotask(() => resolve(undefined)))

      expect(seen).toHaveLength(1)
      expect((seen[0] as { defaults: { executionModel: string } }).defaults.executionModel).toBe('anthropic/claude-sonnet-4')
    })
  })

  describe('defaults resolution', () => {
    it('uses config.executionModel when prefs is null', async () => {
      const config: PluginConfig = {
        executionModel: 'p/m',
        auditorModel: 'p/m2',
      }

      mockLoadFn.mockResolvedValue({
        preferences: null,
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, config, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('p/m')
      expect(snap.defaults.auditorModel).toBe('p/m2')
    })

    it('stored prefs win over config', async () => {
      const config: PluginConfig = {
        executionModel: 'config/model',
        auditorModel: 'config/auditor',
      }

      mockLoadFn.mockResolvedValue({
        preferences: {
          mode: 'Loop',
          executionModel: 'stored/model',
          auditorModel: 'stored/auditor',
        },
        models: { providers: mockProviders },
      })

      const cache = createExecutionContextCache(mockProjectId, config, mockLoadFn, {
        getRecentModels: mockGetRecentModels,
        recordRecentModel: mockRecordRecentModel,
      })
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('stored/model')
      expect(snap.defaults.auditorModel).toBe('stored/auditor')
    })
  })
})
