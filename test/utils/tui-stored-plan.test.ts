import { describe, test, expect } from 'vitest'
import { openForgeDatabase } from '../../src/storage/database'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createLoopsRepo, type LoopRow } from '../../src/storage/repos/loops-repo'
import { fetchStoredSessionPlan, openLoopSidebarReader } from '../../src/utils/tui-loop-store'
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

function sidebarLoopRow(loopName: string, status: LoopRow['status'], startedAt: number): LoopRow {
  return {
    projectId: PROJECT_ID,
    loopName,
    status,
    currentSessionId: `session-${loopName}`,
    worktree: false,
    worktreeDir: '/tmp/forge',
    worktreeBranch: null,
    projectDir: '/tmp/forge',
    maxIterations: 10,
    iteration: 1,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt,
    completedAt: status === 'running' ? null : startedAt + 1,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 0,
    totalSections: 0,
    finalAuditDone: 0,
    executionVariant: null,
    auditorVariant: null,
    kind: 'plan',
  }
}

describe('openLoopSidebarReader', () => {
  test('returns [] while the database is missing and recovers once it appears', () => {
    const dbPath = join(tmpdir(), `forge-tui-sidebar-${randomUUID()}.db`)
    const reader = openLoopSidebarReader(PROJECT_ID, dbPath, 5)
    try {
      expect(reader.read()).toEqual([])

      const db = openForgeDatabase(dbPath)
      try {
        createLoopsRepo(db).insert(sidebarLoopRow('running-1', 'running', 100), { lastAuditResult: null })
      } finally {
        db.close()
      }

      expect(reader.read().map((row) => row.loopName)).toEqual(['running-1'])
    } finally {
      reader.close()
    }
  })

  test('close is idempotent and stops further reads', () => {
    const dbPath = join(tmpdir(), `forge-tui-sidebar-${randomUUID()}.db`)
    const db = openForgeDatabase(dbPath)
    try {
      createLoopsRepo(db).insert(sidebarLoopRow('running-1', 'running', 100), { lastAuditResult: null })
    } finally {
      db.close()
    }

    const reader = openLoopSidebarReader(PROJECT_ID, dbPath, 5)
    expect(reader.read().map((row) => row.loopName)).toEqual(['running-1'])

    reader.close()
    reader.close()

    expect(reader.read()).toEqual([])
  })
})
