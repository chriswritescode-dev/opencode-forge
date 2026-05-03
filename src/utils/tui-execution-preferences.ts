/**
 * TUI execution preferences persistence for per-loop launch settings.
 * 
 * This module provides helpers to read/write last-used execution preferences
 * from project KV, used only for dialog defaults - not for runtime behavior.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir, createTuiPrefsRepo } from '../storage'
import type { PluginConfig } from '../types'

export interface ExecutionPreferences {
  mode: 'New session' | 'Execute here' | 'Loop (worktree)' | 'Loop'
  executionModel?: string
  auditorModel?: string
}

const PREFERENCES_KEY = 'tui:plan-execution-preferences'
const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Gets the database path used by the memory plugin.
 */
function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Reads last-used execution preferences from TUI preferences.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns The stored preferences or null if not found
 */
export function readExecutionPreferences(projectId: string, dbPathOverride?: string): ExecutionPreferences | null {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const repo = createTuiPrefsRepo(db)
    const stored = repo.get<ExecutionPreferences>(projectId, PREFERENCES_KEY)
    
    if (!stored) return null
    
    return {
      mode: stored.mode ?? 'Loop (worktree)',
      executionModel: stored.executionModel,
      auditorModel: stored.auditorModel,
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Writes execution preferences to TUI preferences after successful launch.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param prefs - The preferences to persist
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns true if successful, false otherwise
 */
export function writeExecutionPreferences(
  projectId: string,
  prefs: ExecutionPreferences,
  dbPathOverride?: string
): boolean {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return false

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    const repo = createTuiPrefsRepo(db)

    repo.set(projectId, PREFERENCES_KEY, prefs, TTL_MS)
    return true
  } catch {
    return false
  } finally {
    try { db?.close() } catch {}
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
): { mode: string; executionModel: string; auditorModel: string } {
  const mode = storedPrefs?.mode ?? 'Loop (worktree)'
  
  const executionModel = storedPrefs?.executionModel
    ?? config.executionModel
    ?? ''
  
  const auditorModel = storedPrefs?.auditorModel
    ?? config.auditorModel
    ?? storedPrefs?.executionModel
    ?? config.executionModel
    ?? ''
  
  return { mode, executionModel, auditorModel }
}
