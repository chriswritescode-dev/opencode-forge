import type { Database } from 'bun:sqlite'

export const TUI_LOOP_RESTART_DESIRED_KEY = 'tui-loop-restart.desired'
export const TUI_LOOP_RESTART_APPLIED_KEY = 'tui-loop-restart.applied'

export interface TuiLoopRestartDesiredState {
  version: 1
  revision: string
  loopName: string
  auditorModel: string
  auditorVariant: string
  requestedAt: number
}

export interface TuiLoopRestartAppliedState {
  version: 1
  revision: string
  status: 'processing' | 'completed'
  ownerId: string | null
  sessionId: string | null
  error: string | null
  appliedAt: number
}

export interface TuiLoopRestartPair {
  desired: TuiLoopRestartDesiredState | null
  applied: TuiLoopRestartAppliedState | null
}

export interface TuiLoopRestartRepo {
  getDesired(projectId: string): TuiLoopRestartDesiredState | null
  setDesired(projectId: string, state: TuiLoopRestartDesiredState): void
  trySetDesired(projectId: string, state: TuiLoopRestartDesiredState): boolean
  getApplied(projectId: string): TuiLoopRestartAppliedState | null
  setApplied(projectId: string, state: TuiLoopRestartAppliedState): void
  claim(projectId: string, state: TuiLoopRestartAppliedState): boolean
  compareAndSetApplied(projectId: string, expected: TuiLoopRestartAppliedState, state: TuiLoopRestartAppliedState): boolean
  getPair(projectId: string): TuiLoopRestartPair
}

function requireNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function requireNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim() !== '')
}

function requireNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function requireFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseDesired(data: unknown): TuiLoopRestartDesiredState | null {
  if (typeof data !== 'object' || data === null) return null
  const o = data as Record<string, unknown>
  if (o.version !== 1) return null
  if (!requireNonEmptyString(o.revision)) return null
  if (!requireNonEmptyString(o.loopName)) return null
  if (!requireNonEmptyString(o.auditorModel)) return null
  if (typeof o.auditorVariant !== 'string') return null
  if (!requireFiniteNumber(o.requestedAt)) return null
  return {
    version: 1,
    revision: o.revision,
    loopName: o.loopName,
    auditorModel: o.auditorModel,
    auditorVariant: o.auditorVariant,
    requestedAt: o.requestedAt,
  }
}

function parseApplied(data: unknown): TuiLoopRestartAppliedState | null {
  if (typeof data !== 'object' || data === null) return null
  const o = data as Record<string, unknown>
  if (o.version !== 1) return null
  if (!requireNonEmptyString(o.revision)) return null
  if (o.status !== 'processing' && o.status !== 'completed') return null
  if (!requireNullableNonEmptyString(o.ownerId)) return null
  if (!requireNullableNonEmptyString(o.sessionId)) return null
  if (!requireNullableString(o.error)) return null
  if (!requireFiniteNumber(o.appliedAt)) return null
  if (o.status === 'processing' && (!o.ownerId || o.sessionId !== null || o.error !== null)) return null
  if (o.status === 'completed' && (o.ownerId !== null || (o.sessionId === null && o.error === null))) return null
  return {
    version: 1,
    revision: o.revision,
    status: o.status,
    ownerId: o.ownerId,
    sessionId: o.sessionId,
    error: o.error,
    appliedAt: o.appliedAt,
  }
}

interface PreferenceRow {
  data: string
}

export function createTuiLoopRestartRepo(db: Database): TuiLoopRestartRepo {
  const getStmt = db.prepare(`
    SELECT data FROM tui_preferences
    WHERE project_id = ? AND key = ?
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO tui_preferences (project_id, key, data, expires_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET
      data = excluded.data,
      expires_at = NULL,
      updated_at = excluded.updated_at
  `)

  const claimStmt = db.prepare(`
    INSERT INTO tui_preferences (project_id, key, data, expires_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET
      data = excluded.data,
      expires_at = NULL,
      updated_at = excluded.updated_at
    WHERE CASE
      WHEN json_valid(tui_preferences.data) THEN COALESCE(json_extract(tui_preferences.data, '$.revision'), '') <> ?
      ELSE 1
    END
  `)
  const changesStmt = db.prepare('SELECT changes() AS count')
  const compareAndSetStmt = db.prepare(`
    UPDATE tui_preferences
    SET data = ?, updated_at = ?
    WHERE project_id = ? AND key = ? AND data = ?
  `)

  const now = () => Date.now()

  function readState<T>(projectId: string, key: string, parse: (value: unknown) => T | null): T | null {
    const row = getStmt.get(projectId, key) as PreferenceRow | null
    if (!row) return null
    try {
      return parse(JSON.parse(row.data))
    } catch {
      return null
    }
  }

  function readDesired(projectId: string): TuiLoopRestartDesiredState | null {
    return readState(projectId, TUI_LOOP_RESTART_DESIRED_KEY, parseDesired)
  }

  function readApplied(projectId: string): TuiLoopRestartAppliedState | null {
    return readState(projectId, TUI_LOOP_RESTART_APPLIED_KEY, parseApplied)
  }

  return {
    getDesired: readDesired,

    setDesired(projectId: string, state: TuiLoopRestartDesiredState): void {
      const ts = now()
      upsertStmt.run(projectId, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify(state), ts)
    },

    trySetDesired(projectId: string, state: TuiLoopRestartDesiredState): boolean {
      return db.transaction(() => {
        const desired = readDesired(projectId)
        const applied = readApplied(projectId)
        if (desired && (!applied || applied.revision !== desired.revision || applied.status === 'processing')) return false
        const ts = now()
        upsertStmt.run(projectId, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify(state), ts)
        return true
      })()
    },

    getApplied: readApplied,

    setApplied(projectId: string, state: TuiLoopRestartAppliedState): void {
      const ts = now()
      upsertStmt.run(projectId, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify(state), ts)
    },

    claim(projectId: string, state: TuiLoopRestartAppliedState): boolean {
      claimStmt.run(projectId, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify(state), state.appliedAt, state.revision)
      const result = changesStmt.get() as { count: number }
      return result.count === 1
    },

    compareAndSetApplied(projectId: string, expected: TuiLoopRestartAppliedState, state: TuiLoopRestartAppliedState): boolean {
      compareAndSetStmt.run(JSON.stringify(state), state.appliedAt, projectId, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify(expected))
      const result = changesStmt.get() as { count: number }
      return result.count === 1
    },

    getPair(projectId: string): TuiLoopRestartPair {
      return db.transaction(() => {
        return { desired: readDesired(projectId), applied: readApplied(projectId) }
      })()
    },
  }
}
