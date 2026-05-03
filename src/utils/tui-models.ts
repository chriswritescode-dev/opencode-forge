/**
 * TUI model selection helpers for fetching and managing available models.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir, createTuiPrefsRepo } from '../storage'

export interface ModelKey {
  providerID: string
  modelID: string
}

export interface ModelInfo {
  id: string
  name: string
  providerID: string
  providerName: string
  fullName: string // e.g., "anthropic/claude-sonnet-4-20250514"
  releaseDate?: string
  capabilities?: {
    temperature?: boolean
    toolcall?: boolean
    reasoning?: boolean
    attachment?: boolean
  }
  cost?: {
    input?: number
    output?: number
  }
}

export interface ProviderInfo {
  id: string
  name: string
  models: ModelInfo[]
}

/**
 * Result of fetching available models, distinguishing success from failure.
 */
export interface FetchModelsResult {
  providers: ProviderInfo[]
  connectedProviderIds: string[]
  configuredProviderIds: string[]
  favoriteModels: string[]
  error?: string
}

export interface ModelSortOptions {
  recents?: string[]
  connectedProviderIds?: string[]
  configuredProviderIds?: string[]
}

/**
 * Converts a ModelKey to its full name representation.
 */
export function toFullModelName(key: ModelKey): string {
  return `${key.providerID}/${key.modelID}`
}

/**
 * Normalizes an unknown input to a ModelKey if possible.
 * Returns null for malformed values.
 */
export function normalizeModelKey(input: unknown): ModelKey | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  if (typeof obj.providerID !== 'string' || typeof obj.modelID !== 'string') return null
  return { providerID: obj.providerID, modelID: obj.modelID }
}

/**
 * Reads favorite models from OpenCode TUI state if exposed.
 * Probes multiple possible state shapes defensively.
 * Returns full model names (provider/model).
 */
export function readOpenCodeFavoriteModels(api: TuiPluginApi): string[] {
  const state = api.state as Record<string, unknown>
  
  // Probe supported shapes in order
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stateAny = state as any
  const candidates = [
    stateAny?.local?.model?.favorite,
    stateAny?.model?.favorite,
    stateAny?.models?.favorite,
  ]
  
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const normalized = candidate.map(normalizeModelKey).filter((k): k is ModelKey => k !== null)
      return normalized.map(toFullModelName)
    }
    if (typeof candidate === 'function') {
      try {
        const result = candidate()
        if (Array.isArray(result)) {
          const normalized = result.map(normalizeModelKey).filter((k): k is ModelKey => k !== null)
          return normalized.map(toFullModelName)
        }
      } catch {
        // ignore
      }
    }
  }
  
  return []
}

/**
 * Fetches all available providers and their models from the OpenCode API.
 * Returns a structured result that distinguishes between:
 * - Successful fetch with providers (may be empty if no providers have models)
 * - Failed fetch with an error message
 */
export async function fetchAvailableModels(api: TuiPluginApi): Promise<FetchModelsResult> {
  const directory = api.state.path.directory
  const configuredProviderIds = Object.keys(api.state.config?.provider ?? {})
  const favoriteModels = readOpenCodeFavoriteModels(api)
  try {
    const result = await api.client.provider.list({ directory })
    if (result.error) {
      const errorMsg =
        (result.error as { data?: { message?: string }; message?: string })?.data?.message
        ?? (result.error as { message?: string })?.message
        ?? 'Failed to fetch providers'
      return { providers: [], connectedProviderIds: [], configuredProviderIds, favoriteModels, error: errorMsg }
    }
    if (!result.data) {
      return { providers: [], connectedProviderIds: [], configuredProviderIds, favoriteModels, error: 'No provider data returned' }
    }
    const providers: ProviderInfo[] = []
    const allModels = result.data.all || []
    const connected = result.data.connected || []
    for (const provider of allModels) {
      if (!connected.includes(provider.id)) continue
      const models: ModelInfo[] = []
      if (provider.models) {
        for (const modelData of Object.values(provider.models)) {
          const md = modelData as Record<string, unknown>
          models.push({
            id: md.id as string,
            name: md.name as string,
            providerID: provider.id,
            providerName: provider.name,
            fullName: `${provider.id}/${md.id as string}`,
            releaseDate: (md as { release_date?: string }).release_date,
            capabilities: {
              temperature: (md.capabilities as Record<string, unknown> | undefined)?.temperature as boolean | undefined,
              toolcall: (md.capabilities as Record<string, unknown> | undefined)?.toolcall as boolean | undefined,
              reasoning: (md.capabilities as Record<string, unknown> | undefined)?.reasoning as boolean | undefined,
              attachment: (md.capabilities as Record<string, unknown> | undefined)?.attachment as boolean | undefined,
            },
            cost: md.cost as { input?: number; output?: number } | undefined,
          })
        }
      }
      providers.push({
        id: provider.id,
        name: provider.name,
        models,
      })
    }
    return { providers, connectedProviderIds: connected, configuredProviderIds, favoriteModels }
  } catch (err) {
    return {
      providers: [],
      connectedProviderIds: [],
      configuredProviderIds,
      favoriteModels,
      error: err instanceof Error ? err.message : 'Failed to fetch providers',
    }
  }
}

/**
 * Flattens providers into a single sorted list of models.
 * Uses sortModelsByPriority for ordering.
 */
export function flattenProviders(providers: ProviderInfo[]): ModelInfo[] {
  const allModels: ModelInfo[] = []
  for (const provider of providers) {
    allModels.push(...provider.models)
  }
  // Sort alphabetically by name (recents not used here)
  return sortModelsByPriority(allModels, {})
}

/**
 * Builds select options with a leading "Use default" entry.
 */
export function buildModelOptions(
  models: ModelInfo[]
): Array<{ name: string; value: string; description: string }> {
  const defaultOption = {
    name: 'Use default',
    value: '',
    description: 'Use config default model',
  }

  const modelOptions = models.map(m => ({
    name: m.name,
    value: m.fullName,
    description: `${m.providerName} - ${m.capabilities?.reasoning ? 'Reasoning, ' : ''}${m.capabilities?.toolcall ? 'Tools' : 'No tools'}`,
  }))

  return [defaultOption, ...modelOptions]
}

/**
 * Builds DialogSelect-compatible options with a Recent section
 * at the top, followed by all models grouped by provider.
 */
export function buildDialogSelectOptions(
  models: ModelInfo[],
  recents: string[] = [],
): Array<{ title: string; value: string; description?: string; category?: string }> {
  const defaultOption = {
    title: 'Use default',
    value: '',
    description: 'Use config default',
  }

  const modelMap = new Map(models.map(m => [m.fullName, m]))
  const usedInSections = new Set<string>()

  // Build recent options next
  const recentOptions = recents
    .filter(fn => !usedInSections.has(fn))
    .map(fn => modelMap.get(fn))
    .filter((m): m is ModelInfo => !!m)
    .map(m => {
      usedInSections.add(m.fullName)
      return {
        title: m.name,
        value: m.fullName,
        description: m.providerName,
        category: 'Recent',
      }
    })

  // Build provider options last (excluding usedInSections)
  const providerOptions = models
    .filter(m => !usedInSections.has(m.fullName))
    .map(m => ({
      title: m.name,
      value: m.fullName,
      description: m.capabilities?.reasoning ? 'Reasoning' : undefined,
      category: m.providerName,
    }))

  return [defaultOption, ...recentOptions, ...providerOptions]
}

/**
 * Returns a display label for a model value.
 * Shows the model name if found, "default" if empty (no fallback), or the raw value as fallback.
 * If `value` is empty and `fallbackFullName` is provided, attempts to resolve the fallback's display name.
 */
export function getModelDisplayLabel(
  value: string,
  models: ModelInfo[],
  fallbackFullName?: string,
): string {
  if (value) {
    const model = models.find(m => m.fullName === value)
    return model ? model.name : value
  }
  if (fallbackFullName) {
    const fallbackModel = models.find(m => m.fullName === fallbackFullName)
    return fallbackModel ? fallbackModel.name : fallbackFullName
  }
  return 'default'
}

/**
 * Resolves the selected index for a select component.
 * Returns the index of the matching model, or 0 (Use default) if not found.
 */
export function resolveModelSelectedIndex(
  options: Array<{ value: string }>,
  selectedValue: string | undefined
): number {
  if (!selectedValue) {
    return 0 // Default to "Use default"
  }
  
  const index = options.findIndex(opt => opt.value === selectedValue)
  return index >= 0 ? index : 0 // Fall back to "Use default" if not found
}

const RECENT_MODELS_KEY = 'tui:model-recents'
const RECENT_MODELS_MAX = 10
const RECENT_MODELS_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Gets recently used models from TUI preferences.
 */
export function getRecentModels(projectId: string, dbPathOverride?: string): string[] {
  const dbPath = dbPathOverride || getDbPath()
  if (!existsSync(dbPath)) return []

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const repo = createTuiPrefsRepo(db)
    const stored = repo.get<string[]>(projectId, RECENT_MODELS_KEY)
    return stored && Array.isArray(stored) ? stored : []
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Records a model as recently used. Pushes to front and deduplicates.
 */
export function recordRecentModel(projectId: string, modelFullName: string, dbPathOverride?: string): void {
  if (!modelFullName) return
  const dbPath = dbPathOverride || getDbPath()
  if (!existsSync(dbPath)) return

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    const repo = createTuiPrefsRepo(db)

    const existing = getRecentModels(projectId, dbPath)
    const updated = [modelFullName, ...existing.filter(m => m !== modelFullName)].slice(0, RECENT_MODELS_MAX)

    repo.set(projectId, RECENT_MODELS_KEY, updated, RECENT_MODELS_TTL_MS)
  } catch {
    // silent
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Sorts models by priority: recents first, then by provider priority.
 * Returns a sorted copy without mutating the input array.
 */
export function sortModelsByPriority(
  models: ModelInfo[],
  options: ModelSortOptions = {}
): ModelInfo[] {
  const recentSet = new Set(options.recents ?? [])
  const connectedProviderSet = new Set(options.connectedProviderIds ?? [])
  const configuredProviderSet = new Set(options.configuredProviderIds ?? [])

  const sortable = [...models]

  const getProviderPriority = (model: ModelInfo) => {
    if (connectedProviderSet.has(model.providerID)) return 0
    if (configuredProviderSet.has(model.providerID)) return 1
    return 2
  }
  
  return sortable.sort((a, b) => {
    const aIsRecent = recentSet.has(a.fullName)
    const bIsRecent = recentSet.has(b.fullName)

    // Recents first
    if (aIsRecent && !bIsRecent) return -1
    if (!aIsRecent && bIsRecent) return 1

    // Then connected providers, then configured providers
    const providerPriorityDiff = getProviderPriority(a) - getProviderPriority(b)
    if (providerPriorityDiff !== 0) return providerPriorityDiff

    // Then group providers alphabetically
    const providerNameDiff = a.providerName.localeCompare(b.providerName)
    if (providerNameDiff !== 0) return providerNameDiff
    
    // Then alphabetically by name
    return a.name.localeCompare(b.name)
  })
}
