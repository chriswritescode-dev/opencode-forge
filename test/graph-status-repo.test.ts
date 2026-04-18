import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createGraphStatusRepo, type GraphStatusRow } from '../src/storage'

const TEST_DIR = '/tmp/opencode-graph-status-repo-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_status (
      project_id   TEXT NOT NULL,
      cwd          TEXT NOT NULL DEFAULT '',
      state        TEXT NOT NULL,
      ready        INTEGER NOT NULL,
      stats_json   TEXT,
      message      TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, cwd)
    )
  `)
  return db
}

describe('GraphStatusRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createGraphStatusRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    repo = createGraphStatusRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('write', () => {
    test('writes unscoped status (cwd="")', () => {
      const now = Date.now()
      repo.write({
        projectId,
        cwd: '',
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 20, edges: 30, calls: 40 },
        message: null,
      })

      const row = repo.read(projectId, '')
      expect(row).toBeDefined()
      expect(row?.state).toBe('ready')
      expect(row?.ready).toBe(true)
      expect(row?.stats).toEqual({ files: 10, symbols: 20, edges: 30, calls: 40 })
      expect(row?.message).toBeNull()
      expect(row?.updatedAt).toBeGreaterThan(now - 1000)
    })

    test('writes scoped status', () => {
      const now = Date.now()
      const cwd = '/path/to/worktree'
      repo.write({
        projectId,
        cwd,
        state: 'indexing',
        ready: false,
        stats: null,
        message: 'Indexing in progress',
      })

      const row = repo.read(projectId, cwd)
      expect(row).toBeDefined()
      expect(row?.state).toBe('indexing')
      expect(row?.ready).toBe(false)
      expect(row?.stats).toBeNull()
      expect(row?.message).toBe('Indexing in progress')
      expect(row?.updatedAt).toBeGreaterThan(now - 1000)
    })

    test('upserts on repeated write', () => {
      const now = Date.now()
      repo.write({
        projectId,
        cwd: '',
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 20, edges: 30, calls: 40 },
        message: null,
      })

      // Wait a tiny bit to ensure updated_at changes
      const waitUntil = Date.now() + 10
      while (Date.now() < waitUntil) {} // busy wait

      repo.write({
        projectId,
        cwd: '',
        state: 'error',
        ready: false,
        stats: null,
        message: 'Something went wrong',
      })

      const row = repo.read(projectId, '')
      expect(row?.state).toBe('error')
      expect(row?.ready).toBe(false)
      expect(row?.message).toBe('Something went wrong')
      expect(row?.updatedAt).toBeGreaterThan(now)
    })

    test('serializes stats to JSON', () => {
      const stats = { files: 100, symbols: 200, edges: 300, calls: 400 }
      repo.write({
        projectId,
        cwd: '',
        state: 'ready',
        ready: true,
        stats,
        message: null,
      })

      const row = repo.read(projectId, '')
      expect(row?.stats).toEqual(stats)
    })

    test('handles all state values', () => {
      const states: Array<'unavailable' | 'initializing' | 'indexing' | 'ready' | 'error'> = [
        'unavailable',
        'initializing',
        'indexing',
        'ready',
        'error',
      ]

      for (const state of states) {
        repo.write({
          projectId,
          cwd: '',
          state,
          ready: state === 'ready',
          stats: null,
          message: state === 'error' ? 'Error occurred' : null,
        })

        const row = repo.read(projectId, '')
        expect(row?.state).toBe(state)
        expect(row?.ready).toBe(state === 'ready')
      }
    })
  })

  describe('read', () => {
    test('returns null for non-existent project', () => {
      const row = repo.read('non-existent', '')
      expect(row).toBeNull()
    })

    test('returns null for non-existent cwd', () => {
      repo.write({
        projectId,
        cwd: '/existing',
        state: 'ready',
        ready: true,
        stats: null,
        message: null,
      })

      const row = repo.read(projectId, '/non-existent')
      expect(row).toBeNull()
    })

    test('distinguishes between scoped and unscoped', () => {
      repo.write({
        projectId,
        cwd: '',
        state: 'ready',
        ready: true,
        stats: { files: 1, symbols: 2, edges: 3, calls: 4 },
        message: 'Unscoped',
      })
      repo.write({
        projectId,
        cwd: '/worktree',
        state: 'indexing',
        ready: false,
        stats: null,
        message: 'Scoped',
      })

      const unscoped = repo.read(projectId, '')
      expect(unscoped?.message).toBe('Unscoped')
      expect(unscoped?.state).toBe('ready')

      const scoped = repo.read(projectId, '/worktree')
      expect(scoped?.message).toBe('Scoped')
      expect(scoped?.state).toBe('indexing')
    })

    test('separates by project_id', () => {
      repo.write({
        projectId: 'project-a',
        cwd: '',
        state: 'ready',
        ready: true,
        stats: null,
        message: 'Project A',
      })
      repo.write({
        projectId: 'project-b',
        cwd: '',
        state: 'indexing',
        ready: false,
        stats: null,
        message: 'Project B',
      })

      expect(repo.read('project-a', '')?.message).toBe('Project A')
      expect(repo.read('project-b', '')?.message).toBe('Project B')
    })
  })
})
