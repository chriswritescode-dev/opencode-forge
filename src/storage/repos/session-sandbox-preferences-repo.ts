import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  appliedStateSchema,
  controllerStateSchema,
  desiredStateSchema,
  type SessionSandboxAppliedState,
  type SessionSandboxControllerState,
  type SessionSandboxDesiredState,
  withoutSandboxSession,
} from '../session-sandbox-state'
import { runImmediateTransaction } from '../sqlite-open'

export type { SessionSandboxAppliedState, SessionSandboxControllerState, SessionSandboxDesiredState }

export const SESSION_SANDBOX_DESIRED_KEY = 'session-sandbox.desired'
export const SESSION_SANDBOX_APPLIED_KEY = 'session-sandbox.applied'
export const SESSION_SANDBOX_CONTROLLER_KEY = 'session-sandbox.controller'

const preferenceRowSchema = z.object({ data: z.string() })
const scopedPreferenceRowSchema = z.object({ project_id: z.string(), data: z.string() })

export interface SessionSandboxPreferencesRepo {
  getDesired(projectId: string): SessionSandboxDesiredState | null
  setDesired(projectId: string, state: SessionSandboxDesiredState): void
  updateDesired(
    projectId: string,
    build: (current: SessionSandboxDesiredState | null) => SessionSandboxDesiredState,
  ): SessionSandboxDesiredState
  moveDesiredSession(sessionId: string, toProjectId: string, revision: string): string[]
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

  const listDesiredElsewhereStmt = db.prepare(`
    SELECT project_id, data FROM tui_preferences
    WHERE key = ? AND project_id != ?
  `)

  const now = () => Date.now()

  function parseState<TSchema extends z.ZodType>(schema: TSchema, data: string): z.output<TSchema> | null {
    try {
      const parsed = schema.safeParse(JSON.parse(data))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  function readState<TSchema extends z.ZodType>(
    projectId: string,
    key: string,
    schema: TSchema,
  ): z.output<TSchema> | null {
    const row = preferenceRowSchema.nullish().parse(getStmt.get(projectId, key))
    if (!row) return null
    return parseState(schema, row.data)
  }

  function readDesired(projectId: string): SessionSandboxDesiredState | null {
    return readState(projectId, SESSION_SANDBOX_DESIRED_KEY, desiredStateSchema)
  }

  function readApplied(projectId: string): SessionSandboxAppliedState | null {
    return readState(projectId, SESSION_SANDBOX_APPLIED_KEY, appliedStateSchema)
  }

  function readControllerState(projectId: string): SessionSandboxControllerState | null {
    return readState(projectId, SESSION_SANDBOX_CONTROLLER_KEY, controllerStateSchema)
  }

  return {
    getDesired: readDesired,

    setDesired(projectId: string, state: SessionSandboxDesiredState): void {
      const ts = now()
      upsertStmt.run(projectId, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(state), ts)
    },

    updateDesired(projectId, build) {
      return runImmediateTransaction(db, () => {
        const next = build(readDesired(projectId))
        upsertStmt.run(projectId, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(next), now())
        return next
      })
    },

    moveDesiredSession(sessionId, toProjectId, revision) {
      return runImmediateTransaction(db, () => {
        const sources = scopedPreferenceRowSchema
          .array()
          .parse(listDesiredElsewhereStmt.all(SESSION_SANDBOX_DESIRED_KEY, toProjectId))
          .flatMap((row) => {
            const state = parseState(desiredStateSchema, row.data)
            if (!state || !Object.hasOwn(state.sessions, sessionId)) return []
            return [{ projectId: row.project_id, state }]
          })
        if (sources.length === 0) return []

        const newest = sources.reduce((best, source) => (source.state.requestedAt > best.state.requestedAt ? source : best))
        for (const source of sources) {
          const next = withoutSandboxSession(source.state, sessionId, revision)
          if (!next) continue
          upsertStmt.run(source.projectId, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(next), now())
        }

        const current = readDesired(toProjectId)
        const ts = now()
        const target: SessionSandboxDesiredState = {
          ...current,
          version: 2,
          revision,
          sessions: { ...current?.sessions, [sessionId]: newest.state.sessions[sessionId] },
          requestedAt: ts,
        }
        upsertStmt.run(toProjectId, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(target), ts)

        return [...sources.map((source) => source.projectId), toProjectId]
      })
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
      return db.transaction(() => {
        return { desired: readDesired(projectId), applied: readApplied(projectId), controller: readControllerState(projectId) }
      })()
    },
  }
}
