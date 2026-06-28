import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createLoopService } from '../src/loop/service'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopTools } from '../src/tools/loop'
import { createLogger } from '../src/utils/logger'
import { createLoopEventHandler } from '../src/hooks/loop'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { setupLoopsTestDb } from './helpers/loops-test-db'
import { createFakeForgeClient } from './helpers/fake-client'
import { createPendingTeardownRegistry } from '../src/workspace/pending-teardown'
import { createNoWaitWorkspaceStatusRegistry } from './helpers/workspace-status-registry'

const TEST_DIR = '/tmp/opencode-loop-new-session-test-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `forge-test-${randomUUID()}.db`)
  mkdirSync(TEST_DIR, { recursive: true })
  const db = new Database(path)
  setupLoopsTestDb(db)
  return { db, path }
}

describe('loop tool mode=new-session', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.path
  })

  afterEach(() => {
    db.close()
  })

  function setupTools() {
    const { client: forgeClient } = createFakeForgeClient()
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const loopHandler = createLoopEventHandler(
      loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => ({}), undefined, dbPath,
    )

    const tools = createLoopTools({
      client: forgeClient,
      workspaceStatusRegistry: createNoWaitWorkspaceStatusRegistry(),
      pendingTeardowns: createPendingTeardownRegistry(),
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    return { tools, forgeClient }
  }

  test('mode="new-session" creates a session, prompts code agent, and does NOT create a worktree', async () => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'new-session' },
      { sessionID: 'src-session' } as any,
    )

    // Session created exactly once
    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)

    // PromptAsync called with agent: 'code' and plan text
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(1)
    const promptCall = (forgeClient.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.parts[0].text).toContain('# Plan')

    // No workspace.create call
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)

    // Result contains new-session markers and NOT loop markers
    expect(result).toContain('New session')
    expect(result).toContain('ses_fake_1')
    expect(result).not.toContain('Memory loop activated')
  })

  // Default (mode omitted) and explicit mode='loop' both run the iterative loop.
  test.each([
    ['default mode (omitted)', undefined],
    ['explicit mode="loop"', 'loop' as const],
  ])('%s runs the iterative loop (worktree created)', async (_label, mode) => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', ...(mode ? { mode } : {}) },
      { sessionID: 'src-session' } as any,
    )

    // Loop path either creates a workspace via the execution service
    // or returns the "Memory loop activated" message
    const workspaceCreated = (forgeClient.workspace.create as any).mock.calls.length > 0
    const hasLoopMessage = typeof result === 'string' && result.includes('Memory loop activated')
    expect(workspaceCreated || hasLoopMessage).toBe(true)
  })
})
