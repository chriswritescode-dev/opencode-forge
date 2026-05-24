/**
 * Execution preferences resolution for the TUI plan dialog defaults.
 *
 * Last-used preferences come from the most recent Forge workspace on the
 * OpenCode server: every loop execution stamps its model + variant choices
 * into `extra.forgeLoop`, so `workspace.list().extra.forgeLoop` is the
 * canonical source. This avoids a separate TUI-local SQLite store and works
 * correctly when the TUI is on a different host than the server.
 *
 * The mode (`New session` / `Execute here` / `Loop`) is **not** persisted
 * across hosts — only the Loop mode creates a workspace, so the derivation
 * can never observe a user choosing one of the other two modes. Mode falls
 * back to the config default in `resolveExecutionDialogDefaults`. If the
 * user wants per-host mode persistence, that's a TUI-local concern that
 * could move into `api.kv` later.
 */

import type { PluginConfig } from '../types'
import type { WorkspaceForRecents } from './tui-models'

export interface ExecutionPreferences {
  mode: 'New session' | 'Execute here' | 'Loop'
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
}

function normalizeMode(mode: string): ExecutionPreferences['mode'] {
  const lower = mode.toLowerCase()
  if (lower === 'loop' || lower.startsWith('loop ') || lower.startsWith('loop-')) {
    return 'Loop'
  }
  return mode as ExecutionPreferences['mode']
}

/**
 * Picks the most recent Forge workspace for `projectId` from `workspaces`
 * and projects its `extra.forgeLoop.{executionModel,auditorModel,executionVariant,auditorVariant}`
 * onto an {@link ExecutionPreferences} record. Returns `null` if no eligible
 * workspace exists or its `extra.forgeLoop` envelope is missing.
 *
 * `mode` is always `'Loop'` — only loop executions create a workspace, so
 * the derivation can never witness `'New session'` or `'Execute here'`.
 * Callers compose with {@link resolveExecutionDialogDefaults} which falls
 * back to config when this returns `null`.
 *
 * Workspaces with no `projectID` are not filtered out (forward-compat),
 * matching the policy in `deriveRecentModelsFromWorkspaces`.
 *
 * Workspaces with non-finite `timeUsed` (`"NaN"`, `"Infinity"`, missing)
 * are treated as `0` for sorting, so a legitimate workspace with a real
 * `timeUsed` always wins over them.
 */
export function deriveExecutionPreferencesFromWorkspaces(
  projectId: string,
  workspaces: ReadonlyArray<WorkspaceForRecents>,
): ExecutionPreferences | null {
  const toFiniteNumber = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : 0
  }

  const eligible = workspaces.filter((w) => {
    if (w.type !== 'forge') return false
    if (w.projectID !== undefined && w.projectID !== projectId) return false
    if (typeof w.extra !== 'object' || w.extra === null) return false
    const forgeLoop = (w.extra as { forgeLoop?: unknown }).forgeLoop
    return typeof forgeLoop === 'object' && forgeLoop !== null
  })

  if (eligible.length === 0) return null

  const mostRecent = eligible.reduce((best, current) =>
    toFiniteNumber(current.timeUsed) > toFiniteNumber(best.timeUsed) ? current : best,
  )

  const forgeLoop = (mostRecent.extra as { forgeLoop: Record<string, unknown> }).forgeLoop

  const readString = (key: string): string | undefined => {
    const raw = forgeLoop[key]
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }

  return {
    mode: 'Loop',
    executionModel: readString('executionModel'),
    auditorModel: readString('auditorModel'),
    executionVariant: readString('executionVariant'),
    auditorVariant: readString('auditorVariant'),
  }
}

/**
 * Resolves dialog defaults from last-used prefs first, then config fallbacks.
 * 
 * Priority order for executionModel:
 * 1. stored.executionModel
 * 2. config.executionModel
 * 
 * Priority order for auditorModel:
 * 1. stored.auditorModel
 * 2. config.auditorModel
 * 3. stored.executionModel
 * 4. config.executionModel
 * 
 * @param config - Plugin config
 * @param storedPrefs - Last-used preferences from KV
 * @returns Resolved defaults for dialog pre-fill
 */
export function resolveExecutionDialogDefaults(
  config: PluginConfig,
  storedPrefs: ExecutionPreferences | null
): { mode: string; executionModel: string; auditorModel: string; executionVariant: string; auditorVariant: string } {
  const mode = normalizeMode(storedPrefs?.mode ?? 'Loop')
  const executionModel = storedPrefs?.executionModel
    ?? config.executionModel
    ?? ''
  
  const auditorModel = storedPrefs?.auditorModel
    ?? config.auditorModel
    ?? storedPrefs?.executionModel
    ?? config.executionModel
    ?? ''

  const executionVariant = storedPrefs?.executionVariant ?? ''
  const auditorVariant = storedPrefs?.auditorVariant ?? ''
  
  return { mode, executionModel, auditorModel, executionVariant, auditorVariant }
}
