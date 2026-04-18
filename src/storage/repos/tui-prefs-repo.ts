import type { Database } from 'bun:sqlite'

export interface TuiPrefsRepo {
  get<T>(projectId: string, key: string): T | null
  set<T>(projectId: string, key: string, value: T, ttlMs?: number): void
}

/**
 * Creates a TuiPrefsRepo instance for managing TUI preferences.
 * 
 * @param db - The database instance
 * @returns A TuiPrefsRepo with get/set methods
 */
export function createTuiPrefsRepo(db: Database): TuiPrefsRepo {
  const getStmt = db.prepare(`
    SELECT data FROM tui_preferences
    WHERE project_id = ? AND key = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `)

  const setStmt = db.prepare(`
    INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  return {
    get<T>(projectId: string, key: string): T | null {
      const now = Date.now()
      const row = getStmt.get(projectId, key, now) as { data: string } | null

      if (!row) return null

      try {
        return JSON.parse(row.data) as T
      } catch {
        return null
      }
    },

    set<T>(projectId: string, key: string, value: T, ttlMs?: number): void {
      const now = Date.now()
      const expiresAt = ttlMs !== undefined ? now + ttlMs : null

      setStmt.run(
        projectId,
        key,
        JSON.stringify(value),
        expiresAt,
        now
      )
    },
  }
}
