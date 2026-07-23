import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopNewSessionOutcomesRepo } from '../../src/storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../../src/storage/repos/loop-new-session-cancellations-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { createToolExecuteAfterHook } from '../../src/hooks/plan-approval'
import type { ToolContext } from '../../src/tools/types'
import { createLogger } from '../../src/utils/logger'
import { slugify } from '../../src/utils/logger'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createPendingTeardownRegistry } from '../../src/workspace/pending-teardown'
import { createNoWaitWorkspaceStatusRegistry } from '../helpers/workspace-status-registry'

const TEST_DIR = '/tmp/opencode-plan-approval-stale-findings-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `forge-test-${randomUUID()}.db`)
  mkdirSync(TEST_DIR, { recursive: true })
  const db = new Database(path)
  setupLoopsTestDb(db)
  return { db, path }
}

describe('plan-approval "New session" purges orphaned review findings for a reused loop name', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'
  const sessionID = 'src-session'

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    dbPath = r.path
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  test('hook threads ctx.reviewFindingsRepo into its execution service so attach purges stale findings', async () => {
    const { client: forgeClient } = createFakeForgeClient()
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const newSessionOutcomesRepo = createLoopNewSessionOutcomesRepo(db)
    const newSessionCancellationsRepo = createLoopNewSessionCancellationsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const loopHandler = createLoopEventHandler(
      loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => ({}), undefined, dbPath,
    )

    const workspaceStatusRegistry = createNoWaitWorkspaceStatusRegistry()
    const pendingTeardowns = createPendingTeardownRegistry()

    const planText = '# Plan\n\n## Loop Name: Reuse add feature\n\nDo the thing.'
    plansRepo.writeForSession(projectId, sessionID, planText)

    const expectedName = loopService.generateUniqueLoopName(slugify('Reuse add feature'))

    // Seed orphan findings tied ONLY to the loop name (no loops row),
    // simulating a swept-but-not-FK-cascaded expired loop of the same name.
    reviewFindingsRepo.write({
      projectId, loopName: expectedName,
      file: 'src/a.ts', line: 1, severity: 'bug' as const, description: 'stale inherited finding',
    })
    expect(reviewFindingsRepo.listByLoopName(projectId, expectedName).length).toBeGreaterThan(0)
    expect(loopsRepo.get(projectId, expectedName)).toBeNull()

    const ctx = {
      projectId,
      directory: TEST_DIR,
      config: { loop: { defaultMaxIterations: 5 }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo: undefined,
      newSessionOutcomesRepo,
      newSessionCancellationsRepo,
      loopHandler,
      loop: loopHandler.loop,
      sandboxManager: null,
      client: forgeClient,
      dataDir: dbPath,
      workspaceStatusRegistry,
      pendingTeardowns,
      loopService,
    } as unknown as ToolContext

    const hook = createToolExecuteAfterHook(ctx)
    if (!hook) throw new Error('hook not registered')

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: '' },
          { label: 'Execute here', description: '' },
          { label: 'Loop', description: '' },
        ],
      }],
    }
    const output = { title: '', output: 'New session', metadata: { answers: [['New session']] } }

    await hook({ tool: 'question', sessionID, callID: 'call-stale-1', args }, output)

    // The "New session" dispatch is intentionally fire-and-forget inside the
    // hook; poll the loops row (written by attachLoopToSession) until the
    // dispatched launch commits or the deadline elapses.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !loopsRepo.get(projectId, expectedName)) {
      await new Promise((r) => setTimeout(r, 25))
    }

    const row = loopsRepo.get(projectId, expectedName)
    expect(row).not.toBeNull()
    expect(row!.status === 'running' || row!.status === 'completed').toBe(true)

    // The reused loop name now has zero findings — the stale ones were purged
    // because the hook's service was constructed with ctx.reviewFindingsRepo.
    expect(reviewFindingsRepo.listByLoopName(projectId, expectedName)).toEqual([])
  })
})
