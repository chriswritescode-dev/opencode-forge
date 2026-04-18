import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createTuiPrefsRepo } from '../src/storage/repos/tui-prefs-repo'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('TuiPrefsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createTuiPrefsRepo>
  let dbPath: string
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tui-prefs-test-'))
    dbPath = join(tempDir, 'tui-prefs-test.db')
    db = new Database(dbPath)

    // Create the table
    db.run(`
      CREATE TABLE IF NOT EXISTS tui_preferences (
        project_id   TEXT NOT NULL,
        key          TEXT NOT NULL,
        data         TEXT NOT NULL,
        expires_at   INTEGER,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, key)
      )
    `)

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_tui_preferences_expires_at
        ON tui_preferences(expires_at) WHERE expires_at IS NOT NULL
    `)

    repo = createTuiPrefsRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  test('set and get roundtrip', () => {
    const projectId = 'test-project'
    const key = 'test:key'
    const value = { foo: 'bar', num: 42 }

    repo.set(projectId, key, value)
    const result = repo.get<typeof value>(projectId, key)

    expect(result).toEqual(value)
  })

  test('expired entries return null', () => {
    const projectId = 'test-project'
    const key = 'test:expired'
    const value = ['expired', 'data']
    const ttlMs = 100 // 100ms TTL

    repo.set(projectId, key, value, ttlMs)

    // Should exist immediately
    expect(repo.get(projectId, key)).toEqual(value)

    // Wait for expiration
    const start = Date.now()
    while (Date.now() - start < 150) {
      // busy wait
    }

    // Should be null after expiration
    expect(repo.get(projectId, key)).toBeNull()
  })

  test('unbounded TTL (expires_at = null) returns forever', () => {
    const projectId = 'test-project'
    const key = 'test:unbounded'
    const value = ['never', 'expires']

    // No TTL means expires_at is null
    repo.set(projectId, key, value)

    // Should still exist after "waiting"
    expect(repo.get(projectId, key)).toEqual(value)
  })

  test('overwrite via set updates value and updated_at', () => {
    const projectId = 'test-project'
    const key = 'test:overwrite'
    const value1 = { version: 1 }
    const value2 = { version: 2 }

    repo.set(projectId, key, value1)
    const row1 = db.prepare('SELECT updated_at FROM tui_preferences WHERE project_id = ? AND key = ?')
      .get(projectId, key) as { updated_at: number }

    // Small delay to ensure timestamp difference
    const start = Date.now()
    while (Date.now() - start < 10) {
      // busy wait
    }

    repo.set(projectId, key, value2)
    const row2 = db.prepare('SELECT data, updated_at FROM tui_preferences WHERE project_id = ? AND key = ?')
      .get(projectId, key) as { data: string; updated_at: number }

    expect(JSON.parse(row2.data)).toEqual(value2)
    expect(row2.updated_at).toBeGreaterThan(row1.updated_at)
  })

  test('malformed JSON returns null', () => {
    const projectId = 'test-project'
    const key = 'test:malformed'

    // Insert malformed JSON directly
    db.prepare('INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, key, 'not valid json', null, Date.now())

    expect(repo.get(projectId, key)).toBeNull()
  })

  test('cross-project isolation', () => {
    const key = 'test:shared-key'
    const value1 = ['project', 'one']
    const value2 = ['project', 'two']

    repo.set('project-1', key, value1)
    repo.set('project-2', key, value2)

    expect(repo.get('project-1', key)).toEqual(value1)
    expect(repo.get('project-2', key)).toEqual(value2)
  })
})
