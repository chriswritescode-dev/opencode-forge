import { test, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'
import { sweepExpiredLoops } from '../src/storage/sweep'
import { insertTestLoopRow } from './helpers/loop-fixtures'

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

  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-running',
    status: 'running',
    currentSessionId: 'sess1',
    worktree: false,
    worktreeDir: '/path1',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 5,
    auditCount: 2,
    errorCount: 0,
    phase: 'coding',
    startedAt: now,
    completedAt: null,
  })
  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-completed-old',
    status: 'completed',
    currentSessionId: 'sess2',
    worktree: false,
    worktreeDir: '/path2',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 10,
    auditCount: 5,
    errorCount: 0,
    phase: 'coding',
    startedAt: sevenDaysAgo,
    completedAt: eightDaysAgo,
  })
  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-completed-recent',
    status: 'completed',
    currentSessionId: 'sess3',
    worktree: false,
    worktreeDir: '/path3',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 3,
    auditCount: 1,
    errorCount: 0,
    phase: 'coding',
    startedAt: now,
    completedAt: oneDayAgo,
  })
  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-cancelled-old',
    status: 'cancelled',
    currentSessionId: 'sess4',
    worktree: false,
    worktreeDir: '/path4',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 8,
    auditCount: 3,
    errorCount: 0,
    phase: 'coding',
    startedAt: sevenDaysAgo,
    completedAt: eightDaysAgo,
  })
  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-errored-old',
    status: 'errored',
    currentSessionId: 'sess5',
    worktree: false,
    worktreeDir: '/path5',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 7,
    auditCount: 10,
    errorCount: 0,
    phase: 'coding',
    startedAt: sevenDaysAgo,
    completedAt: eightDaysAgo,
  })
  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-stalled-old',
    status: 'stalled',
    currentSessionId: 'sess6',
    worktree: false,
    worktreeDir: '/path6',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 6,
    auditCount: 2,
    errorCount: 0,
    phase: 'coding',
    startedAt: sevenDaysAgo,
    completedAt: eightDaysAgo,
  })

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

  insertTestLoopRow(db, {
    projectId: 'proj1',
    loopName: 'loop-to-delete',
    status: 'completed',
    currentSessionId: 'sess1',
    worktree: false,
    worktreeDir: '/path',
    worktreeBranch: null,
    projectDir: '/proj1',
    maxIterations: 10,
    iteration: 5,
    auditCount: 2,
    errorCount: 0,
    phase: 'coding',
    startedAt: now,
    completedAt: eightDaysAgo,
  })

  db.run(`
    INSERT INTO loop_large_fields (project_id, loop_name, last_audit_result)
    VALUES ('proj1', 'loop-to-delete', 'test audit result')
    ON CONFLICT (project_id, loop_name) DO UPDATE SET last_audit_result = excluded.last_audit_result
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
  insertTestLoopRow(db, {
    projectId: 'projA',
    loopName: 'shared-loop-name',
    status: 'completed',
    currentSessionId: 'sess1',
    worktree: false,
    worktreeDir: '/path',
    worktreeBranch: null,
    projectDir: '/projA',
    maxIterations: 10,
    iteration: 5,
    auditCount: 2,
    errorCount: 0,
    phase: 'coding',
    startedAt: now,
    completedAt: eightDaysAgo,
  })

  // Project B has a live loop with the same name and a plan
  insertTestLoopRow(db, {
    projectId: 'projB',
    loopName: 'shared-loop-name',
    status: 'running',
    currentSessionId: 'sess2',
    worktree: false,
    worktreeDir: '/path',
    worktreeBranch: null,
    projectDir: '/projB',
    maxIterations: 10,
    iteration: 5,
    auditCount: 2,
    errorCount: 0,
    phase: 'coding',
    startedAt: now,
    completedAt: null,
  })

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
