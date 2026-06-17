import { describe, it, expect, vi } from 'vitest'
import { createExecutionContextCache } from '../../src/utils/tui-execution-context-cache'
import type { ExecutionPreferences } from '../../src/utils/tui-execution-preferences'
import type { PluginConfig } from '../../src/types'
import type {
  ProviderInfo,
  SessionForRecents,
  WorkspaceForRecents,
} from '../../src/utils/tui-models'

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

interface LoadResult {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
  sessions: SessionForRecents[]
  workspaces: WorkspaceForRecents[]
  openCodeFavorites: string[]
  openCodeDefault: string | undefined
}

function makeLoadResult(overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    preferences: null,
    models: { providers: mockProviders },
    sessions: [],
    workspaces: [],
    openCodeFavorites: [],
    openCodeDefault: undefined,
    ...overrides,
  }
}

describe('createExecutionContextCache', () => {
  describe('snapshot', () => {
    it('returns null before first load', () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      expect(cache.snapshot()).toBeNull()
    })

    it('returns a value after ensureLoaded resolves', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const snap = cache.snapshot()
      expect(snap).not.toBeNull()
      expect(snap!.models).toHaveLength(2)
    })
  })

  describe('ensureLoaded', () => {
    it('concurrent calls share a single in-flight fetch', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const [result1, result2] = await Promise.all([
        cache.ensureLoaded(),
        cache.ensureLoaded(),
      ])

      expect(loadFn).toHaveBeenCalledTimes(1)
      expect(result1).toBe(result2)
    })

    it('returns merged snapshot with defaults from resolveExecutionDialogDefaults', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('anthropic/claude-sonnet-4')
      expect(snap.defaults.auditorModel).toBe('anthropic/claude-3-5-sonnet')
      expect(snap.defaults.mode).toBe('Loop')
    })

    it('models are flattened and sorted', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      const snap = await cache.ensureLoaded()

      expect(snap.models).toHaveLength(2)
      expect(snap.models[0].fullName).toBe('anthropic/claude-3-5-sonnet')
    })

    it('recents are derived from sessions + workspaces + favorites + default', async () => {
      const loadFn = vi.fn(async () =>
        makeLoadResult({
          sessions: [
            {
              projectID: mockProjectId,
              model: { providerID: 'anthropic', id: 'claude-sonnet-4' },
              time: { updated: 200 },
            },
          ],
          workspaces: [
            {
              type: 'forge',
              projectID: mockProjectId,
              timeUsed: 100,
              extra: {
                forgeLoop: {
                  executionModel: 'anthropic/claude-sonnet-4',
                  auditorModel: 'openai/gpt-5',
                },
              },
            },
          ],
          openCodeFavorites: ['google/gemini-2'],
          openCodeDefault: 'anthropic/claude-3-5-sonnet',
        }),
      )

      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      const snap = await cache.ensureLoaded()

      // Session contributes claude-sonnet-4 (also in workspace, deduped);
      // workspace contributes openai/gpt-5 (auditor); favorites contribute
      // gemini-2; default contributes claude-3-5-sonnet.
      expect(snap.recents).toEqual([
        'anthropic/claude-sonnet-4',
        'openai/gpt-5',
        'google/gemini-2',
        'anthropic/claude-3-5-sonnet',
      ])
    })

    it('recents default to empty array when no sources contribute', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      const snap = await cache.ensureLoaded()
      expect(snap.recents).toEqual([])
    })
  })

  describe('recordRecent', () => {
    it('updates recents array and moves new entry to front', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      cache.recordRecent('anthropic/claude-sonnet-4')
      expect(cache.snapshot()!.recents[0]).toBe('anthropic/claude-sonnet-4')

      cache.recordRecent('anthropic/claude-3-5-sonnet')
      expect(cache.snapshot()!.recents[0]).toBe('anthropic/claude-3-5-sonnet')
      expect(cache.snapshot()!.recents[1]).toBe('anthropic/claude-sonnet-4')
    })

    it('deduplicates on repeat and moves to front', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      cache.recordRecent('model-a')
      cache.recordRecent('model-b')
      expect(cache.snapshot()!.recents[0]).toBe('model-b')

      cache.recordRecent('model-a')
      const after = cache.snapshot()!.recents
      expect(after[0]).toBe('model-a')
      expect(after[1]).toBe('model-b')
    })

    it('skips empty strings', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const before = [...cache.snapshot()!.recents]
      cache.recordRecent('')
      expect(cache.snapshot()!.recents).toEqual(before)
    })

    it('does not persist outside the in-memory snapshot (next refresh re-derives from SDK)', async () => {
      let preFavorites: string[] = []
      const loadFn = vi.fn(async () =>
        makeLoadResult({ openCodeFavorites: preFavorites }),
      )
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      cache.recordRecent('user-pick/model')
      expect(cache.snapshot()!.recents[0]).toBe('user-pick/model')

      // A subsequent refresh that does not include the user's pick in any
      // source MUST overwrite the in-memory recents — the server response is
      // authoritative on the next round-trip.
      preFavorites = ['other/favorite']
      await cache.refresh()
      expect(cache.snapshot()!.recents).toEqual(['other/favorite'])
    })
  })

  describe('onChange', () => {
    it('listener is invoked on refresh', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      const listener = vi.fn()

      cache.onChange(listener)
      await cache.refresh()

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('listener is invoked on recordRecent', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const listener = vi.fn()
      cache.onChange(listener)
      cache.recordRecent('anthropic/claude-sonnet-4')

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('unsubscribe stops notifications', async () => {
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const listener = vi.fn()
      const unsub = cache.onChange(listener)
      unsub()

      cache.recordRecent('anthropic/claude-sonnet-4')
      expect(listener).not.toHaveBeenCalled()
    })

    it('delivers existing snapshot to listeners that subscribe after refresh', async () => {
      const loadFn = vi.fn(async () =>
        makeLoadResult({
          preferences: {
            mode: 'Loop',
            executionModel: 'anthropic/claude-sonnet-4',
            auditorModel: 'anthropic/claude-3-5-sonnet',
          },
        }),
      )
      const cache = createExecutionContextCache(mockProjectId, mockPluginConfig, loadFn)
      await cache.ensureLoaded()

      const seen: Array<unknown> = []
      cache.onChange((s) => seen.push(s))
      await new Promise(resolve => queueMicrotask(() => resolve(undefined)))

      expect(seen).toHaveLength(1)
      expect((seen[0] as { defaults: { executionModel: string } }).defaults.executionModel).toBe('anthropic/claude-sonnet-4')
    })
  })

  describe('defaults resolution', () => {
    it('uses config.executionModel when preferences is null', async () => {
      const config: PluginConfig = {
        executionModel: 'p/m',
        auditorModel: 'p/m2',
      }
      const loadFn = vi.fn(async () => makeLoadResult())
      const cache = createExecutionContextCache(mockProjectId, config, loadFn)
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('p/m')
      expect(snap.defaults.auditorModel).toBe('p/m2')
    })

    it('stored prefs win over config', async () => {
      const config: PluginConfig = {
        executionModel: 'config/model',
        auditorModel: 'config/auditor',
      }
      const loadFn = vi.fn(async () =>
        makeLoadResult({
          preferences: {
            mode: 'Loop',
            executionModel: 'stored/model',
            auditorModel: 'stored/auditor',
          },
        }),
      )

      const cache = createExecutionContextCache(mockProjectId, config, loadFn)
      const snap = await cache.ensureLoaded()

      expect(snap.defaults.executionModel).toBe('stored/model')
      expect(snap.defaults.auditorModel).toBe('stored/auditor')
    })
  })
})
