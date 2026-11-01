import { test, expect, afterAll } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'
import { sweepExpiredGoals, sweepExpiredLoops } from '../src/storage/sweep'

const tempDir = mkdtempSync(join(tmpdir(), 'forge-sweep-'))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function createTempDb(): string {
  return join(tempDir, `forge-test-${randomUUID()}.db`)
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

function insertGoal(
  db: Database,
  input: {
    projectId: string
    goalId: string
    status: string
    createdAt: number
    updatedAt: number
    completedAt: number | null
  },
): void {
  db.run(
    `INSERT INTO goals (project_id, goal_id, title, objective, host_session_id, status, max_chunks, created_at, updated_at, completed_at)
     VALUES (?, ?, 'title', 'objective', ?, ?, 3, ?, ?, ?)`,
    [input.projectId, input.goalId, input.goalId, input.status, input.createdAt, input.updatedAt, input.completedAt],
  )
}

function insertChunk(db: Database, projectId: string, goalId: string, chunkIndex: number): void {
  db.run(
    `INSERT INTO goal_chunks (project_id, goal_id, chunk_index, stage, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 1, 1)`,
    [projectId, goalId, chunkIndex],
  )
}

test('sweepExpiredGoals deletes old terminal goals and stale drafts but keeps running and paused goals', () => {
  const db = openForgeDatabase(createTempDb())

  const now = Date.now()
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000)
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)
  const oneDayAgo = now - (24 * 60 * 60 * 1000)

  insertGoal(db, { projectId: 'p1', goalId: 'completed-old', status: 'completed', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: eightDaysAgo })
  insertGoal(db, { projectId: 'p1', goalId: 'cancelled-old', status: 'cancelled', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: eightDaysAgo })
  insertGoal(db, { projectId: 'p1', goalId: 'completed-recent', status: 'completed', createdAt: oneDayAgo, updatedAt: oneDayAgo, completedAt: oneDayAgo })
  insertGoal(db, { projectId: 'p1', goalId: 'running-old', status: 'running', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: null })
  insertGoal(db, { projectId: 'p1', goalId: 'paused-old', status: 'paused', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: null })
  insertGoal(db, { projectId: 'p1', goalId: 'draft-stale', status: 'draft', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: null })
  insertGoal(db, { projectId: 'p1', goalId: 'draft-fresh', status: 'draft', createdAt: oneDayAgo, updatedAt: oneDayAgo, completedAt: null })
  insertGoal(db, { projectId: 'p1', goalId: 'completed-no-timestamp', status: 'completed', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: null })

  const ttlMs = 7 * 24 * 60 * 60 * 1000
  const deleted = sweepExpiredGoals(db, ttlMs)

  expect(deleted).toBe(3)
  const remaining = (db.prepare('SELECT goal_id FROM goals WHERE project_id = ?').all('p1') as Array<{ goal_id: string }>).map((r) => r.goal_id).sort()
  expect(remaining).toEqual([
    'completed-no-timestamp',
    'completed-recent',
    'draft-fresh',
    'paused-old',
    'running-old',
  ])

  db.close()
})

test('sweepExpiredGoals removes the chunks of the goals it deletes', () => {
  const db = openForgeDatabase(createTempDb())

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  insertGoal(db, { projectId: 'p1', goalId: 'completed-old', status: 'completed', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: eightDaysAgo })
  insertChunk(db, 'p1', 'completed-old', 0)
  insertChunk(db, 'p1', 'completed-old', 1)
  insertGoal(db, { projectId: 'p1', goalId: 'running-old', status: 'running', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: null })
  insertChunk(db, 'p1', 'running-old', 0)

  sweepExpiredGoals(db, 7 * 24 * 60 * 60 * 1000)

  const chunks = db.prepare('SELECT goal_id FROM goal_chunks WHERE project_id = ?').all('p1') as Array<{ goal_id: string }>
  expect(chunks.map((c) => c.goal_id)).toEqual(['running-old'])

  db.close()
})

test('sweepExpiredGoals removes chunks explicitly when foreign keys are disabled', () => {
  const db = openForgeDatabase(createTempDb())
  db.exec('PRAGMA foreign_keys=OFF')

  const now = Date.now()
  const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)

  insertGoal(db, { projectId: 'p1', goalId: 'completed-old', status: 'completed', createdAt: eightDaysAgo, updatedAt: eightDaysAgo, completedAt: eightDaysAgo })
  insertChunk(db, 'p1', 'completed-old', 0)

  sweepExpiredGoals(db, 7 * 24 * 60 * 60 * 1000)

  const goals = db.prepare('SELECT COUNT(*) as count FROM goals WHERE project_id = ?').get('p1') as { count: number }
  const chunks = db.prepare('SELECT COUNT(*) as count FROM goal_chunks WHERE project_id = ?').get('p1') as { count: number }
  expect(goals.count).toBe(0)
  expect(chunks.count).toBe(0)

  db.close()
})
