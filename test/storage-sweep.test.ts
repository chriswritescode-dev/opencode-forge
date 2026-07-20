import { test, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'
import { sweepExpiredLoops, sweepExpiredLoopMetrics } from '../src/storage/sweep'

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
    INSERT INTO loop_large_fields (project_id, loop_name, last_audit_result)
    VALUES ('proj1', 'loop-to-delete', 'test audit result')
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
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, created_at)
    VALUES ('proj1', 'loop-a', '/test.ts', 10, 'bug', 'test bug', 'test scenario', ?)
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

test('sweepExpiredLoops leaves loop_events and loop_runs rows intact (metrics retention)', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  db.run(`
    INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at, completed_at)
    VALUES ('proj1', 'loop-to-delete', 'completed', 'sess1', 0, '/path', NULL, '/proj1', 10, 5, 2, 0, 'coding', ?, ?)
  `, [now, eightDaysAgo])

  db.run(`
    INSERT INTO loop_events (project_id, loop_name, run_started_at, event_type, outcome, verdict, iteration, section_index, session_id, role, model, cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, message_count, findings_total, findings_bugs, detail, created_at)
    VALUES ('proj1', 'loop-to-delete', ?, 'audit_done', 'clean', 'clean', 1, NULL, 'sess1', 'auditor', 'audit-model', 0.01, 100, 200, 0, 0, 0, 2, 0, 0, NULL, ?)
  `, [now, eightDaysAgo])

  db.run(`
    INSERT INTO loop_runs (project_id, loop_name, started_at, completed_at, status, termination_reason, loop_kind, execution_model, auditor_model, execution_variant, auditor_variant, iterations, audit_count, error_count, total_sections, section_retries, clean_audits, dirty_audits, cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, message_count, duration_ms, created_at)
    VALUES ('proj1', 'loop-to-delete', ?, ?, 'completed', NULL, 'plan', 'exec-model', 'audit-model', NULL, NULL, 5, 2, 0, 0, 0, 2, 0, 0.05, 1000, 2000, 0, 0, 0, 10, 1000, ?)
  `, [now, eightDaysAgo, eightDaysAgo])

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  sweepExpiredLoops(db, ttlMs)

  const events = db.prepare('SELECT COUNT(*) as count FROM loop_events WHERE project_id = ?').get('proj1') as { count: number }
  expect(events.count).toBe(1)

  const runs = db.prepare('SELECT COUNT(*) as count FROM loop_runs WHERE project_id = ?').get('proj1') as { count: number }
  expect(runs.count).toBe(1)

  db.close()
})

test('sweepExpiredLoopMetrics deletes only metrics older than cutoff from both tables and returns total', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()
  const ttlMs = 1000
  const oldEvent = now - 5000
  const newEvent = now - 100

  db.run(`
    INSERT INTO loop_events (project_id, loop_name, run_started_at, event_type, outcome, verdict, iteration, section_index, session_id, role, model, cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, message_count, findings_total, findings_bugs, detail, created_at)
    VALUES
      ('proj1', 'loop-a', ?, 'audit_done', 'clean', 'clean', 1, NULL, 'sess1', 'auditor', 'm', 0, 0, 0, 0, 0, 0, 1, 0, 0, NULL, ?),
      ('proj1', 'loop-b', ?, 'coding_done', NULL, NULL, 1, NULL, 'sess2', 'code', 'm', 0, 0, 0, 0, 0, 0, 1, 0, 0, NULL, ?)
  `, [now, oldEvent, now, newEvent])

  db.run(`
    INSERT INTO loop_runs (project_id, loop_name, started_at, completed_at, status, termination_reason, loop_kind, execution_model, auditor_model, execution_variant, auditor_variant, iterations, audit_count, error_count, total_sections, section_retries, clean_audits, dirty_audits, cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, message_count, duration_ms, created_at)
    VALUES
      ('proj1', 'loop-a', ?, ?, 'completed', NULL, 'plan', 'm', 'm', NULL, NULL, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 100, ?),
      ('proj1', 'loop-b', ?, ?, 'completed', NULL, 'plan', 'm', 'm', NULL, NULL, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 100, ?)
  `, [now, now, oldEvent, now, now, newEvent])

  const deletedCount = sweepExpiredLoopMetrics(db, ttlMs)
  expect(deletedCount).toBe(2) // 1 event + 1 run

  const events = db.prepare('SELECT COUNT(*) as count FROM loop_events').get() as { count: number }
  expect(events.count).toBe(1)

  const runs = db.prepare('SELECT COUNT(*) as count FROM loop_runs').get() as { count: number }
  expect(runs.count).toBe(1)

  db.close()
})

test('sweepExpiredLoopMetrics with future cutoff deletes nothing', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const now = Date.now()

  db.run(`
    INSERT INTO loop_events (project_id, loop_name, run_started_at, event_type, cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, message_count, created_at)
    VALUES ('proj1', 'loop-a', ?, 'audit_done', 0, 0, 0, 0, 0, 0, 1, ?)
  `, [now, now])

  const future = now + 10000
  const deleted = sweepExpiredLoopMetrics(db, future)
  expect(deleted).toBe(0)

  db.close()
})
