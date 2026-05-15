import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../../src/storage/database'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { readPlanForAnyProject } from '../../src/utils/tui-plan-store'

describe('readPlanForAnyProject', () => {
  let db: Database
  let dbPath: string

  beforeEach(() => {
    dbPath = join(tmpdir(), `forge-test-${randomUUID()}.db`)
    db = openForgeDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
  })

  test('returns null when database does not exist', () => {
    const result = readPlanForAnyProject('non-existent-session', '/tmp/non-existent-db.db')
    expect(result).toBeNull()
  })

  test('returns session-scoped plan when no loop exists', () => {
    const plansRepo = createPlansRepo(db)
    const projectId = 'proj-1'
    const sessionId = 'sess-1'

    plansRepo.writeForSession(projectId, sessionId, '# Session Plan')
    db.close()

    const result = readPlanForAnyProject(sessionId, dbPath)
    expect(result).toBe('# Session Plan')
  })

  test('returns loop-scoped plan via current_session_id mapping', () => {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const projectId = 'proj-1'
    const sessionId = 'sess-loop'
    const loopName = 'my-loop'

    loopsRepo.insert(
      {
        projectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: false,
        worktreeDir: '/test',
        worktreeBranch: null,
        projectDir: '/proj',
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
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'pending',
        decompositionMode: 'agent',
        decompositionSessionId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
      },
      { lastAuditResult: null }
    )

    plansRepo.writeForLoop(projectId, loopName, '# Loop Plan Content')
    plansRepo.writeForSession(projectId, sessionId, '# Session Plan Fallback')

    db.close()

    const result = readPlanForAnyProject(sessionId, dbPath)
    expect(result).toBe('# Loop Plan Content')
  })

  test('falls back to session-scoped plan when no loop matches', () => {
    const plansRepo = createPlansRepo(db)
    const projectId = 'proj-1'
    const sessionId = 'sess-only'

    plansRepo.writeForSession(projectId, sessionId, '# Only Session Plan')

    db.close()

    const result = readPlanForAnyProject(sessionId, dbPath)
    expect(result).toBe('# Only Session Plan')
  })

  test('returns null when session has no matching plans or loops', () => {
    db.close()

    const result = readPlanForAnyProject('non-existent', dbPath)
    expect(result).toBeNull()
  })
})
