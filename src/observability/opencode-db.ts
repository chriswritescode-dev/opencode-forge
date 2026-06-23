import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveOpencodeDataDir } from '../storage/database'

/**
 * Resolves the absolute path to the opencode SQLite database.
 *
 * Precedence:
 *   1. `explicit` argument (if provided)
 *   2. `OPENCODE_DB` environment variable
 *   3. `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`
 */
export function resolveOpencodeDbPath(explicit?: string): string {
  if (explicit) return explicit
  if (process.env['OPENCODE_DB']) return process.env['OPENCODE_DB']
  return join(resolveOpencodeDataDir(), 'opencode.db')
}

/**
 * Opens the opencode SQLite database in readonly mode.
 *
 * Returns `null` if the file does not exist or if opening fails for any
 * reason (e.g. corrupted database, permissions). No error is logged or
 * thrown — the caller is expected to handle the `null` case gracefully.
 *
 * The returned handle has a 5-second busy timeout set and will throw on
 * any write attempt because of `{ readonly: true }`.
 */
export function openOpencodeDbReadonly(path?: string): Database | null {
  const resolved = resolveOpencodeDbPath(path)
  if (!existsSync(resolved)) return null
  try {
    const db = new Database(resolved, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    return db
  } catch {
    return null
  }
}
