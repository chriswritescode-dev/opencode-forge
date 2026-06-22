import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { resolveOpencodeDbPath, openOpencodeDbReadonly } from '../../src/observability/opencode-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary SQLite fixture at `path` with a `session` table. */
function createFixtureDb(path: string, rows?: Array<Record<string, unknown>>): void {
  // Ensure parent directory exists
  const dir = path.split('/').slice(0, -1).join('/')
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new Database(path)
  db.run(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    title TEXT,
    directory TEXT,
    project_name TEXT,
    worktree TEXT,
    agent TEXT,
    model_id TEXT,
    provider_id TEXT,
    cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    time_created INTEGER,
    time_updated INTEGER
  )`)
  if (rows) {
    const insert = db.prepare(
      `INSERT INTO session (id, title, directory, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ($id, $title, $directory, $cost, $tokensInput, $tokensOutput,
        $tokensReasoning, $tokensCacheRead, $tokensCacheWrite)`
    )
    for (const row of rows) insert.run(row)
  }
  db.close()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveOpencodeDbPath', () => {
  const originalEnv = { ...process.env }
  const home = process.env['HOME'] || '/tmp'

  afterEach(() => {
    process.env['HOME'] = home
    if (originalEnv['XDG_DATA_HOME']) {
      process.env['XDG_DATA_HOME'] = originalEnv['XDG_DATA_HOME']
    } else {
      delete process.env['XDG_DATA_HOME']
    }
    delete process.env['OPENCODE_DB']
  })

  test('returns explicit path when provided', () => {
    const result = resolveOpencodeDbPath('/custom/path/db.sqlite')
    expect(result).toBe('/custom/path/db.sqlite')
  })

  test('honours OPENCODE_DB env var when no explicit path', () => {
    process.env['OPENCODE_DB'] = '/env/var/db.sqlite'
    const result = resolveOpencodeDbPath()
    expect(result).toBe('/env/var/db.sqlite')
  })

  test('explicit overrides OPENCODE_DB env var', () => {
    process.env['OPENCODE_DB'] = '/env/var/db.sqlite'
    const result = resolveOpencodeDbPath('/explicit/db.sqlite')
    expect(result).toBe('/explicit/db.sqlite')
  })

  test('falls back to XDG_DATA_HOME/opencode/opencode.db', () => {
    process.env['XDG_DATA_HOME'] = '/xdg-test'
    const result = resolveOpencodeDbPath()
    expect(result).toBe('/xdg-test/opencode/opencode.db')
  })

  test('falls back to ~/.local/share/opencode/opencode.db without XDG_DATA_HOME', () => {
    delete process.env['XDG_DATA_HOME']
    process.env['HOME'] = '/home/user'
    const result = resolveOpencodeDbPath()
    expect(result).toBe('/home/user/.local/share/opencode/opencode.db')
  })
})

describe('openOpencodeDbReadonly', () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = `/tmp/opencode-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  })

  afterEach(() => {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  })

  test('returns null for non-existent file', () => {
    const result = openOpencodeDbReadonly('/nonexistent/path/to/db.sqlite')
    expect(result).toBeNull()
  })

  test('returns Database handle that can SELECT from session table', () => {
    createFixtureDb(tmpPath)
    const db = openOpencodeDbReadonly(tmpPath)
    expect(db).not.toBeNull()

    const rows = db!.prepare('SELECT id, title FROM session').all()
    expect(rows).toEqual([])

    db!.close()
  })

  test('returns handle that rejects writes (readonly enforced by bun:sqlite)', () => {
    createFixtureDb(tmpPath)
    const db = openOpencodeDbReadonly(tmpPath)
    expect(db).not.toBeNull()

    expect(() => {
      db!.run('INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?, 0,0,0,0,0,0)', ['test-id'])
    }).toThrow()

    db!.close()
  })

  test('returns null for a path that does not exist on disk', () => {
    const result = openOpencodeDbReadonly(tmpPath)
    expect(result).toBeNull()
  })
})
