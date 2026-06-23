import { openOpencodeDbReadonly } from './opencode-db'
import { createOpencodeSessionsRepo } from './opencode-sessions-repo'
import type { OpencodeSessionRow, TranscriptEntry } from './types'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OpencodeDataSource {
  /** Whether the underlying opencode DB was opened successfully. */
  readonly available: boolean

  /** List recent sessions, newest first. Returns [] when unavailable. */
  listRecentSessions(limit?: number): OpencodeSessionRow[]

  /** Get transcript entries for a session. Returns [] when unavailable. */
  getSessionTranscript(sessionId: string, limit?: number): TranscriptEntry[]

  /** Release the database handle (no-op when unavailable). Idempotent. */
  close(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an `OpencodeDataSource` that wraps the opencode SQLite database.
 *
 * When the database cannot be opened (missing file, permissions, corruption)
 * the returned datasource reports `available: false` and all query methods
 * return empty arrays.  Query methods also catch errors internally so the
 * caller never needs to handle DB exceptions — useful when the live DB may
 * be mid-write.
 */
export function createOpencodeDataSource(opts?: { path?: string }): OpencodeDataSource {
  const db = openOpencodeDbReadonly(opts?.path)

  if (!db) {
    return {
      available: false,
      listRecentSessions: () => [],
      getSessionTranscript: () => [],
      close: () => {},
    }
  }

  const repo = createOpencodeSessionsRepo(db)

  return {
    available: true,
    listRecentSessions(limit?: number): OpencodeSessionRow[] {
      try {
        return repo.listRecentSessions(limit)
      } catch {
        return []
      }
    },
    getSessionTranscript(sessionId: string, limit?: number): TranscriptEntry[] {
      try {
        return repo.getSessionTranscript(sessionId, limit)
      } catch {
        return []
      }
    },
    close(): void {
      db.close()
    },
  }
}
