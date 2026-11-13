import type { ExecutionPreferences, ExecutionSelectionOverride } from './tui-execution-preferences'
import type { PluginConfig } from '../types'
import type { ModelInfo } from './tui-models'
import { deriveRecentModels, flattenProviders, sortModelsByPriority } from './tui-models'
import { resolveExecutionDialogDefaults } from './tui-execution-preferences'
import type { ExecutionContext } from '../tui/project-client'
import type { ForgeLoopDefaults } from '../host/forge-rpc'

export interface ExecutionContextSnapshot {
  preferences: ExecutionPreferences | null
  models: ModelInfo[]
  modelsError?: string
  connectedProviderIds: string[]
  configuredProviderIds: string[]
  recents: string[]
  openCodeDefault: string
  loopDefaults: ForgeLoopDefaults | null
  defaults: {
    executionModel: string
    auditorModel: string
    mode: string
    executionVariant: string
    auditorVariant: string
  }
}

export function buildExecutionContextSnapshot(
  projectId: string,
  pluginConfig: PluginConfig,
  result: ExecutionContext,
  overrides?: ExecutionSelectionOverride,
): ExecutionContextSnapshot {
  const allModelList = flattenProviders(result.models.providers)
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
  const defaults = resolveExecutionDialogDefaults(pluginConfig, result.preferences, overrides)

  return {
    preferences: result.preferences,
    models: sorted,
    modelsError: result.models.error,
    connectedProviderIds: result.models.connectedProviderIds || [],
    configuredProviderIds: result.models.configuredProviderIds || [],
    recents,
    openCodeDefault: result.openCodeDefault ?? '',
    loopDefaults: result.loopDefaults ?? null,
    defaults,
  }
}

export interface ExecutionContextCache {
  snapshot(): ExecutionContextSnapshot | null
  refresh(): Promise<ExecutionContextSnapshot>
  ensureLoaded(): Promise<ExecutionContextSnapshot>
  recordRecent(modelFullName: string): void
  setSelectionOverride(override: ExecutionSelectionOverride): void
  onChange(listener: (snap: ExecutionContextSnapshot) => void): () => void
}

const RECENTS_CAP = 10

export function createExecutionContextCache(
  projectId: string,
  pluginConfig: PluginConfig,
  loadFn: () => Promise<ExecutionContext>,
): ExecutionContextCache {
  let currentSnapshot: ExecutionContextSnapshot | null = null
  let overrides: ExecutionSelectionOverride = {}
  let inFlightRefresh: Promise<ExecutionContextSnapshot> | null = null
  const listeners = new Set<(snap: ExecutionContextSnapshot) => void>()

  function notifyListeners() {
    if (currentSnapshot) {
      listeners.forEach(fn => fn(currentSnapshot!))
    }
  }

  async function refresh(): Promise<ExecutionContextSnapshot> {
    const result = await loadFn()
    currentSnapshot = buildExecutionContextSnapshot(projectId, pluginConfig, result, overrides)
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

  function setSelectionOverride(override: ExecutionSelectionOverride): void {
    overrides = { ...overrides, ...override }
    if (currentSnapshot) {
      currentSnapshot = {
        ...currentSnapshot,
        defaults: resolveExecutionDialogDefaults(pluginConfig, currentSnapshot.preferences, overrides),
      }
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
    setSelectionOverride,
    onChange,
  }
}
