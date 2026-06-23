import type { Database } from 'bun:sqlite'
import { basename } from 'path'
import type { OpencodeSessionRow, TranscriptEntry } from './types'
import { mapTranscriptPartData } from './transcript-part'

// ---------------------------------------------------------------------------
// Raw row matching the snake_case columns of the session + project LEFT JOIN
// ---------------------------------------------------------------------------

interface SessionRowRaw {
  id: string
  title: string | null
  directory: string | null
  agent: string | null
  model: string | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  time_created: number | null
  time_updated: number | null
  project_name: string | null
  worktree: string | null
}

// ---------------------------------------------------------------------------
// Raw row matching the transcript query columns
// ---------------------------------------------------------------------------

interface TranscriptRowRaw {
  part_id: string
  message_id: string
  role: string | null
  model: string | null
  part_data: string
  time_created: number | null
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OpencodeSessionsRepo {
  listRecentSessions(limit?: number): OpencodeSessionRow[]
  getSessionTranscript(sessionId: string, limit?: number): TranscriptEntry[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse the `model` JSON column.
 *
 * The opencode app stores model info as JSON text:
 *   `{"id":"claude-opus-4-8","providerID":"anthropic"}`
 *
 * On parse failure the raw string is returned as `modelId` with a null
 * `providerId`.  A null/undefined input yields both as null.
 */
function parseModelJson(raw: string | null): { modelId: string | null; providerId: string | null } {
  if (!raw) return { modelId: null, providerId: null }
  try {
    const parsed = JSON.parse(raw)
    return {
      modelId: parsed.id ?? null,
      // The opencode app uses `providerID` (uppercase ID); handle both
      // casings defensively.
      providerId: parsed.providerID ?? parsed.providerId ?? null,
    }
  } catch {
    return { modelId: raw, providerId: null }
  }
}

/**
 * Clamp a limit to the range `[1, max]`, defaulting to `def` when
 * `limit` is undefined.
 */
function clampLimit(limit: number | undefined, max = 200, def = 50): number {
  if (limit === undefined) return def
  return Math.max(1, Math.min(max, Math.round(limit)))
}

/**
 * Map a raw transcript row to a TranscriptEntry, skipping malformed JSON
 * and unexpected part types.
 *
 * The `part.data` column is a JSON object with at least a `type` field
 * (`'text'` or `'tool'` for entries we care about). Non-text/tool parts
 * (e.g. `step-start`) are excluded by the SQL filter, but the shared
 * {@link mapTranscriptPartData} mapper also guards defensively.
 *
 * Malformed JSON rows (null, invalid syntax) are silently skipped rather
 * than propagating an error to the caller.
 */
function mapTranscriptRow(row: TranscriptRowRaw): TranscriptEntry | null {
  let data: unknown
  try {
    data = JSON.parse(row.part_data)
  } catch {
    return null
  }

  const fields = mapTranscriptPartData(data)
  if (!fields) return null

  return {
    partId: row.part_id,
    messageId: row.message_id,
    role: row.role,
    model: row.model,
    timeCreated: row.time_created,
    ...fields,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpencodeSessionsRepo(db: Database): OpencodeSessionsRepo {
  const stmtListRecent = db.prepare(`
    SELECT s.id, s.title, s.directory, s.agent, s.model,
           s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
           s.tokens_cache_read, s.tokens_cache_write,
           s.time_created, s.time_updated,
           p.name AS project_name, p.worktree AS worktree
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    ORDER BY s.time_updated DESC
    LIMIT ?
  `)

  const stmtTranscript = db.prepare(`
    SELECT part.id AS part_id,
           m.id AS message_id,
           json_extract(m.data, '$.role') AS role,
           json_extract(m.data, '$.modelID') AS model,
           part.data AS part_data,
           part.time_created AS time_created
    FROM part
    JOIN message m ON m.id = part.message_id
    WHERE part.session_id = ?
      AND json_valid(part.data) = 1
      AND json_extract(part.data, '$.type') IN ('text', 'tool')
    ORDER BY m.time_created ASC, part.time_created ASC, part.id ASC
    LIMIT ?
  `)

  function mapRow(row: SessionRowRaw): OpencodeSessionRow {
    const { modelId, providerId } = parseModelJson(row.model)
    return {
      id: row.id,
      title: row.title,
      directory: row.directory,
      // Fall back to the directory basename when the project name is NULL
      // (mirrors the opencode skill's display-name fallback).
      projectName: row.project_name ?? (row.directory ? basename(row.directory) : null),
      worktree: row.worktree,
      agent: row.agent,
      modelId,
      providerId,
      cost: row.cost ?? 0,
      tokensInput: row.tokens_input ?? 0,
      tokensOutput: row.tokens_output ?? 0,
      tokensReasoning: row.tokens_reasoning ?? 0,
      tokensCacheRead: row.tokens_cache_read ?? 0,
      tokensCacheWrite: row.tokens_cache_write ?? 0,
      timeCreated: row.time_created ?? null,
      timeUpdated: row.time_updated ?? null,
    }
  }

  function listRecentSessions(limit?: number): OpencodeSessionRow[] {
    const resolvedLimit = clampLimit(limit)
    return (stmtListRecent.all(resolvedLimit) as SessionRowRaw[]).map(mapRow)
  }

  function getSessionTranscript(sessionId: string, limit?: number): TranscriptEntry[] {
    const resolvedLimit = clampLimit(limit, 2000, 500)
    return (stmtTranscript.all(sessionId, resolvedLimit) as TranscriptRowRaw[])
      .map(mapTranscriptRow)
      .filter((e): e is TranscriptEntry => e !== null)
  }

  return { listRecentSessions, getSessionTranscript }
}
