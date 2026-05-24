/**
 * Project-scoped execution context cache for TUI.
 *
 * Provides a synchronous snapshot of execution context (preferences, models, recents)
 * with async refresh and deduped initial load. Used to pre-populate the execute dialog
 * at TUI startup so dialog opens are instant.
 *
 * As of the SDK-derived refactor, every input feeding the snapshot is
 * fetched from the OpenCode server via the `loadFn`. Recents and last-used
 * preferences are derived from `session.list()` + `workspace.list()` +
 * favorites/default in `api.state`, so the cache works correctly even when
 * the TUI is running on a different host than the OpenCode server.
 */

import type { ExecutionPreferences } from './tui-execution-preferences'
import type { PluginConfig } from '../types'
import type { ModelInfo } from './tui-models'
import { deriveRecentModels, flattenProviders, sortModelsByPriority } from './tui-models'
import { resolveExecutionDialogDefaults } from './tui-execution-preferences'
import type { ExecutionContext } from './tui-client'

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
    executionVariant: string
    auditorVariant: string
  }
}

/**
 * Builds an `ExecutionContextSnapshot` from a raw SDK load result. Single
 * source of truth used by both the cache's `refresh()` and the inline
 * fallback path in `ExecutePlanPanel` so the two never diverge.
 */
export function buildExecutionContextSnapshot(
  projectId: string,
  pluginConfig: PluginConfig,
  result: ExecutionContext,
): ExecutionContextSnapshot {
  const allModelList = flattenProviders(result.models.providers as Parameters<typeof flattenProviders>[0])
  const recents = deriveRecentModels(projectId, {
    sessions: result.sessions,
    workspaces: result.workspaces,
    openCodeFavorites: result.openCodeFavorites,
    openCodeDefault: result.openCodeDefault,
  })
  const sorted = sortModelsByPriority(allModelList, {
    recents,
    connectedProviderIds: result.models.connectedProviderIds || [],
    configuredProviderIds: result.models.configuredProviderIds || [],
  })
  const defaults = resolveExecutionDialogDefaults(pluginConfig, result.preferences)

  return {
    preferences: result.preferences,
    models: sorted,
    modelsError: result.models.error,
    connectedProviderIds: result.models.connectedProviderIds || [],
    configuredProviderIds: result.models.configuredProviderIds || [],
    recents,
    defaults,
  }
}

export interface ExecutionContextCache {
  /** Synchronous read of last cached value. Returns null before first load. */
  snapshot(): ExecutionContextSnapshot | null
  /** Forces a refresh from the bus client. Updates snapshot and notifies listeners. */
  refresh(): Promise<ExecutionContextSnapshot>
  /** Returns cached snapshot or triggers initial load if not yet loaded. */
  ensureLoaded(): Promise<ExecutionContextSnapshot>
  /**
   * Records a model as recently used. Updates the in-memory snapshot only;
   * the next `refresh()` re-derives recents from the SDK responses, so the
   * server-side state is authoritative on the next round-trip.
   */
  recordRecent(modelFullName: string): void
  /** Registers a listener called on every snapshot update. Returns unsubscribe function. */
  onChange(listener: (snap: ExecutionContextSnapshot) => void): () => void
}

const RECENTS_CAP = 10

/**
 * Creates a project-scoped execution context cache.
 *
 * @param projectId - The project ID for recents/prefs lookups
 * @param pluginConfig - Plugin config for resolving defaults
 * @param loadFn - Function to load execution context from the SDK. Must
 *   return sessions/workspaces/favorites/default alongside models +
 *   preferences; see `ExecutionContext`.
 * @returns Cache instance with snapshot/refresh/ensureLoaded/recordRecent/onChange methods
 */
export function createExecutionContextCache(
  projectId: string,
  pluginConfig: PluginConfig,
  loadFn: () => Promise<ExecutionContext>,
): ExecutionContextCache {
  let currentSnapshot: ExecutionContextSnapshot | null = null
  let inFlightRefresh: Promise<ExecutionContextSnapshot> | null = null
  const listeners = new Set<(snap: ExecutionContextSnapshot) => void>()

  function notifyListeners() {
    if (currentSnapshot) {
      listeners.forEach(fn => fn(currentSnapshot!))
    }
  }

  async function refresh(): Promise<ExecutionContextSnapshot> {
    const result = await loadFn()
    currentSnapshot = buildExecutionContextSnapshot(projectId, pluginConfig, result)
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

    if (currentSnapshot) {
      const updated = [modelFullName, ...currentSnapshot.recents.filter(m => m !== modelFullName)].slice(0, RECENTS_CAP)
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
