import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'
import { createLoopAttemptsRepo } from '../src/storage/repos/loop-attempts-repo'
import type { LoopAttemptRow, LoopAttemptRecordInput } from '../src/storage/repos/loop-attempts-repo'
import type { ReviewFindingRow } from '../src/storage/repos/review-findings-repo'

const TEST_DIR = `/tmp/opencode-loop-attempts-test-${Date.now()}`

const LOOP_ATTEMPTS_DDL = `
  CREATE TABLE IF NOT EXISTS loop_attempts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id         TEXT NOT NULL,
    loop_name          TEXT NOT NULL,
    scope              TEXT NOT NULL,
    attempt_number     INTEGER NOT NULL,
    source_session_id  TEXT NOT NULL,
    completion_key     TEXT NOT NULL,
    auditor_session_id TEXT,
    iteration          INTEGER NOT NULL,
    worktree_dir       TEXT NOT NULL,
    plan_hash          TEXT NOT NULL,
    coder_decisions    TEXT,
    snapshot_commit    TEXT,
    snapshot_ref       TEXT,
    previous_commit    TEXT,
    diff_summary       TEXT,
    fallback_reason    TEXT,
    findings_before    TEXT NOT NULL,
    findings_after     TEXT,
    outcome            TEXT CHECK(outcome IN ('clean','dirty')),
    created_at         INTEGER NOT NULL,
    audited_at         INTEGER,
    UNIQUE (project_id, loop_name, scope, completion_key),
    FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
  )
`

function createTestDb(path: string): Database {
  const db = new Database(path)
  db.run('PRAGMA foreign_keys = ON')
  db.run(`
    CREATE TABLE loops (
      project_id         TEXT NOT NULL,
      loop_name          TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'running',
      current_session_id TEXT NOT NULL DEFAULT '',
      iteration          INTEGER NOT NULL DEFAULT 0,
      phase              TEXT NOT NULL DEFAULT 'coding',
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`CREATE UNIQUE INDEX idx_loops_project_name ON loops(project_id, loop_name)`)
  db.run(LOOP_ATTEMPTS_DDL)
  db.run(`CREATE INDEX idx_loop_attempts_loop ON loop_attempts (project_id, loop_name, scope, id)`)
  return db
}

function finding(file: string, line: number, severity: 'bug' | 'warning' = 'bug'): ReviewFindingRow {
  return {
    projectId: 'test-project',
    file,
    line,
    severity,
    description: `desc ${file}:${line}`,
    scenario: null,
    loopName: 'test-loop',
    sectionIndex: null,
    createdAt: Date.now(),
  }
}

describe('LoopAttemptsRepo', () => {
  let db: Database
  let dbPath: string
  let repo: ReturnType<typeof createLoopAttemptsRepo>
  const projectId = 'test-project'
  const loopName = 'test-loop'
  const sessionA = 'sess-a'

  beforeEach(() => {
    dbPath = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
    db = createTestDb(dbPath)
    db.run(`INSERT INTO loops (project_id, loop_name, status, current_session_id) VALUES (?, ?, 'running', ?)`, [projectId, loopName, sessionA])
    repo = createLoopAttemptsRepo(db)
  })

  afterEach(() => {
    if (db.open) db.close()
  })

  function baseRecord(overrides: Partial<LoopAttemptRecordInput> = {}): LoopAttemptRecordInput {
    return {
      projectId,
      loopName,
      scope: 'section:0',
      sourceSessionId: sessionA,
      completionKey: 'key-1',
      iteration: 1,
      worktreeDir: '/tmp/wt',
      planHash: 'hash-1',
      coderDecisions: null,
      snapshotCommit: 'abc123',
      snapshotRef: 'refs/heads/forge/test-loop',
      previousCommit: 'def456',
      diffSummary: '3 files changed',
      fallbackReason: null,
      findingsBefore: [],
      ...overrides,
    }
  }

  describe('record', () => {
    test('inserts a row with attempt number 1 and default lifecycle fields', () => {
      const before = Date.now()
      const row = repo.record(baseRecord({ findingsBefore: [finding('src/a.ts', 10)] }))
      const after = Date.now()

      expect(row).not.toBeNull()
      expect(row!.attemptNumber).toBe(1)
      expect(row!.scope).toBe('section:0')
      expect(row!.completionKey).toBe('key-1')
      expect(row!.sourceSessionId).toBe(sessionA)
      expect(row!.auditorSessionId).toBeNull()
      expect(row!.findingsAfter).toBeNull()
      expect(row!.outcome).toBeNull()
      expect(row!.auditedAt).toBeNull()
      expect(row!.createdAt).toBeGreaterThanOrEqual(before)
      expect(row!.createdAt).toBeLessThanOrEqual(after)
      expect(row!.snapshotCommit).toBe('abc123')
      expect(row!.previousCommit).toBe('def456')
      expect(row!.findingsBefore).toHaveLength(1)
      expect(row!.findingsBefore[0].file).toBe('src/a.ts')
    })

    test('duplicate completion key is idempotent and does not increment attempts', () => {
      const first = repo.record(baseRecord())
      const second = repo.record(baseRecord())

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(second!.id).toBe(first!.id)
      expect(second!.attemptNumber).toBe(first!.attemptNumber)

      const rows = repo.list(projectId, loopName)
      expect(rows).toHaveLength(1)
    })

    test('returns null and stores nothing when the loop is owned by a different session', () => {
      const stale = repo.record(baseRecord({ sourceSessionId: 'sess-other' }))
      expect(stale).toBeNull()
      expect(repo.list(projectId, loopName)).toHaveLength(0)
    })

    test('returns null and stores nothing when the loop is not running', () => {
      db.run(`UPDATE loops SET status = 'completed' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      const row = repo.record(baseRecord())
      expect(row).toBeNull()
      expect(repo.list(projectId, loopName)).toHaveLength(0)
    })

    test('attempt numbers stay monotonic across iteration resets on restart', () => {
      repo.record(baseRecord({ completionKey: 'key-1', iteration: 1 }))
      repo.record(baseRecord({ completionKey: 'key-2', iteration: 2 }))

      db.run(`UPDATE loops SET current_session_id = ?, iteration = 0 WHERE project_id = ? AND loop_name = ?`, ['sess-b', projectId, loopName])

      const restarted = repo.record(baseRecord({ completionKey: 'key-3', sourceSessionId: 'sess-b', iteration: 0 }))
      expect(restarted).not.toBeNull()
      expect(restarted!.attemptNumber).toBe(3)

      const numbers = repo.list(projectId, loopName).map(r => r.attemptNumber)
      expect(numbers).toEqual([1, 2, 3])
    })

    test('attempt numbers are counted per scope', () => {
      repo.record(baseRecord({ scope: 'section:0', completionKey: 'key-1' }))
      repo.record(baseRecord({ scope: 'section:0', completionKey: 'key-2' }))

      const finalAttempt = repo.record(baseRecord({ scope: 'final', completionKey: 'key-final' }))
      expect(finalAttempt!.attemptNumber).toBe(1)

      const thirdSection = repo.record(baseRecord({ scope: 'section:0', completionKey: 'key-3' }))
      expect(thirdSection!.attemptNumber).toBe(3)
    })

    test('attempt numbers are isolated per loop', () => {
      const otherLoop = 'other-loop'
      db.run(`INSERT INTO loops (project_id, loop_name, status, current_session_id) VALUES (?, ?, 'running', ?)`, [projectId, otherLoop, sessionA])

      repo.record(baseRecord())
      const other = repo.record(baseRecord({ loopName: otherLoop, completionKey: 'key-other' }))

      expect(other!.attemptNumber).toBe(1)
    })
  })

  describe('list', () => {
    test('returns the latest 20 rows ascending by default', () => {
      for (let i = 1; i <= 25; i++) {
        repo.record(baseRecord({ completionKey: `key-${i}`, iteration: i }))
      }
      const rows = repo.list(projectId, loopName)
      expect(rows).toHaveLength(20)
      expect(rows.map(r => r.iteration)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
      const ids = rows.map(r => r.id)
      expect(ids).toEqual([...ids].sort((a, b) => a - b))
    })

    test('filters by scope', () => {
      repo.record(baseRecord({ scope: 'section:0', completionKey: 'k1' }))
      repo.record(baseRecord({ scope: 'final', completionKey: 'k2' }))

      const sectionRows = repo.list(projectId, loopName, 'section:0')
      expect(sectionRows).toHaveLength(1)
      expect(sectionRows[0].completionKey).toBe('k1')
    })

    test('honors limit and beforeId for older paging', () => {
      for (let i = 1; i <= 25; i++) {
        repo.record(baseRecord({ completionKey: `key-${i}`, iteration: i }))
      }
      const page = repo.list(projectId, loopName, 'section:0', 5)
      expect(page.map(r => r.iteration)).toEqual([21, 22, 23, 24, 25])

      const older = repo.list(projectId, loopName, 'section:0', 5, page[0].id)
      expect(older.map(r => r.iteration)).toEqual([16, 17, 18, 19, 20])
    })

    test('clamps limit into the 1..100 range', () => {
      for (let i = 1; i <= 5; i++) {
        repo.record(baseRecord({ completionKey: `key-${i}` }))
      }
      expect(repo.list(projectId, loopName, 'section:0', 0)).toHaveLength(1)
      expect(repo.list(projectId, loopName, 'section:0', -10)).toHaveLength(1)
      expect(repo.list(projectId, loopName, 'section:0', 500)).toHaveLength(5)
    })

    test('upper clamp caps at 100 rows', () => {
      for (let i = 1; i <= 105; i++) {
        repo.record(baseRecord({ completionKey: `key-${i}` }))
      }
      expect(repo.list(projectId, loopName, 'section:0', 500)).toHaveLength(100)
    })
  })

  describe('latest', () => {
    test('returns the newest row for the scope', () => {
      repo.record(baseRecord({ completionKey: 'k1', iteration: 1 }))
      repo.record(baseRecord({ completionKey: 'k2', iteration: 2 }))

      const latest = repo.latest(projectId, loopName, 'section:0')
      expect(latest).not.toBeNull()
      expect(latest!.completionKey).toBe('k2')
      expect(latest!.iteration).toBe(2)
    })

    test('returns null for a scope with no attempts', () => {
      expect(repo.latest(projectId, loopName, 'final')).toBeNull()
    })

    test('scopes do not leak into latest', () => {
      repo.record(baseRecord({ scope: 'section:0', completionKey: 'k1' }))
      expect(repo.latest(projectId, loopName, 'final')).toBeNull()
    })
  })

  describe('bindAudit', () => {
    test('binds the newest unfinished row for the source session and scope', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.record(baseRecord({ completionKey: 'k2' }))

      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')

      const rows = repo.list(projectId, loopName)
      expect(rows[0].auditorSessionId).toBeNull()
      expect(rows[1].auditorSessionId).toBe('auditor-1')
    })

    test('rebinding the same auditor is idempotent', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')

      const rows = repo.list(projectId, loopName)
      expect(rows[0].auditorSessionId).toBe('auditor-1')
      expect(repo.list(projectId, loopName)).toHaveLength(1)
    })

    test('does not steal a row already bound to another auditor', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')

      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-2')

      expect(repo.latest(projectId, loopName, 'section:0')!.auditorSessionId).toBe('auditor-1')
    })

    test('binds the next unfinished row after the previous one finished', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.record(baseRecord({ completionKey: 'k2' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')

      db.run(`UPDATE loops SET current_session_id = 'auditor-1' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'dirty', [finding('src/x.ts', 1)])).toBe(true)

      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-2')

      const rows = repo.list(projectId, loopName)
      expect(rows[0].auditorSessionId).toBe('auditor-2')
      expect(rows[1].auditorSessionId).toBe('auditor-1')
    })

    test('does not bind finished rows', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')
      db.run(`UPDATE loops SET current_session_id = 'auditor-1' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'clean', [])

      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-2')

      expect(repo.latest(projectId, loopName, 'section:0')!.auditorSessionId).toBe('auditor-1')
    })

    describe('replaceSession callback', () => {
      function loopRow(): { current_session_id: string; phase: string } {
        return db
          .prepare(`SELECT current_session_id, phase FROM loops WHERE project_id = ? AND loop_name = ?`)
          .get(projectId, loopName) as { current_session_id: string; phase: string }
      }

      test('commits the callback write and the binding together', () => {
        repo.record(baseRecord({ completionKey: 'k1' }))
        let calls = 0
        const replaceSession = () => {
          calls += 1
          db.prepare(`UPDATE loops SET current_session_id = ?, phase = 'auditing' WHERE project_id = ? AND loop_name = ?`).run('auditor-1', projectId, loopName)
        }

        repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1', replaceSession)

        expect(calls).toBe(1)
        expect(loopRow()).toEqual({ current_session_id: 'auditor-1', phase: 'auditing' })
        expect(repo.latest(projectId, loopName, 'section:0')!.auditorSessionId).toBe('auditor-1')
      })

      test('a binding failure rolls back both the callback write and the binding', () => {
        repo.record(baseRecord({ completionKey: 'k1' }))
        db.run(`
          CREATE TRIGGER abort_attempt_bind
          BEFORE UPDATE ON loop_attempts
          BEGIN
            SELECT RAISE(ABORT, 'simulated bind failure');
          END
        `)
        let calls = 0
        const replaceSession = () => {
          calls += 1
          db.prepare(`UPDATE loops SET current_session_id = ?, phase = 'auditing' WHERE project_id = ? AND loop_name = ?`).run('auditor-1', projectId, loopName)
        }

        expect(() => repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1', replaceSession)).toThrow(/simulated bind failure/)

        expect(calls).toBe(1)
        expect(loopRow()).toEqual({ current_session_id: sessionA, phase: 'coding' })
        expect(repo.latest(projectId, loopName, 'section:0')!.auditorSessionId).toBeNull()
      })

      test('stale source rejects and never invokes the callback', () => {
        repo.record(baseRecord({ completionKey: 'k1' }))
        db.run(`UPDATE loops SET current_session_id = 'sess-b' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
        let calls = 0
        const replaceSession = () => {
          calls += 1
          db.prepare(`UPDATE loops SET current_session_id = ?, phase = 'auditing' WHERE project_id = ? AND loop_name = ?`).run('auditor-1', projectId, loopName)
        }

        expect(() => repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1', replaceSession)).toThrow('Audit handoff source session is no longer active')

        expect(calls).toBe(0)
        expect(loopRow()).toEqual({ current_session_id: 'sess-b', phase: 'coding' })
        expect(repo.latest(projectId, loopName, 'section:0')!.auditorSessionId).toBeNull()
      })
    })
  })

  describe('finishAudit', () => {
    test('sets auditedAt, outcome, and findings on the bound row', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')
      db.run(`UPDATE loops SET current_session_id = 'auditor-1' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      const before = Date.now()
      const ok = repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'dirty', [finding('src/a.ts', 3), finding('src/b.ts', 7, 'warning')])
      const after = Date.now()

      expect(ok).toBe(true)
      const row = repo.latest(projectId, loopName, 'section:0')!
      expect(row.outcome).toBe('dirty')
      expect(row.auditedAt).not.toBeNull()
      expect(row.auditedAt!).toBeGreaterThanOrEqual(before)
      expect(row.auditedAt!).toBeLessThanOrEqual(after)
      expect(row.findingsAfter).toHaveLength(2)
      expect(row.findingsAfter![0]).toMatchObject({ file: 'src/a.ts', line: 3, severity: 'bug' })
      expect(row.findingsAfter![1]).toMatchObject({ file: 'src/b.ts', line: 7, severity: 'warning' })
    })

    test('is idempotent: the second finalize for the same auditor is a no-op', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')
      db.run(`UPDATE loops SET current_session_id = 'auditor-1' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'clean', [])).toBe(true)
      const finished = repo.latest(projectId, loopName, 'section:0')
      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'dirty', [finding('src/late.ts', 1)])).toBe(false)

      const row = repo.latest(projectId, loopName, 'section:0')
      expect(row!.outcome).toBe('clean')
      expect(row!.auditedAt).toBe(finished!.auditedAt)
      expect(row!.findingsAfter).toEqual([])
    })

    test('returns false when the loop is not owned by the auditor session', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.bindAudit(projectId, loopName, 'section:0', sessionA, 'auditor-1')

      db.run(`UPDATE loops SET current_session_id = 'auditor-other' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'clean', [])).toBe(false)

      db.run(`UPDATE loops SET current_session_id = 'auditor-1', status = 'completed' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'clean', [])).toBe(false)

      const row = repo.latest(projectId, loopName, 'section:0')
      expect(row!.auditedAt).toBeNull()
      expect(row!.outcome).toBeNull()
    })

    test('returns false when no row is bound to the auditor', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      db.run(`UPDATE loops SET current_session_id = 'auditor-1' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])
      expect(repo.finishAudit(projectId, loopName, 'section:0', 'auditor-1', 'clean', [])).toBe(false)
    })
  })

  describe('invalidateSnapshot', () => {
    test('nulls previous commit and diff summary, sets fallback reason, keeps current snapshot', () => {
      const row = repo.record(baseRecord())!
      repo.invalidateSnapshot(projectId, loopName, row.id, 'worktree reset')

      const updated = repo.latest(projectId, loopName, 'section:0')!
      expect(updated.previousCommit).toBeNull()
      expect(updated.diffSummary).toBeNull()
      expect(updated.fallbackReason).toBe('worktree reset')
      expect(updated.snapshotCommit).toBe('abc123')
      expect(updated.snapshotRef).toBe('refs/heads/forge/test-loop')
    })
  })

  describe('defensive serialization', () => {
    test('corrupt findings JSON degrades to empty array and null instead of throwing', () => {
      repo.record(baseRecord({ completionKey: 'k1', findingsBefore: [finding('src/a.ts', 1)] }))
      db.run(`UPDATE loop_attempts SET findings_before = 'not-json', findings_after = '{oops' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      const row = repo.list(projectId, loopName)[0]
      expect(row.findingsBefore).toEqual([])
      expect(row.findingsAfter).toBeNull()
    })

    test('non-array findings JSON degrades instead of throwing', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      db.run(`UPDATE loop_attempts SET findings_before = '{"file":"x"}', findings_after = '42' WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      const row = repo.list(projectId, loopName)[0]
      expect(row.findingsBefore).toEqual([])
      expect(row.findingsAfter).toBeNull()
    })
  })

  describe('persistence across repo recreation', () => {
    test('rows and attempt counters survive repo recreation on the same database', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.record(baseRecord({ completionKey: 'k2' }))

      const repo2 = createLoopAttemptsRepo(db)
      const rows = repo2.list(projectId, loopName)
      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.completionKey)).toEqual(['k1', 'k2'])

      const next = repo2.record(baseRecord({ completionKey: 'k3' }))
      expect(next!.attemptNumber).toBe(3)
      expect(repo2.list(projectId, loopName)).toHaveLength(3)
    })

    test('rows survive closing and reopening the database file', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      db.close()

      const reopened = new Database(dbPath)
      reopened.run('PRAGMA foreign_keys = ON')
      const repo2 = createLoopAttemptsRepo(reopened)
      const rows = repo2.list(projectId, loopName)
      expect(rows).toHaveLength(1)
      expect(rows[0].completionKey).toBe('k1')
      reopened.close()
    })
  })

  describe('FK cascade on loop delete', () => {
    test('deleting the loop row cascades to loop_attempts', () => {
      repo.record(baseRecord({ completionKey: 'k1' }))
      repo.record(baseRecord({ scope: 'final', completionKey: 'k2' }))
      expect(repo.list(projectId, loopName)).toHaveLength(2)

      db.run(`DELETE FROM loops WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      expect(repo.list(projectId, loopName)).toHaveLength(0)
    })
  })
})

describe('LoopAttemptsRepo on the real migrated schema', () => {
  test('migration 145 creates loop_attempts and the repo operates on the real schema', () => {
    const dbPath = join(tmpdir(), `forge-loop-attempts-${randomUUID()}.db`)
    const db = openForgeDatabase(dbPath)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('loop_attempts')

    db.prepare(`
      INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
      VALUES ('proj-real', 'loop-real', 'running', 'sess-real', 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'coding', 1)
    `).run()

    const repo = createLoopAttemptsRepo(db)
    const record: LoopAttemptRecordInput = {
      projectId: 'proj-real',
      loopName: 'loop-real',
      scope: 'final',
      sourceSessionId: 'sess-real',
      completionKey: 'msg-final-1',
      iteration: 2,
      worktreeDir: '/tmp/wt',
      planHash: 'hash-real',
      coderDecisions: null,
      snapshotCommit: 'cafe123',
      snapshotRef: 'refs/heads/forge/loop-real',
      previousCommit: 'beef456',
      diffSummary: '1 file changed',
      fallbackReason: null,
      findingsBefore: [],
    }
    const row = repo.record(record)
    expect(row).not.toBeNull()
    expect(row!.attemptNumber).toBe(1)

    const migratedCount = db.prepare('SELECT COUNT(*) AS count FROM migrations WHERE id = ?').get('145') as { count: number }
    expect(migratedCount.count).toBe(1)

    db.prepare('DELETE FROM loops WHERE project_id = ? AND loop_name = ?').run('proj-real', 'loop-real')
    expect(repo.list('proj-real', 'loop-real')).toHaveLength(0)

    db.close()
  })
})
