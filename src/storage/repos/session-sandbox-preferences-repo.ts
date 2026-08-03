import type { Database } from 'bun:sqlite'

export const SESSION_SANDBOX_DESIRED_KEY = 'session-sandbox.desired'
export const SESSION_SANDBOX_APPLIED_KEY = 'session-sandbox.applied'
export const SESSION_SANDBOX_CONTROLLER_KEY = 'session-sandbox.controller'

export interface SessionSandboxDesiredState {
  version: 1
  revision: string
  enabled: boolean
  sessionId: string | null
  requestedAt: number
}

export interface SessionSandboxAppliedState {
  version: 1
  revision: string
  enabled: boolean
  sessionId: string | null
  error: string | null
  appliedAt: number
}

export interface SessionSandboxControllerState {
  version: 1
  phase: 'loading' | 'ready' | 'failed'
  revision: string | null
  sessionId: string | null
}

export interface SessionSandboxPreferencesRepo {
  getDesired(projectId: string): SessionSandboxDesiredState | null
  setDesired(projectId: string, state: SessionSandboxDesiredState): void
  getApplied(projectId: string): SessionSandboxAppliedState | null
  setApplied(projectId: string, state: SessionSandboxAppliedState): void
  getControllerState(projectId: string): SessionSandboxControllerState | null
  setControllerState(projectId: string, state: SessionSandboxControllerState): void
  getPair(projectId: string): SessionSandboxPreferencePair
}

export interface SessionSandboxPreferencePair {
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller: SessionSandboxControllerState | null
}

function parseDesired(data: unknown): SessionSandboxDesiredState | null {
  if (typeof data !== 'object' || data === null) return null
  const o = data as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.revision !== 'string' || o.revision.trim() === '') return null
  if (typeof o.enabled !== 'boolean') return null
  if (o.sessionId !== null && (typeof o.sessionId !== 'string' || o.sessionId.trim() === '')) return null
  if (typeof o.requestedAt !== 'number' || !Number.isFinite(o.requestedAt)) return null
  return {
    version: 1,
    revision: o.revision,
    enabled: o.enabled,
    sessionId: o.sessionId as string | null,
    requestedAt: o.requestedAt,
  }
}

function parseApplied(data: unknown): SessionSandboxAppliedState | null {
  if (typeof data !== 'object' || data === null) return null
  const o = data as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.revision !== 'string' || o.revision.trim() === '') return null
  if (typeof o.enabled !== 'boolean') return null
  if (o.sessionId !== null && (typeof o.sessionId !== 'string' || o.sessionId.trim() === '')) return null
  if (o.error !== null && typeof o.error !== 'string') return null
  if (typeof o.appliedAt !== 'number' || !Number.isFinite(o.appliedAt)) return null
  return {
    version: 1,
    revision: o.revision,
    enabled: o.enabled,
    sessionId: o.sessionId as string | null,
    error: o.error as string | null,
    appliedAt: o.appliedAt,
  }
}

function parseControllerState(data: unknown): SessionSandboxControllerState | null {
  if (typeof data !== 'object' || data === null) return null
  const o = data as Record<string, unknown>
  if (o.version !== 1) return null
  if (o.phase !== 'loading' && o.phase !== 'ready' && o.phase !== 'failed') return null
  if (o.revision !== null && (typeof o.revision !== 'string' || o.revision.trim() === '')) return null
  if (o.sessionId !== null && (typeof o.sessionId !== 'string' || o.sessionId.trim() === '')) return null
  return {
    version: 1,
    phase: o.phase,
    revision: o.revision as string | null,
    sessionId: o.sessionId as string | null,
  }
}

interface PreferenceRow {
  data: string
}

export function createSessionSandboxPreferencesRepo(db: Database): SessionSandboxPreferencesRepo {
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

  function readDesired(projectId: string): SessionSandboxDesiredState | null {
    return readState(projectId, SESSION_SANDBOX_DESIRED_KEY, parseDesired)
  }

  function readApplied(projectId: string): SessionSandboxAppliedState | null {
    return readState(projectId, SESSION_SANDBOX_APPLIED_KEY, parseApplied)
  }

  function readControllerState(projectId: string): SessionSandboxControllerState | null {
    return readState(projectId, SESSION_SANDBOX_CONTROLLER_KEY, parseControllerState)
  }

  return {
    getDesired: readDesired,

    setDesired(projectId: string, state: SessionSandboxDesiredState): void {
      const ts = now()
      upsertStmt.run(projectId, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(state), ts)
    },

    getApplied: readApplied,

    setApplied(projectId: string, state: SessionSandboxAppliedState): void {
      const ts = now()
      upsertStmt.run(projectId, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify(state), ts)
    },

    getControllerState: readControllerState,

    setControllerState(projectId: string, state: SessionSandboxControllerState): void {
      const ts = now()
      upsertStmt.run(projectId, SESSION_SANDBOX_CONTROLLER_KEY, JSON.stringify(state), ts)
    },

    getPair(projectId: string): SessionSandboxPreferencePair {
      // Reads run inside one transaction so they observe a single SQLite
      // snapshot. Without this, a concurrent desired write between the two
      // autocommit reads could assemble revisions from different snapshots and
      // briefly trust a superseded ON state.
      return db.transaction(() => {
        return { desired: readDesired(projectId), applied: readApplied(projectId), controller: readControllerState(projectId) }
      })()
    },
  }
}
