import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'
import { sweepExpiredLoops } from '../src/storage/sweep'

function createTempDb(): string {
  const dir = tmpdir()
  const dbPath = join(dir, `forge-test-${randomUUID()}.db`)
  return dbPath
}

test('sweepExpiredLoops deletes only non-running rows older than ttl', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000)
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)
  const oneDayAgo = now - (24 * 60 * 60 * 1000)

  db.run(`
    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at, completed_at)
    VALUES
      ('proj1', 'loop-running', 'running', 'sess1', 0, '/path1', NULL, '/proj1', 10, 5, 2, 0, 'coding', ?, NULL),
      ('proj1', 'loop-completed-old', 'completed', 'sess2', 0, '/path2', NULL, '/proj1', 10, 10, 5, 0, 'coding', ?, ?),
      ('proj1', 'loop-completed-recent', 'completed', 'sess3', 0, '/path3', NULL, '/proj1', 10, 3, 1, 0, 'coding', ?, ?),
      ('proj1', 'loop-cancelled-old', 'cancelled', 'sess4', 0, '/path4', NULL, '/proj1', 10, 8, 3, 0, 'coding', ?, ?),
      ('proj1', 'loop-errored-old', 'errored', 'sess5', 0, '/path5', NULL, '/proj1', 10, 7, 10, 0, 'coding', ?, ?),
      ('proj1', 'loop-stalled-old', 'stalled', 'sess6', 0, '/path6', NULL, '/proj1', 10, 6, 2, 0, 'coding', ?, ?)
  `, [now, sevenDaysAgo, eightDaysAgo, now, oneDayAgo, sevenDaysAgo, eightDaysAgo, sevenDaysAgo, eightDaysAgo, sevenDaysAgo, eightDaysAgo])

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  const deleted = sweepExpiredLoops(db, ttlMs)

  expect(deleted).toBe(4)

  const remaining = db.prepare('SELECT loop_name, status FROM loops WHERE project_id = ?').all('proj1') as Array<{ loop_name: string; status: string }>
  const remainingNames = remaining.map((r) => r.loop_name)

  expect(remainingNames).toContain('loop-running')
  expect(remainingNames).toContain('loop-completed-recent')
  expect(remainingNames).not.toContain('loop-completed-old')
  expect(remainingNames).not.toContain('loop-cancelled-old')
  expect(remainingNames).not.toContain('loop-errored-old')
  expect(remainingNames).not.toContain('loop-stalled-old')

  db.close()
})

test('sweepExpiredLoops cascades to loop_large_fields and plans', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  db.run(`
    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at, completed_at)
    VALUES ('proj1', 'loop-to-delete', 'completed', 'sess1', 0, '/path', NULL, '/proj1', 10, 5, 2, 0, 'coding', ?, ?)
  `, [now, eightDaysAgo])

  db.run(`
    INSERT INTO loop_large_fields (project_id, loop_name, prompt, last_audit_result)
    VALUES ('proj1', 'loop-to-delete', 'test prompt', 'test audit result')
  `)

  db.run(`
    INSERT INTO plans (project_id, loop_name, session_id, content, updated_at)
    VALUES ('proj1', 'loop-to-delete', NULL, 'test plan content', ?)
  `, [now])

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  sweepExpiredLoops(db, ttlMs)

  const largeFields = db.prepare('SELECT COUNT(*) as count FROM loop_large_fields WHERE project_id = ? AND loop_name = ?').get('proj1', 'loop-to-delete') as { count: number }
  expect(largeFields.count).toBe(0)

  const plans = db.prepare('SELECT COUNT(*) as count FROM plans WHERE project_id = ? AND loop_name = ?').get('proj1', 'loop-to-delete') as { count: number }
  expect(plans.count).toBe(0)

  db.close()
})

test('sweepExpiredLoops leaves review_findings untouched', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  db.run(`
    INSERT INTO review_findings (project_id, file, line, severity, description, scenario, branch, created_at)
    VALUES ('proj1', '/test.ts', 10, 'bug', 'test bug', 'test scenario', 'main', ?)
  `, [eightDaysAgo])

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  sweepExpiredLoops(db, ttlMs)

  const findings = db.prepare('SELECT COUNT(*) as count FROM review_findings WHERE project_id = ?').get('proj1') as { count: number }
  expect(findings.count).toBe(1)

  db.close()
})

test('sweepExpiredLoops does not delete plans from other projects with same loop_name', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  // Project A has an expired loop
  db.run(`
    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at, completed_at)
    VALUES ('projA', 'shared-loop-name', 'completed', 'sess1', 0, '/path', NULL, '/projA', 10, 5, 2, 0, 'coding', ?, ?)
  `, [now, eightDaysAgo])

  // Project B has a live loop with the same name and a plan
  db.run(`
    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at, completed_at)
    VALUES ('projB', 'shared-loop-name', 'running', 'sess2', 0, '/path', NULL, '/projB', 10, 5, 2, 0, 'coding', ?, NULL)
  `, [now])

  db.run(`
    INSERT INTO plans (project_id, loop_name, session_id, content, updated_at)
    VALUES ('projB', 'shared-loop-name', NULL, 'project B plan that should NOT be deleted', ?)
  `, [now])

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  sweepExpiredLoops(db, ttlMs)

  // Project B's plan should still exist
  const plans = db.prepare('SELECT COUNT(*) as count FROM plans WHERE project_id = ? AND loop_name = ?').get('projB', 'shared-loop-name') as { count: number }
  expect(plans.count).toBe(1)

  // Project A's loop should be deleted
  const loops = db.prepare('SELECT COUNT(*) as count FROM loops WHERE project_id = ? AND loop_name = ?').get('projA', 'shared-loop-name') as { count: number }
  expect(loops.count).toBe(0)

  db.close()
})
