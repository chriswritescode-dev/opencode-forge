import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createSessionAutoApproveRepo,
  SESSION_AUTO_APPROVE_KEY_PREFIX,
  SESSION_AUTO_APPROVE_TTL_MS,
  SESSION_SANDBOX_DESIRED_KEY,
} from '../src/storage'
import { setupLoopsTestDb } from './helpers/loops-test-db'

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'
const SESSION_1 = 'sess-1'
const SESSION_2 = 'sess-2'

const TTL = SESSION_AUTO_APPROVE_TTL_MS

describe('SessionAutoApproveRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createSessionAutoApproveRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-auto-approve-repo-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)
    setupLoopsTestDb(db)
    repo = createSessionAutoApproveRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  function insertRaw(projectId: string, key: string, expiresAt: number | null, data = '{}'): void {
    db.run(
      'INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      key,
      data,
      expiresAt,
      Date.now(),
    )
  }

  function rowCount(projectId: string, key: string): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM tui_preferences WHERE project_id = ? AND key = ?').get(projectId, key) as { count: number }
    return row.count
  }

  test('enable makes isEnabled true', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000)).toBe(true)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000 + TTL - 1)).toBe(true)
  })

  test('other session or project is not enabled', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    expect(repo.isEnabled(PROJECT_A, SESSION_2, 1000)).toBe(false)
    expect(repo.isEnabled(PROJECT_B, SESSION_1, 1000)).toBe(false)
  })

  test('disable removes the flag', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    repo.disable(PROJECT_A, SESSION_1)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000)).toBe(false)
    expect(rowCount(PROJECT_A, `${SESSION_AUTO_APPROVE_KEY_PREFIX}${SESSION_1}`)).toBe(0)
  })

  test('an expired row reads as disabled', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000 + TTL)).toBe(false)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000 + TTL + 1)).toBe(false)
  })

  test('touch extends a live row and reports true', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    const touchedAt = 1000 + TTL - 1
    expect(repo.touch(PROJECT_A, SESSION_1, touchedAt)).toBe(true)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, 1000 + TTL + 1)).toBe(true)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, touchedAt + TTL - 1)).toBe(true)
  })

  test('touch on an expired row reports false and never revives it', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    const pastExpiry = 1000 + TTL + 1
    expect(repo.touch(PROJECT_A, SESSION_1, pastExpiry)).toBe(false)
    expect(repo.isEnabled(PROJECT_A, SESSION_1, pastExpiry)).toBe(false)
  })

  test('touch on a missing row reports false', () => {
    expect(repo.touch(PROJECT_A, SESSION_1, 1000)).toBe(false)
  })

  test('purgeExpired removes only expired auto-approve rows', () => {
    repo.enable(PROJECT_A, SESSION_1, 1000)
    repo.enable(PROJECT_A, SESSION_2, 1000 + TTL)

    insertRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, null, '{"version":1}')
    insertRaw(PROJECT_A, 'session-sandbox.other', 0, '{"version":1}')

    const removed = repo.purgeExpired(1000 + TTL)

    expect(removed).toBe(1)
    expect(rowCount(PROJECT_A, `${SESSION_AUTO_APPROVE_KEY_PREFIX}${SESSION_1}`)).toBe(0)
    expect(repo.isEnabled(PROJECT_A, SESSION_2, 1000 + TTL)).toBe(true)
    expect(rowCount(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY)).toBe(1)
    expect(rowCount(PROJECT_A, 'session-sandbox.other')).toBe(1)
  })
})
