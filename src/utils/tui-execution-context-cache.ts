/**
 * Project-scoped execution context cache for TUI.
 * 
 * Provides a synchronous snapshot of execution context (preferences, models, recents)
 * with async refresh and deduped initial load. Used to pre-populate the execute dialog
 * at TUI startup so dialog opens are instant.
 */

import type { ExecutionPreferences } from './tui-execution-preferences'
import type { PluginConfig } from '../types'
import type { ModelInfo } from './tui-models'
import { flattenProviders, sortModelsByPriority } from './tui-models'
import { resolveExecutionDialogDefaults } from './tui-execution-preferences'
import { getRecentModels, recordRecentModel } from './tui-models'

export interface ExecutionContextSnapshot {
  preferences: ExecutionPreferences | null
  models: ModelInfo[]
  modelsError?: string
  connectedProviderIds: string[]
  configuredProviderIds: string[]
  recents: string[]
  defaults: {
    executionModel: string
    auditorModel: string
    mode: string
  }
}

export interface ExecutionContextCache {
  /** Synchronous read of last cached value. Returns null before first load. */
  snapshot(): ExecutionContextSnapshot | null
  /** Forces a refresh from the bus client. Updates snapshot and notifies listeners. */
  refresh(): Promise<ExecutionContextSnapshot>
  /** Returns cached snapshot or triggers initial load if not yet loaded. */
  ensureLoaded(): Promise<ExecutionContextSnapshot>
  /** Records a model as recently used. Updates in-memory recents and persists to SQLite. */
  recordRecent(modelFullName: string): void
  /** Registers a listener called on every snapshot update. Returns unsubscribe function. */
  onChange(listener: (snap: ExecutionContextSnapshot) => void): () => void
}

interface LoadExecutionContextResult {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
}

export interface ExecutionContextCacheDeps {
  getRecentModels?: (projectId: string) => string[]
  recordRecentModel?: (projectId: string, modelFullName: string) => void
}

/**
 * Creates a project-scoped execution context cache.
 * 
 * @param projectId - The project ID for recents/prefs lookups
 * @param pluginConfig - Plugin config for resolving defaults
 * @param loadFn - Function to load execution context from the bus client
 * @param deps - Optional dependency injection for testability
 * @returns Cache instance with snapshot/refresh/ensureLoaded/recordRecent/onChange methods
 */
export function createExecutionContextCache(
  projectId: string,
  pluginConfig: PluginConfig,
  loadFn: () => Promise<LoadExecutionContextResult>,
  deps: ExecutionContextCacheDeps = {},
): ExecutionContextCache {
  let currentSnapshot: ExecutionContextSnapshot | null = null
  let inFlightRefresh: Promise<ExecutionContextSnapshot> | null = null
  const listeners = new Set<(snap: ExecutionContextSnapshot) => void>()

  function notifyListeners() {
    if (currentSnapshot) {
      listeners.forEach(fn => fn(currentSnapshot!))
    }
  }

  const readRecents = deps.getRecentModels ?? getRecentModels
  const writeRecent = deps.recordRecentModel ?? recordRecentModel

  async function refresh(): Promise<ExecutionContextSnapshot> {
    const result = await loadFn()
    
    const allModelList = flattenProviders(result.models.providers as Parameters<typeof flattenProviders>[0])
    const recents = readRecents(projectId)
    const sorted = sortModelsByPriority(allModelList, {
      recents,
      connectedProviderIds: result.models.connectedProviderIds || [],
      configuredProviderIds: result.models.configuredProviderIds || [],
    })
    
    const defaults = resolveExecutionDialogDefaults(pluginConfig, result.preferences)
    
    currentSnapshot = {
      preferences: result.preferences,
      models: sorted,
      modelsError: result.models.error,
      connectedProviderIds: result.models.connectedProviderIds || [],
      configuredProviderIds: result.models.configuredProviderIds || [],
      recents,
      defaults,
    }
    
    notifyListeners()
    return currentSnapshot!
  }

  function ensureLoaded(): Promise<ExecutionContextSnapshot> {
    if (currentSnapshot) {
      return Promise.resolve(currentSnapshot)
    }
    
    if (inFlightRefresh) {
      return inFlightRefresh
    }
    
    inFlightRefresh = refresh().finally(() => {
      inFlightRefresh = null
    })
    
    return inFlightRefresh
  }

  function snapshot(): ExecutionContextSnapshot | null {
    return currentSnapshot
  }

  function recordRecent(modelFullName: string): void {
    if (!modelFullName) return
    
    writeRecent(projectId, modelFullName)
    
    if (currentSnapshot) {
      const updated = [modelFullName, ...currentSnapshot.recents.filter(m => m !== modelFullName)].slice(0, 10)
      currentSnapshot.recents = updated
      notifyListeners()
    }
  }

  function onChange(listener: (snap: ExecutionContextSnapshot) => void): () => void {
    listeners.add(listener)
    if (currentSnapshot) {
      queueMicrotask(() => {
        if (listeners.has(listener) && currentSnapshot) listener(currentSnapshot)
      })
    }
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    snapshot,
    refresh,
    ensureLoaded,
    recordRecent,
    onChange,
  }
}
