import { describe, test, expect } from 'vitest'
import { openForgeDatabase } from '../../src/storage/database'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createGoalBriefsRepo } from '../../src/storage/repos/goal-briefs-repo'
import { fetchStoredSessionLaunchSpec } from '../../src/utils/tui-loop-store'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

function makeDbPath(): string {
  return join(tmpdir(), `forge-tui-stored-plan-${randomUUID()}.db`)
}

const PROJECT_ID = 'proj-tui-stored-plan'
const SESSION_ID = 'sess-tui-stored-plan'

function setPlanUpdatedAt(db: import('bun:sqlite').Database, projectId: string, sessionId: string, ts: number): void {
  db.run('UPDATE plans SET updated_at = ? WHERE project_id = ? AND session_id = ?', [ts, projectId, sessionId])
}

function setGoalUpdatedAt(db: import('bun:sqlite').Database, projectId: string, sessionId: string, ts: number): void {
  db.run('UPDATE goal_briefs SET updated_at = ? WHERE project_id = ? AND session_id = ?', [ts, projectId, sessionId])
}

describe('fetchStoredSessionLaunchSpec', () => {
  test('returns { kind: plan } for stored plan content', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Plan\n## Section 1')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result).toEqual({ kind: 'plan', text: '# Plan\n## Section 1', updatedAt: expect.any(Number) })
  })

  test('returns a stored plan when the database predates goal_briefs', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Legacy Plan')
      db.run('DROP TABLE goal_briefs')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)).toEqual({
      kind: 'plan',
      text: '# Legacy Plan',
      updatedAt: expect.any(Number),
    })
  })

  test('returns { kind: goal } when only a goal brief exists', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Goal Brief\n## Goal\nDo the thing')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result?.kind).toBe('goal')
    expect(result?.text).toBe('# Goal Brief\n## Goal\nDo the thing')
  })

  test('returns null for an unknown session', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Plan')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, 'sess-other', dbPath)).toBeNull()
  })

  test('returns null when neither artifact exists', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    db.close()

    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)).toBeNull()
  })

  test('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), `forge-tui-stored-plan-missing-${randomUUID()}.db`)
    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, missingPath)).toBeNull()
  })

  test('returns the goal brief when both exist and the goal was written later', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Plan')
      setPlanUpdatedAt(db, PROJECT_ID, SESSION_ID, 1000)
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Goal Brief\n## Goal\nLater')
      setGoalUpdatedAt(db, PROJECT_ID, SESSION_ID, 2000)
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result?.kind).toBe('goal')
    expect(result?.updatedAt).toBe(2000)
  })

  test('returns the plan when both exist and the plan was written later', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Goal Brief\n## Goal\nFirst')
      setGoalUpdatedAt(db, PROJECT_ID, SESSION_ID, 1000)
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Plan')
      setPlanUpdatedAt(db, PROJECT_ID, SESSION_ID, 2000)
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result?.kind).toBe('plan')
    expect(result?.updatedAt).toBe(2000)
  })

  test('plan wins on an exact updatedAt tie', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Plan')
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Goal Brief\n## Goal\nTie')
      setPlanUpdatedAt(db, PROJECT_ID, SESSION_ID, 5000)
      setGoalUpdatedAt(db, PROJECT_ID, SESSION_ID, 5000)
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result?.kind).toBe('plan')
    expect(result?.updatedAt).toBe(5000)
  })

  test('treats whitespace-only content as absent', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '   \n\t  ')
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, ' \n ')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    expect(fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)).toBeNull()
  })

  test('ignores a blank plan row but returns a present goal brief', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      createPlansRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '   ')
      createGoalBriefsRepo(db).writeForSession(PROJECT_ID, SESSION_ID, '# Goal Brief\n## Goal\nReal')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    const result = fetchStoredSessionLaunchSpec(PROJECT_ID, SESSION_ID, dbPath)
    expect(result?.kind).toBe('goal')
  })
})
