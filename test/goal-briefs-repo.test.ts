import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createGoalBriefsRepo, type GoalBriefRow } from '../src/storage'

function createTestDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE IF NOT EXISTS goal_briefs (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    )
  `)
  return db
}

describe('GoalBriefsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createGoalBriefsRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    repo = createGoalBriefsRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  test('writeForSession writes a brief readable by getForSession', () => {
    const sessionId = 'session-123'
    const content = 'Ship the goal-brief launch feature'
    const now = Date.now()

    repo.writeForSession(projectId, sessionId, content)

    const row = repo.getForSession(projectId, sessionId)
    expect(row).not.toBeNull()
    expect(row?.projectId).toBe(projectId)
    expect(row?.sessionId).toBe(sessionId)
    expect(row?.content).toBe(content)
    expect(typeof row?.updatedAt).toBe('number')
    expect(row?.updatedAt).toBeGreaterThan(now - 1000)
  })

  test('getForSession returns null when no brief exists', () => {
    const row = repo.getForSession(projectId, 'absent-session')
    expect(row).toBeNull()
  })

  test('writeForSession overwrites an existing brief and advances updatedAt', async () => {
    const sessionId = 'session-overwrite'
    repo.writeForSession(projectId, sessionId, 'First brief')
    const first = repo.getForSession(projectId, sessionId) as GoalBriefRow

    await new Promise((resolve) => setTimeout(resolve, 5))
    repo.writeForSession(projectId, sessionId, 'Second brief')
    const second = repo.getForSession(projectId, sessionId) as GoalBriefRow

    expect(second.content).toBe('Second brief')
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)

    const count = db.prepare('SELECT COUNT(*) as count FROM goal_briefs WHERE project_id = ? AND session_id = ?').get(projectId, sessionId) as { count: number }
    expect(count.count).toBe(1)
  })

  test('deleteForSession removes the brief', () => {
    const sessionId = 'session-delete'
    repo.writeForSession(projectId, sessionId, 'To be deleted')

    repo.deleteForSession(projectId, sessionId)

    expect(repo.getForSession(projectId, sessionId)).toBeNull()
  })

  test('deleteForSession is a no-op for an absent brief', () => {
    expect(() => repo.deleteForSession(projectId, 'never-written')).not.toThrow()
  })

  test('rows are project-scoped: same session id under different projects is isolated', () => {
    const sessionId = 'shared-session'
    repo.writeForSession('project-a', sessionId, 'A brief')
    repo.writeForSession('project-b', sessionId, 'B brief')

    const a = repo.getForSession('project-a', sessionId)
    const b = repo.getForSession('project-b', sessionId)
    expect(a?.content).toBe('A brief')
    expect(b?.content).toBe('B brief')

    repo.deleteForSession('project-a', sessionId)
    expect(repo.getForSession('project-a', sessionId)).toBeNull()
    expect(repo.getForSession('project-b', sessionId)?.content).toBe('B brief')
  })
})
