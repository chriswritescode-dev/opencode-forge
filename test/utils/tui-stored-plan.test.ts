import { describe, test, expect } from 'vitest'
import { openForgeDatabase } from '../../src/storage/database'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { fetchStoredSessionPlan } from '../../src/utils/tui-loop-store'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

function makeDbPath(): string {
  return join(tmpdir(), `forge-tui-stored-plan-${randomUUID()}.db`)
}

const PROJECT_ID = 'proj-tui-stored-plan'
const SESSION_ID = 'sess-tui-stored-plan'

describe('fetchStoredSessionPlan', () => {
  test('returns stored content written via plans repo', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      const plansRepo = createPlansRepo(db)
      plansRepo.writeForSession(PROJECT_ID, SESSION_ID, '# Plan\n## Section 1')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    expect(fetchStoredSessionPlan(PROJECT_ID, SESSION_ID, dbPath)).toBe('# Plan\n## Section 1')
  })

  test('returns null for an unknown session', () => {
    const dbPath = makeDbPath()
    const db = openForgeDatabase(dbPath)
    try {
      const plansRepo = createPlansRepo(db)
      plansRepo.writeForSession(PROJECT_ID, SESSION_ID, '# Plan')
      db.close()
    } catch (err) {
      db.close()
      throw err
    }

    expect(fetchStoredSessionPlan(PROJECT_ID, 'sess-other', dbPath)).toBeNull()
  })

  test('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), `forge-tui-stored-plan-missing-${randomUUID()}.db`)
    expect(fetchStoredSessionPlan(PROJECT_ID, SESSION_ID, missingPath)).toBeNull()
  })
})
