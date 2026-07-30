import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createLoopService } from '../src/loop/service'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createGoalBriefsRepo } from '../src/storage/repos/goal-briefs-repo'
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
      goalBriefsRepo: createGoalBriefsRepo(db),
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

  test('execute-plan with no inline plan uses the stored row and skips legacy message capture', async () => {
    const { tools, forgeClient } = setupTools()
    const plansRepo = createPlansRepo(db)
    plansRepo.writeForSession(projectId, 'src-session', '# Stored Plan\n\n## Verification\n- pnpm test')

    const result = await tools['execute-plan'].execute(
      { title: 'Stored plan run' },
      { sessionID: 'src-session' } as any,
    )

    // Storage is the plan of record: legacy latest-message capture must not run.
    expect((forgeClient.session.messages as any).mock.calls.length).toBe(0)

    const workspaceCreated = (forgeClient.workspace.create as any).mock.calls.length > 0
    const hasLoopMessage = typeof result === 'string' && result.includes('Memory loop activated')
    expect(workspaceCreated || hasLoopMessage).toBe(true)
  })

  test('execute-plan with no inline plan falls back to legacy capture only when no stored row exists', async () => {
    const { tools, forgeClient } = setupTools()
    const plansRepo = createPlansRepo(db)
    expect(plansRepo.getForSession(projectId, 'src-session')).toBeNull()

    const marked = {
      info: { role: 'assistant', id: 'msg-1' },
      parts: [{ type: 'text', text: `<!-- forge-plan:start -->\n# Captured Plan\n<!-- forge-plan:end -->` }],
    }
    ;(forgeClient.session.messages as any).mockImplementation(async () => [marked])

    const result = await tools['execute-plan'].execute(
      { title: 'Legacy capture run' },
      { sessionID: 'src-session' } as any,
    )

    expect((forgeClient.session.messages as any).mock.calls.length).toBe(1)
    expect(plansRepo.getForSession(projectId, 'src-session')?.content).toBe('# Captured Plan')

    const workspaceCreated = (forgeClient.workspace.create as any).mock.calls.length > 0
    const hasLoopMessage = typeof result === 'string' && result.includes('Memory loop activated')
    expect(workspaceCreated || hasLoopMessage).toBe(true)
  })

  test('execute-plan with no inline plan and nothing to capture returns the no-plan message', async () => {
    const { tools } = setupTools()
    const plansRepo = createPlansRepo(db)
    expect(plansRepo.getForSession(projectId, 'src-session')).toBeNull()

    const result = await tools['execute-plan'].execute(
      { title: 'Nothing to run' },
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('No plan found')
  })

  test('execute-plan with no inline plan does not recapture an older marked message over a newer stored row', async () => {
    const { tools, forgeClient } = setupTools()
    const plansRepo = createPlansRepo(db)
    plansRepo.writeForSession(projectId, 'src-session', '# plan-write revision')

    const stale = {
      info: { role: 'assistant', id: 'msg-stale' },
      parts: [{ type: 'text', text: `<!-- forge-plan:start -->\n# Stale Plan\n<!-- forge-plan:end -->` }],
    }
    ;(forgeClient.session.messages as any).mockImplementation(async () => [stale])

    await tools['execute-plan'].execute(
      { title: 'Stored wins' },
      { sessionID: 'src-session' } as any,
    )

    // The stored revision must remain untouched — no messages call at all.
    expect((forgeClient.session.messages as any).mock.calls.length).toBe(0)
    expect(plansRepo.getForSession(projectId, 'src-session')?.content).toBe('# plan-write revision')
  })
})

describe('execute-goal tool', () => {
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

  function setupTools(clientOverrides?: Parameters<typeof createFakeForgeClient>[0]) {
    const { client: forgeClient } = createFakeForgeClient(clientOverrides)
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
      goalBriefsRepo: createGoalBriefsRepo(db),
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    return { tools, forgeClient, loopService }
  }

  const BRIEF = `## Goal
Ship the execute-goal feature end to end.

## Context
The legacy free-text launch path is being replaced by brief-backed launches.

## Constraints
No new dependencies.

## Acceptance Criteria
- the execute-goal tool launches from a stored goal brief
`

  test('warns when the new session resolves to a different opencode project than the plugin scope', async () => {
    const { tools } = setupTools({
      session: {
        get: async () => ({ id: 'ses_fake_1', projectID: 'other-project' }),
      },
    } as any)
    createGoalBriefsRepo(db).writeForSession(projectId, 'src-session', BRIEF)

    const result = await tools['execute-goal'].execute(
      {} as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('Goal loop activated')
    expect(result).toContain('WARNING: The new session belongs to project other-project')
    expect(result).toContain(`scoped to project ${projectId}`)
  })

  test('no project scope warning when session project matches the plugin scope', async () => {
    const { tools } = setupTools({
      session: {
        get: async () => ({ id: 'ses_fake_1', projectID: projectId }),
      },
    } as any)
    createGoalBriefsRepo(db).writeForSession(projectId, 'src-session', BRIEF)

    const result = await tools['execute-goal'].execute(
      {} as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('Goal loop activated')
    expect(result).not.toContain('WARNING: The new session belongs to project')
  })

  test('rejects without provisioning any workspace or session when no brief is stored', async () => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-goal'].execute(
      {} as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('No goal brief stored for this session')
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
  })

  test('rejects without provisioning when the stored brief is missing required headings', async () => {
    const { tools, forgeClient } = setupTools()
    createGoalBriefsRepo(db).writeForSession(projectId, 'src-session', '## Goal\nShip it.\n')

    const result = await tools['execute-goal'].execute(
      {} as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('execute-goal refused: the stored goal brief is incomplete')
    expect(result).toContain('Missing required section')
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
  })

  test('dispatches a managed goal loop from the stored brief in a new worktree session and persists the brief as the goal', async () => {
    const { tools, forgeClient, loopService } = setupTools()
    createGoalBriefsRepo(db).writeForSession(projectId, 'src-session', BRIEF)

    const result = await tools['execute-goal'].execute(
      {} as any,
      { sessionID: 'src-session' } as any,
    )

    expect(typeof result === 'string' && result.includes('Goal loop activated')).toBe(true)
    expect(result).toContain('ses_fake_1')
    expect(result).toContain('new dedicated session')

    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)

    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(1)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(1)
    const warpArgs = (forgeClient.workspace.warp as any).mock.calls[0][0]
    expect(warpArgs.sessionID).toBe('ses_fake_1')

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    const state = active[0]
    expect(state.kind).toBe('goal')
    expect(state.sessionId).toBe('ses_fake_1')
    expect(state.executorSessionId).toBe('ses_fake_1')
    expect(state.hostSessionId).toBe('src-session')
    expect(state.goal).toBe(BRIEF.trim())
    expect(state.phase).toBe('coding')
    expect(state.totalSections).toBe(0)

    const plansRepo = createPlansRepo(db)
    expect(plansRepo.getForLoop(projectId, state.loopName)).toBeNull()

    const loopsRepo = createLoopsRepo(db)
    const large = loopsRepo.getLarge(projectId, state.loopName)
    expect(large?.goal).toBe(BRIEF.trim())
  })

  test('does not regress execute-plan new-session mode (still creates a fresh session)', async () => {
    const { tools, forgeClient } = setupTools()

    await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'new-session' },
      { sessionID: 'src-session' } as any,
    )

    // new-session mode must still create exactly one session and never warp
    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
  })
})
