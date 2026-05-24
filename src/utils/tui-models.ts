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
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>
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
}export type LoopInfo = {
  name: string
  phase: string
  iteration: number
  maxIterations: number
  sessionId: string
  active: boolean
  startedAt?: string
  completedAt?: string
  terminationReason?: string
  worktreeBranch?: string
  worktree?: boolean
  worktreeDir?: string
  executionModel?: string
  auditorModel?: string
  workspaceId?: string
  hostSessionId?: string
  currentSectionIndex?: number
  totalSections?: number
  sections?: Array<{
    index: number
    title: string
    status: string
    attempts: number
    startedAt?: number | null
    completedAt?: number | null
    summaryDone: string | null
    summaryDeviations: string | null
    summaryFollowUps: string | null
  }>
  finalAuditDone?: boolean
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
            variants: md.variants as ModelInfo['variants'],
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

const RECENT_MODELS_KEY = 'tui:model-recents'
const RECENT_MODELS_MAX = 10
const RECENT_MODELS_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

function getDbPath(): string {
  return join(resolveDataDir(), 'forge.db')
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
 * Loose shape used by {@link deriveRecentModelsFromWorkspaces}. Matches the
 * relevant subset of `Workspace` from `@opencode-ai/sdk/v2`, plus the Forge
 * `extra.forgeLoop.{executionModel,auditorModel}` envelope written by
 * `tui-client.ts` when starting a loop.
 *
 * Kept structural (not nominal) so the same helper can consume either:
 * - the raw response of `client.experimental.workspace.list()`, or
 * - a hand-crafted fixture in tests.
 */
export interface WorkspaceForRecents {
  type: string
  projectID?: string
  timeUsed?: number | string
  extra?: unknown | null
}

/**
 * Pulls recent model fullnames (`provider/model`) out of the most recent Forge
 * workspaces for `projectId`. Replaces the SQLite-backed `getRecentModels`
 * read path for remote-server topologies: every loop creates a workspace whose
 * `extra.forgeLoop` already carries the user's chosen models, so the server's
 * `workspace.list` response is the canonical source.
 *
 * Behaviour:
 * - Only `type === 'forge'` workspaces are considered.
 * - If a workspace has `projectID` set, it must match `projectId` (other
 *   projects' selections never leak in). Workspaces without `projectID` are
 *   not filtered out (forward-compat with older entries).
 * - Workspaces are sorted by `timeUsed` descending; non-finite values
 *   (`"NaN"`, `"Infinity"`, missing) sort to the bottom (treated as 0).
 * - Both `extra.forgeLoop.executionModel` and `extra.forgeLoop.auditorModel`
 *   are collected, preserving the existing dual-record behaviour from
 *   `recordRecentModel` (see `execute-plan-panel.tsx:324-325`).
 * - Within a single workspace, executionModel is recorded before auditorModel.
 * - Duplicates are dropped (first occurrence wins).
 * - Result is capped at `options.max ?? RECENT_MODELS_MAX` entries.
 */
export function deriveRecentModelsFromWorkspaces(
  projectId: string,
  workspaces: ReadonlyArray<WorkspaceForRecents>,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? RECENT_MODELS_MAX
  if (max <= 0) return []

  const toFiniteNumber = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : 0
  }

  const eligible = workspaces.filter((w) => {
    if (w.type !== 'forge') return false
    if (w.projectID !== undefined && w.projectID !== projectId) return false
    return true
  })

  const sorted = [...eligible].sort((a, b) => toFiniteNumber(b.timeUsed) - toFiniteNumber(a.timeUsed))

  const recents: string[] = []
  const seen = new Set<string>()

  const pushModel = (raw: unknown): boolean => {
    if (typeof raw !== 'string' || raw.length === 0) return false
    if (seen.has(raw)) return false
    seen.add(raw)
    recents.push(raw)
    return recents.length >= max
  }

  for (const ws of sorted) {
    const extra = ws.extra
    if (typeof extra !== 'object' || extra === null) continue
    const forgeLoop = (extra as { forgeLoop?: unknown }).forgeLoop
    if (typeof forgeLoop !== 'object' || forgeLoop === null) continue

    const exec = (forgeLoop as { executionModel?: unknown }).executionModel
    if (pushModel(exec)) return recents

    const audit = (forgeLoop as { auditorModel?: unknown }).auditorModel
    if (pushModel(audit)) return recents
  }

  return recents
}

/**
 * Loose shape matching the subset of `GlobalSession` / `Session` (from
 * `@opencode-ai/sdk/v2`) needed by {@link deriveRecentModels}. Sessions
 * carry the model the user picked the last time they prompted in that
 * session, so the server-side session list is the canonical "recent models
 * for this user" source (it covers every mode, not just Forge loops).
 */
export interface SessionForRecents {
  projectID: string
  model?: { providerID: string; id: string; variant?: string } | null
  time: { updated: number }
}

export interface DeriveRecentModelsInputs {
  /**
   * Sessions from `client.experimental.session.list(...)`. Already sorted
   * server-side by `time.updated` desc, but this helper re-sorts defensively.
   */
  sessions: ReadonlyArray<SessionForRecents>
  /**
   * Workspaces from `client.experimental.workspace.list()`. Only Forge
   * workspaces contribute, and they carry the auditor model separately from
   * the execution model — which is why this layer exists in addition to
   * sessions (sessions only ever store the execution model in `Session.model`).
   */
  workspaces: ReadonlyArray<WorkspaceForRecents>
  /**
   * Model fullnames the user has explicitly favorited in OpenCode, if the
   * TUI surfaces them. May be empty. See {@link readOpenCodeFavoriteModels}.
   */
  openCodeFavorites: ReadonlyArray<string>
  /**
   * The user's configured global default model (`api.state.config?.model`).
   * Surfaced last so it's always selectable from the "Recent" group even if
   * the user hasn't used it in any session yet.
   */
  openCodeDefault: string | undefined
}

/**
 * Composes the "Recent" list shown at the top of the model picker from every
 * remote-safe signal we have, in priority order:
 *
 *   1. Sessions for this project, sorted by `time.updated` desc
 *      (`session.model.providerID/session.model.id`)
 *   2. Forge workspaces for this project — picks up the *auditor* model,
 *      which never lands on `Session.model`
 *   3. OpenCode favorites (if any), in the order provided
 *   4. OpenCode global default, if not already present
 *
 * Dedupes across layers; first occurrence wins. Caps at `max`
 * (default `RECENT_MODELS_MAX`). Returns `[]` for `max <= 0`.
 *
 * This is the read replacement for the SQLite-backed `getRecentModels`.
 * All four inputs are remote-safe: sessions and workspaces come from the
 * server via the OpenCode SDK; favorites and default come from `api.state`
 * which the TUI plugin already has synced.
 */
export function deriveRecentModels(
  projectId: string,
  inputs: DeriveRecentModelsInputs,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? RECENT_MODELS_MAX
  if (max <= 0) return []

  const recents: string[] = []
  const seen = new Set<string>()

  const tryPush = (fullname: unknown): boolean => {
    if (typeof fullname !== 'string' || fullname.length === 0) return false
    if (seen.has(fullname)) return false
    seen.add(fullname)
    recents.push(fullname)
    return recents.length >= max
  }

  const toFiniteNumber = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : 0
  }

  // 1. Sessions for this project, sorted by time.updated desc.
  const sessionsForProject = inputs.sessions
    .filter((s) => s.projectID === projectId && s.model)
    .sort((a, b) => toFiniteNumber(b.time?.updated) - toFiniteNumber(a.time?.updated))

  for (const session of sessionsForProject) {
    const model = session.model
    if (!model || typeof model.providerID !== 'string' || typeof model.id !== 'string') continue
    if (model.providerID.length === 0 || model.id.length === 0) continue
    if (tryPush(`${model.providerID}/${model.id}`)) return recents
  }

  // 2. Workspaces — primarily for the auditor model, which doesn't appear in sessions.
  for (const fullname of deriveRecentModelsFromWorkspaces(projectId, inputs.workspaces, { max })) {
    if (tryPush(fullname)) return recents
  }

  // 3. OpenCode favorites, in the order provided.
  for (const fullname of inputs.openCodeFavorites) {
    if (tryPush(fullname)) return recents
  }

  // 4. Global default, last.
  tryPush(inputs.openCodeDefault)

  return recents
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

export interface ModelVariantInfo {
  id: string
  label: string
  description?: string
}

/**
 * Converts a raw variant key into a human-readable label.
 * E.g., "thinking-max" → "Thinking Max", "reasoning_high" → "Reasoning High"
 */
function variantKeyToLabel(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Generates a description from variant config when applicable.
 * Returns undefined when no relevant field is present.
 */
function variantDescription(config: Record<string, unknown>): string | undefined {
  if (typeof config.description === 'string') return config.description

  const reasoning = config.reasoningEffort ?? config.reasoning_effort
  if (reasoning != null) return `Reasoning: ${reasoning}`

  const thinking = config.thinking
  if (thinking != null) return `Thinking: ${thinking}`

  const budget = config.thinkingBudget ?? config.thinking_budget
  if (budget != null) return `Thinking budget: ${budget}`

  return undefined
}

export function getAvailableModelVariants(model?: ModelInfo | null): ModelVariantInfo[] {
  if (!model?.variants) return []

  return Object.entries(model.variants)
    .filter(([, cfg]) => cfg && !cfg.disabled)
    .map(([key, cfg]) => ({
      id: key,
      label: typeof cfg.name === 'string' ? cfg.name : variantKeyToLabel(key),
      description: variantDescription(cfg as Record<string, unknown>),
    }))
}

export function getVariantDisplayLabel(
  variant: string | undefined,
  model?: ModelInfo | null,
): string {
  if (!variant) return 'default'

  const available = getAvailableModelVariants(model)
  const found = available.find(v => v.id === variant)
  if (found) return found.label

  return variant
}

export function normalizeVariantForModel(
  variant: string | undefined,
  model?: ModelInfo | null,
): string {
  if (!variant) return ''
  if (!model?.variants) return ''

  const available = getAvailableModelVariants(model)
  return available.some(v => v.id === variant) ? variant : ''
}
