import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const enabledRowSchema = z.object({ enabled: z.number() })
const changeCountRowSchema = z.object({ count: z.number() })

export const SESSION_AUTO_APPROVE_KEY_PREFIX = 'session-auto-approve.'
export const SESSION_AUTO_APPROVE_TTL_MS = 15 * 24 * 60 * 60 * 1000

export interface SessionAutoApproveRepo {
  isEnabled(projectId: string, sessionId: string, now: number): boolean
  enable(projectId: string, sessionId: string, now: number): void
  disable(projectId: string, sessionId: string): void
  touch(projectId: string, sessionId: string, now: number): boolean
  purgeExpired(now: number): number
}

interface SessionAutoApproveState {
  version: 1
  sessionId: string
  enabledAt: number
}

function sessionKey(sessionId: string): string {
  return `${SESSION_AUTO_APPROVE_KEY_PREFIX}${sessionId}`
}

export function createSessionAutoApproveRepo(
  db: Database,
  ttlMs: number = SESSION_AUTO_APPROVE_TTL_MS,
): SessionAutoApproveRepo {
  const isEnabledStmt = db.prepare(`
    SELECT 1 AS enabled FROM tui_preferences
    WHERE project_id = ? AND key = ? AND expires_at > ?
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO tui_preferences (project_id, key, data, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET
      data = excluded.data,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `)

  const deleteStmt = db.prepare(`
    DELETE FROM tui_preferences
    WHERE project_id = ? AND key = ?
  `)

  const touchStmt = db.prepare(`
    UPDATE tui_preferences
    SET expires_at = ?, updated_at = ?
    WHERE project_id = ? AND key = ? AND expires_at > ?
  `)

  const purgeStmt = db.prepare(`
    DELETE FROM tui_preferences
    WHERE key LIKE '${SESSION_AUTO_APPROVE_KEY_PREFIX}%'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)

  const changesStmt = db.prepare('SELECT changes() AS count')

  return {
    isEnabled(projectId: string, sessionId: string, now: number): boolean {
      const row = enabledRowSchema.nullish().parse(isEnabledStmt.get(projectId, sessionKey(sessionId), now))
      return row !== null && row !== undefined
    },

    enable(projectId: string, sessionId: string, now: number): void {
      const state: SessionAutoApproveState = { version: 1, sessionId, enabledAt: now }
      upsertStmt.run(projectId, sessionKey(sessionId), JSON.stringify(state), now + ttlMs, now)
    },

    disable(projectId: string, sessionId: string): void {
      deleteStmt.run(projectId, sessionKey(sessionId))
    },

    touch(projectId: string, sessionId: string, now: number): boolean {
      touchStmt.run(now + ttlMs, now, projectId, sessionKey(sessionId), now)
      const result = changeCountRowSchema.parse(changesStmt.get())
      return result.count === 1
    },

    purgeExpired(now: number): number {
      purgeStmt.run(now)
      const result = changeCountRowSchema.parse(changesStmt.get())
      return result.count
    },
  }
}
