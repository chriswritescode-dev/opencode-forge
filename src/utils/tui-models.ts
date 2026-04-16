/**
 * TUI model selection helpers for fetching and managing available models.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'

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
  error?: string
}

/**
 * Fetches all available providers and their models from the OpenCode API.
 * Returns a structured result that distinguishes between:
 * - Successful fetch with providers (may be empty if no providers have models)
 * - Failed fetch with an error message
 */
export async function fetchAvailableModels(api: TuiPluginApi): Promise<FetchModelsResult> {
  try {
    const directory = api.state.path.directory
    const result = await api.client.provider.list({ directory })
    
    if (result.error) {
      const errorMsg = (result.error as { message?: string })?.message || 'Failed to fetch providers'
      return { providers: [], error: errorMsg }
    }
    
    if (!result.data) {
      return { providers: [], error: 'No provider data returned' }
    }
    
    const providers: ProviderInfo[] = []
    const allModels = result.data.all || []
    
    for (const provider of allModels) {
      const models: ModelInfo[] = []
      
      if (provider.models) {
        for (const modelData of Object.values(provider.models)) {
          models.push({
            id: modelData.id,
            name: modelData.name,
            providerID: provider.id,
            providerName: provider.name,
            fullName: `${provider.id}/${modelData.id}`,
            releaseDate: (modelData as { release_date?: string }).release_date,
            capabilities: {
              temperature: modelData.capabilities?.temperature,
              toolcall: modelData.capabilities?.toolcall,
              reasoning: modelData.capabilities?.reasoning,
              attachment: modelData.capabilities?.attachment,
            },
            cost: modelData.cost,
          })
        }
      }
      
      providers.push({
        id: provider.id,
        name: provider.name,
        models,
      })
    }
    
    return { providers }
  } catch (err) {
    return { 
      providers: [], 
      error: err instanceof Error ? err.message : 'Failed to fetch providers' 
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
  // Sort alphabetically by name (favorites/recents not used here)
  return sortModelsByPriority(allModels, [], [])
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
 * Builds DialogSelect-compatible options with Favorites and Recent sections
 * at the top, followed by all models grouped by provider.
 */
export function buildDialogSelectOptions(
  models: ModelInfo[],
  favorites: string[] = [],
  recents: string[] = [],
): Array<{ title: string; value: string; description?: string; category?: string }> {
  const defaultOption = {
    title: 'Use default',
    value: '',
    description: 'Use config default model',
  }

  const modelMap = new Map(models.map(m => [m.fullName, m]))
  const usedInSections = new Set<string>()

  const favoriteOptions = favorites
    .map(fn => modelMap.get(fn))
    .filter((m): m is ModelInfo => !!m)
    .map(m => {
      usedInSections.add(m.fullName)
      return {
        title: m.name,
        value: m.fullName,
        description: m.providerName,
        category: 'Favorites',
      }
    })

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

  const providerOptions = models
    .filter(m => !usedInSections.has(m.fullName))
    .map(m => ({
      title: m.name,
      value: m.fullName,
      description: m.capabilities?.reasoning ? 'Reasoning' : undefined,
      category: m.providerName,
    }))

  return [defaultOption, ...favoriteOptions, ...recentOptions, ...providerOptions]
}

/**
 * Returns a display label for a model value.
 * Shows the model name if found, "default" if empty, or the raw value as fallback.
 */
export function getModelDisplayLabel(value: string, models: ModelInfo[]): string {
  if (!value) return 'default'
  const model = models.find(m => m.fullName === value)
  return model ? model.name : value
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
 * Gets recently used models from project KV.
 */
export function getRecentModels(projectId: string, dbPathOverride?: string): string[] {
  const dbPath = dbPathOverride || getDbPath()
  if (!existsSync(dbPath)) return []

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    const row = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?'
    ).get(projectId, RECENT_MODELS_KEY, now) as { data: string } | null

    if (!row) return []
    const parsed = JSON.parse(row.data)
    return Array.isArray(parsed) ? parsed : []
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
    const now = Date.now()

    const existing = getRecentModels(projectId, dbPath)
    const updated = [modelFullName, ...existing.filter(m => m !== modelFullName)].slice(0, RECENT_MODELS_MAX)

    db.prepare(
      'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(projectId, RECENT_MODELS_KEY, JSON.stringify(updated), now + RECENT_MODELS_TTL_MS, now, now)
  } catch {
    // silent
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Gets favorite/pinned models from plugin config.
 */
export function getFavoriteModels(config?: { favoriteModels?: string[] }): string[] {
  return config?.favoriteModels ?? []
}

/**
 * Sorts models by priority: favorites first, then recent, then alphabetically.
 */
export function sortModelsByPriority(
  models: ModelInfo[],
  favorites: string[],
  recents: string[]
): ModelInfo[] {
  const favoriteSet = new Set(favorites)
  const recentSet = new Set(recents)
  
  return models.sort((a, b) => {
    const aIsFavorite = favoriteSet.has(a.fullName)
    const bIsFavorite = favoriteSet.has(b.fullName)
    const aIsRecent = recentSet.has(a.fullName)
    const bIsRecent = recentSet.has(b.fullName)
    
    // Favorites first
    if (aIsFavorite && !bIsFavorite) return -1
    if (!aIsFavorite && bIsFavorite) return 1
    
    // Then recent
    if (aIsRecent && !bIsRecent) return -1
    if (!aIsRecent && bIsRecent) return 1
    
    // Then alphabetically by name
    return a.name.localeCompare(b.name)
  })
}
