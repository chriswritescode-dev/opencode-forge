import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLoopService } from '../src/loop/service'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopTools } from '../src/tools/loop'
import { createLogger } from '../src/utils/logger'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLoopNewSessionOutcomesRepo } from '../src/storage/repos/loop-new-session-outcomes-repo'
import type { LoopNewSessionOutcomesRepo } from '../src/storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../src/storage/repos/loop-new-session-cancellations-repo'
import type { LoopNewSessionCancellationsRepo } from '../src/storage/repos/loop-new-session-cancellations-repo'
import { createLoopNewSessionRequestsRepo } from '../src/storage/repos/loop-new-session-requests-repo'
import { createForgeExecutionService } from '../src/services/execution'
import { slugify } from '../src/utils/logger'
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

  function setupTools(clientOverrides?: Parameters<typeof createFakeForgeClient>[0], configOverride: any = {}, outcomesOverride?: LoopNewSessionOutcomesRepo, cancellationsOverride?: LoopNewSessionCancellationsRepo) {
    const { client: forgeClient, calls } = createFakeForgeClient(clientOverrides)
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const loopHandler = createLoopEventHandler(
      loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => ({}), undefined, dbPath,
    )

    const newSessionOutcomesRepo = outcomesOverride ?? createLoopNewSessionOutcomesRepo(db)
    const newSessionCancellationsRepo = cancellationsOverride ?? createLoopNewSessionCancellationsRepo(db)
    const newSessionRequestsRepo = createLoopNewSessionRequestsRepo(db)

    const workspaceStatusRegistry = createNoWaitWorkspaceStatusRegistry()
    const pendingTeardowns = createPendingTeardownRegistry()

    // A directly-dispatchable service mirroring the one {@link createLoopTools}
    // builds per `execute-plan` call. Lets bug-2 share a single handler with a
    // plan-approval-style lifecycle (`deleteSessionOnPromptFailure: false`)
    // rather than going through the tool wrapper (which always sets it true).
    const service = createForgeExecutionService({
      projectId,
      directory: TEST_DIR,
      config: configOverride,
      logger,
      dataDir: dbPath,
      client: forgeClient,
      plansRepo,
      loopsRepo,
      loopHandler,
      loop: loopHandler.loop,
      sandboxManager: undefined,
      sectionPlansRepo: undefined,
      reviewFindingsRepo,
      workspaceStatusRegistry,
      pendingTeardowns,
      newSessionOutcomesRepo,
      newSessionCancellationsRepo,
    } as any)

    const tools = createLoopTools({
      client: forgeClient,
      workspaceStatusRegistry,
      pendingTeardowns,
      directory: TEST_DIR,
      config: configOverride,
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
      newSessionOutcomesRepo,
      newSessionCancellationsRepo,
      newSessionRequestsRepo,
    } as any)

    return { tools, forgeClient, loopService, newSessionOutcomesRepo, newSessionCancellationsRepo, newSessionRequestsRepo, loopHandler, service, calls }
  }

  function buildResultString(result: unknown): string {
    if (Array.isArray(result)) return result.join('\n')
    if (typeof result === 'string') return result
    if (typeof result === 'object' && result !== null && 'output' in result) return (result as any).output
    return String(result)
  }

  test('mode="new-session" registers and starts an audited goal loop (no worktree)', async () => {
    const { tools, forgeClient, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 7 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-launch-1' },
      { sessionID: 'src-session' } as any,
    )

    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)

    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(1)
    const promptCall = (forgeClient.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    const promptText = promptCall.parts[0].text
    expect(promptText).toContain('## Goal')
    expect(promptText).toContain('Do the thing')
    expect(promptText).not.toBe('# Plan\nDo the thing')
    expect(promptCall.workspace).toBeUndefined()

    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    const state = active[0]
    expect(state.kind).toBe('goal')
    expect(state.worktree).toBe(false)
    expect(state.sandbox).toBe(false)
    expect(state.sessionId).toBe('ses_fake_1')
    expect(state.executorSessionId).toBe('ses_fake_1')
    expect(state.hostSessionId).toBe('src-session')
    expect(state.goal).toContain('# Plan')
    expect(state.phase).toBe('coding')
    expect(state.totalSections).toBe(0)
    expect(state.maxIterations).toBe(7)
    expect(state.worktreeDir).toBe(TEST_DIR)
    expect(state.workspaceId).toBeUndefined()

    const loopsRepo = createLoopsRepo(db)
    const large = loopsRepo.getLarge(projectId, state.loopName)
    expect(large?.goal).toContain('# Plan')

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('ses_fake_1')
    expect(resultStr).toContain(state.loopName)
    expect(resultStr).toContain('Goal loop activated')
    expect(resultStr).not.toContain('not tracked by loop-status')
  })

  test('Default mode (omitted) and explicit mode="loop" run the iterative loop (worktree created)', async () => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing' },
      { sessionID: 'src-session' } as any,
    )

    const hasLoopMessage = typeof result === 'string' && result.includes('Memory loop activated')
    const workspaceCreated = (forgeClient.workspace.create as any).mock.calls.length > 0
    expect(workspaceCreated || hasLoopMessage).toBe(true)
  })

  test('mode="loop" runs the iterative loop (worktree created)', async () => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'loop' as const },
      { sessionID: 'src-session' } as any,
    )

    const hasLoopMessage = typeof result === 'string' && result.includes('Memory loop activated')
    const workspaceCreated = (forgeClient.workspace.create as any).mock.calls.length > 0
    expect(workspaceCreated || hasLoopMessage).toBe(true)
  })

  test('new-session falls back to one-shot when loops are disabled', async () => {
    const { tools, forgeClient, loopService } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
      executionVariant: 'one-shot-variant',
    })

    await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-fallback-1' },
      { sessionID: 'src-session' } as any,
    )

    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(1)
    const rawPrompt = (forgeClient.session.promptAsync as any).mock.calls[0][0]
    expect(rawPrompt.parts[0].text).toBe('# Plan\nDo the thing')
    expect(rawPrompt.variant).toBe('one-shot-variant')
    expect(loopService.listActive().length).toBe(0)
  })

  test('emoji-only title still yields a non-empty audited loop name (no slug→empty misreport)', async () => {
    /**
     * Auditor regression: a title or loopName containing only punctuation /
     * non-ASCII (e.g. `🚀`) used to slugify to an empty string. The handler
     * then returned an empty `loopName`, and truthiness-based result handling
     * misreported the audited launch as the one-shot fallback. The shared base
     * name derivation guarantees a non-empty name (`'loop'`) so every audited
     * launch reports a non-empty loopName and is reported as audited.
     */
    const { tools, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: '🚀', plan: '# Plan\nShip it', mode: 'new-session', requestNonce: 'nonce-emoji-1' },
      { sessionID: 'src-session' } as any,
    )

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    const state = active[0]
    expect(state.loopName).toBeTruthy()
    expect(state.loopName.length).toBeGreaterThan(0)

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')
    expect(resultStr).toContain(`Loop name: ${state.loopName}`)
    expect(resultStr).not.toContain('not tracked by loop-status')
    expect(resultStr).not.toContain('one-shot fallback')
  })

  test('new-session outcome-signal write failure rolls the audited launch back consistently (no running loop paired with a TUI failure)', async () => {
    /**
     * Auditor regression: a thrown outcome-signal write used to be swallowed,
     * leaving the audited goal loop running while the cross-process resolver
     * (which polls the outcome row) would time out and surface a TUI failure.
     * The handler now rolls the launch back and returns a failure so the
     * outcome-write error and the running-loop state can never diverge.
     *
     * Rollback also aborts the executor session that already received the
     * initial prompt and clears the watchdog timers started by
     * attachLoopToSession, so no live prompt, watchdog, session, or loop
     * outlives the failure — the agent cannot keep editing the project
     * directory after the launch is reported failed.
     */
    const throwingRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: () => { throw new Error('outcome signal write failed') },
    }
    const { tools, forgeClient, loopService, loopHandler } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } }, throwingRepo)

    const clearTimersSpy = vi.spyOn(loopHandler, 'clearLoopTimers')

    const result = await tools['execute-plan'].execute(
      { title: 'Rollback on signal failure', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-rollback-1' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')

    expect(loopService.listActive().length).toBe(0)

    // The executor session that received the initial prompt is aborted so the
    // queued prompt can no longer mutate the project directory after failure.
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0][0].sessionID).toBe('ses_fake_1')

    // The watchdog started by attachLoopToSession before the prompt is cleared.
    expect(clearTimersSpy).toHaveBeenCalledTimes(1)
    expect(clearTimersSpy.mock.calls[0][0]).toBeTruthy()

    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')
  })

  test('one-shot outcome-write failure aborts the running executor before deleting it and surfaces a failure (no orphan session)', async () => {
    /**
     * Auditor issue #2: the one-shot fallback used to navigate/abort the
     * source session and only DELETE — never abort — the executor when
     * outcome persistence threw, leaving the queued prompt running in the
     * orphaned new session while the panel reported failure. The handler now
     * persists the outcome BEFORE any success lifecycle effect and, on write
     * failure, ABORTS the executor (killing the in-flight prompt) before
     * deleting it and returning the user to the source session.
     */
    const throwingRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: () => { throw new Error('outcome signal write failed') },
    }
    const { tools, forgeClient, loopService } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
      executionVariant: 'one-shot-variant',
    }, throwingRepo)

    const result = await tools['execute-plan'].execute(
      { title: 'One-shot rollback', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-one-shot-fail' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')

    // No loop state registered (one-shot never creates a loop).
    expect(loopService.listActive().length).toBe(0)

    // The executor was aborted BEFORE being deleted, so the in-flight prompt
    // cannot keep running in the rolled-back session.
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0][0].sessionID).toBe('ses_fake_1')

    // The orphan session was deleted as part of rollback.
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')
  })

  test('one-shot launch that loses an in-flight arbitration race to a concurrent cancellation rolls back the executor and reports abandoned', async () => {
    /**
     * Auditor issue #1 cross-arbitration: the pre-entry `isCancelled` fence
     * only blocks handlers that arrive AFTER the panel wrote the cancellation.
     * A handler that already passed entry (no cancellation row existed yet)
     * and THEN races a concurrently-written cancellation in the window
     * between session creation and outcome commit must STILL lose — that is
     * what recordExclusive atomically enforces. We simulate the exact
     * interleaving by overriding recordExclusive so the panel-side
     * cancellation is written just before the underlying atomic commit.
     */
    const raceRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: (row) => {
        // Concurrent panel cancellation arrives just before the outcome commit.
        createLoopNewSessionCancellationsRepo(db).cancelExclusive({ projectId: row.projectId, requestNonce: row.requestNonce, hostSessionId: row.hostSessionId })
        return createLoopNewSessionOutcomesRepo(db).recordExclusive(row)
      },
    }
    const { tools, forgeClient, loopService, newSessionCancellationsRepo } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
    }, raceRepo)

    // Sanity: no cancellation marker exists when the handler enters, so the
    // pre-entry fence must NOT short-circuit this launch.
    expect(newSessionCancellationsRepo.isCancelled(projectId, 'race-one-shot-nonce')).toBe(false)

    const result = await tools['execute-plan'].execute(
      { title: 'Should lose arbitration', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'race-one-shot-nonce' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')
    expect(resultStr).toContain('abandoned')

    // No loop state registered (one-shot never creates a loop) and the
    // executor session was rolled back: aborted before being deleted.
    expect(loopService.listActive().length).toBe(0)

    const abortCalls = (forgeClient.session.abort as any).mock.calls
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0][0].sessionID).toBe('ses_fake_1')

    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')

    // No outcome row was committed — the arbitration lost.
    expect(createLoopNewSessionOutcomesRepo(db).findByRequestNonce(projectId, 'race-one-shot-nonce')).toBeNull()
    expect(newSessionCancellationsRepo.isCancelled(projectId, 'race-one-shot-nonce')).toBe(true)

    // The success lifecycle effect (TUI navigation) was suppressed because the
    // outcome did not commit; the executor session was the only one created.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
  })

  test('a requestNonce that is NOT cancelled launches the audited loop normally (cancellation check is non-interfering)', async () => {
    /**
     * Cancellation protocol (auditor issue #2): when the TUI cross-process
     * resolver times out, it writes a cancellation row keyed by this launch's
     * nonce BEFORE reporting failure. The server-side handler consults that
     * marker at entry — before creating any session or loop — and refuses to
     * launch for an already-cancelled nonce. This test seeds the marker
     * directly (the resolver test covers marking at timeout) and asserts the
     * handler refuses the launch, creating nothing.
     */
    const { tools, forgeClient, loopService, newSessionCancellationsRepo } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const cancelledNonce = 'nonce-cancelled-1'
    newSessionCancellationsRepo.cancelExclusive({ projectId, requestNonce: cancelledNonce, hostSessionId: 'src-session' })

    const result = await tools['execute-plan'].execute(
      { title: 'Should be refused', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: cancelledNonce },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')
    expect(resultStr).toContain('abandoned')

    // No session, workspace, prompt, or loop was created.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
    expect(loopService.listActive().length).toBe(0)
  })

  test('a requestNonce that is NOT cancelled launches the audited loop normally (cancellation check is non-interfering)', async () => {
    const { tools, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Should launch', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-active-1' },
      { sessionID: 'src-session' } as any,
    )

    expect(loopService.listActive().length).toBe(1)
    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')
  })

  test('audited committed launch navigates the TUI to the executor session AFTER the outcome commits', async () => {
    /**
     * Auditor issue: audited nonce-correlated launches must defer the
     * selectSession lifecycle effect until recordExclusive returns committed.
     * On a committed launch the user should be navigated to the executor
     * session, exactly once, after persistence is confirmed.
     */
    const { tools, forgeClient } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Should commit and navigate', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-commit-nav' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')

    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.length).toBe(1)
    expect(selectCalls[0][0].sessionID).toBe('ses_fake_1')
  })

  test('audited launch whose outcome persistence throws rolls back WITHOUT navigating the TUI to the executor', async () => {
    /**
     * Auditor issue: if recordExclusive throws, the launch is rolled back and
     * the executor session is aborted and deleted. The TUI must NOT have been
     * navigated onto the (now-deleted) executor session before persistence
     * failed. The user stays put instead of being stranded on a deleted session.
     */
    const throwingRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: () => { throw new Error('outcome signal write failed') },
    }
    const { tools, forgeClient } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } }, throwingRepo)

    const result = await tools['execute-plan'].execute(
      { title: 'Rollback without nav', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-rollback-nav-1' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')

    // No TUI selectSession call was made — the deferred navigation was never
    // applied because the launch did not commit.
    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.length).toBe(0)

    // The executor was still aborted and deleted by the rollback.
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0][0].sessionID).toBe('ses_fake_1')
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')
  })

  test('audited launch that loses arbitration to a concurrent cancellation rolls back WITHOUT navigating the TUI to the executor', async () => {
    /**
     * Auditor issue: when recordExclusive returns 'cancelled' because the
     * cross-process resolver wrote a cancellation mid-flight, the launch is
     * rolled back and reported abandoned. The TUI must NOT have been navigated
     * onto the (now-deleted) executor session.
     */
    const raceRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: (row) => {
        // Concurrent panel cancellation arrives just before the outcome commit.
        createLoopNewSessionCancellationsRepo(db).cancelExclusive({ projectId: row.projectId, requestNonce: row.requestNonce, hostSessionId: row.hostSessionId })
        return createLoopNewSessionOutcomesRepo(db).recordExclusive(row)
      },
    }
    const { tools, forgeClient } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } }, raceRepo)

    const result = await tools['execute-plan'].execute(
      { title: 'Loses arbitration', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'race-audited-nav' },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')
    expect(resultStr).toContain('abandoned')

    // No TUI selectSession call was made — the deferred navigation was never
    // applied because the launch did not commit.
    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.length).toBe(0)

    // The executor was aborted and deleted by the rollback.
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0][0].sessionID).toBe('ses_fake_1')
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')
  })

  test('an audited launch that loses arbitration to a concurrently-committed same-nonce outcome rolls back its own session/loop and returns the authoritative result', async () => {
    /**
     * Auditor bug 1 (concurrent same-nonce race): two concurrent same-nonce
     * dispatches both pass the pre-entry replay guard before either commits.
     * The first commits an authoritative outcome row; the second's
     * `recordExclusive` must observe `'superseded'`, roll back its own
     * freshly-provisioned session+loop (abort + clear timers + drop state +
     * delete session), and return ok pointing at the first launch's session —
     * so two concurrent same-nonce dispatches leave exactly one session/loop
     * and both callers see the same authoritative result. (The previous
     * implementation used `ON CONFLICT DO UPDATE`, so the second writer
     * silently overwrote the row while both sessions/loops kept running.)
     *
     * Simulates the race via a `recordExclusive` override that seeds the
     * authoritative outcome row just before this launch's arbitration point —
     * mirroring the real concurrent commit — and delegates to the real repo to
     * observe the now-superseded state.
     */
    const priorSessionId = 'prior-commit-session'
    const priorLoopName = 'prior-commit-loop'
    const raceRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: (row) => {
        // Seed the authoritative outcome row as if a concurrent same-nonce
        // launch had committed it just before THIS launch's arbitration point
        // (after the attach step already provisioned this launch's session).
        const underlying = createLoopNewSessionOutcomesRepo(db)
        underlying.recordExclusive({
          projectId: row.projectId,
          requestNonce: row.requestNonce,
          hostSessionId: row.hostSessionId,
          outcomeSessionId: priorSessionId,
          loopName: priorLoopName,
          kind: 'audited',
        })
        return underlying.recordExclusive(row)
      },
    }
    const { tools, forgeClient, loopService, loopHandler } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } }, raceRepo)
    const clearTimersSpy = vi.spyOn(loopHandler, 'clearLoopTimers')

    const nonce = 'race-superseded-audited'
    const result = await tools['execute-plan'].execute(
      { title: 'Loses superseded race', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: nonce },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')
    // Both callers see the same authoritative session id (the prior commit's).
    expect(resultStr).toContain(priorSessionId)
    expect(resultStr).toContain(priorLoopName)

    // THIS launch's freshly-provisioned session/loop were rolled back:
    // exactly one active loop (the prior commit's name), and the executor
    // was aborted and deleted.
    const active = loopService.listActive()
    expect(active.length).toBe(0)
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    const abortedOwnSession = abortCalls.some((c: any[]) => c[0].sessionID === 'ses_fake_1')
    expect(abortedOwnSession).toBe(true)
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    const deletedOwnSession = deleteCalls.some((c: any[]) => c[0].sessionID === 'ses_fake_1')
    expect(deletedOwnSession).toBe(true)
    expect(clearTimersSpy).toHaveBeenCalledTimes(1)

    // The authoritative outcome row is preserved verbatim (NOT overwritten by
    // the losing writer — the bug 1 regression).
    const persisted = createLoopNewSessionOutcomesRepo(db).findByRequestNonce(projectId, nonce)
    expect(persisted?.outcomeSessionId).toBe(priorSessionId)
    expect(persisted?.loopName).toBe(priorLoopName)
    expect(persisted?.kind).toBe('audited')

    // No duplicate TUI navigation on the (deleted) own-executor session.
    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.some((c: any[]) => c[0].sessionID === 'ses_fake_1')).toBe(false)
  })

  test('a one-shot fallback that loses arbitration to a concurrently-committed same-nonce one-shot outcome rolls back its own session and returns the authoritative result', async () => {
    /**
     * Auditor bug 1 (one-shot variant of the concurrent race): two concurrent
     * same-nonce one-shot dispatches both pass the pre-entry replay guard
     * before either commits; the second observes `'superseded'` and rolls
     * back its own session, returning ok pointing at the first's session id.
     */
    const priorSessionId = 'prior-one-shot-session'
    const raceRepo: LoopNewSessionOutcomesRepo = {
      ...createLoopNewSessionOutcomesRepo(db),
      recordExclusive: (row) => {
        const underlying = createLoopNewSessionOutcomesRepo(db)
        underlying.recordExclusive({
          projectId: row.projectId,
          requestNonce: row.requestNonce,
          hostSessionId: row.hostSessionId,
          outcomeSessionId: priorSessionId,
          loopName: null,
          kind: 'one-shot',
        })
        return underlying.recordExclusive(row)
      },
    }
    const { tools, forgeClient, loopService } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
    }, raceRepo)

    const nonce = 'race-superseded-one-shot'
    const result = await tools['execute-plan'].execute(
      { title: 'Loses one-shot superseded race', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: nonce },
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('one-shot fallback')
    expect(resultStr).toContain(priorSessionId)

    // No loop state (one-shot registers no loop), and the own-provisioned
    // session was rolled back (aborted + deleted).
    expect(loopService.listActive().length).toBe(0)
    const abortCalls = (forgeClient.session.abort as any).mock.calls
    const abortedOwnSession = abortCalls.some((c: any[]) => c[0].sessionID === 'ses_fake_1')
    expect(abortedOwnSession).toBe(true)
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    const deletedOwnSession = deleteCalls.some((c: any[]) => c[0].sessionID === 'ses_fake_1')
    expect(deletedOwnSession).toBe(true)

    // The authoritative one-shot outcome is preserved verbatim.
    const persisted = createLoopNewSessionOutcomesRepo(db).findByRequestNonce(projectId, nonce)
    expect(persisted?.outcomeSessionId).toBe(priorSessionId)
    expect(persisted?.loopName).toBeNull()
    expect(persisted?.kind).toBe('one-shot')
  })

  test('a one-shot fallback with selectSessionTiming=after-create navigates the TUI before the prompt (preserved legacy lifecycle)', async () => {
    /**
     * Auditor bug 2: the extracted one-shot fallback ignored
     * `selectSessionTiming === 'after-create'`. The legacy one-shot handler
     * selected the new session right after creation — BEFORE prompting — so an
     * early prompt failure still left the user on the (intact) new session
     * rather than never navigating at all. The fix restores after-create
     * selection before the prompt and skips the duplicate post-prompt
     * selection for that timing.
     *
     * Uses `service.dispatch` (the plan-approval-style entry point) so the
     * lifecycle drives the one-shot path with explicit after-create timing.
     */
    const { service, forgeClient, calls } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
    })

    const result = await service.dispatch(
      { surface: 'approval-hook', projectId, directory: TEST_DIR, sourceSessionId: 'src-approval', requestId: 'after-create-nonce' },
      {
        type: 'plan.execute.newSession',
        source: { kind: 'inline', planText: '# Plan\nDo the thing' },
        title: 'After-create one-shot',
        executionModel: 'test/exec',
        lifecycle: {
          selectSession: true,
          selectSessionTiming: 'after-create',
          deleteSessionOnPromptFailure: true,
        },
      },
    )

    expect(result.ok).toBe(true)

    // The after-create selection happened exactly once, with the one-shot
    // session and no workspace.
    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.length).toBe(1)
    expect(selectCalls[0][0].sessionID).toBe('ses_fake_1')
    expect(selectCalls[0][0].workspace).toBeUndefined()

    // Selection HAPPENED BEFORE the prompt — the call order in the recorded
    // `calls` array proves the TUI was navigated to the new session before
    // the host prompt was queued.
    const firstSelectIdx = calls.findIndex((c: { method: string }) => c.method === 'tui.selectSession')
    const firstPromptIdx = calls.findIndex((c: { method: string }) => c.method === 'session.promptAsync')
    expect(firstSelectIdx).toBeGreaterThanOrEqual(0)
    expect(firstPromptIdx).toBeGreaterThanOrEqual(0)
    expect(firstSelectIdx).toBeLessThan(firstPromptIdx)
  })

  test('a one-shot fallback with selectSessionTiming=after-create navigates BEFORE the prompt even when the prompt then fails', async () => {
    /**
     * Auditor bug 2 (failure scenario): the AFTER-CREATE selection must occur
     * even when the prompt subsequently fails. The legacy behavior located the
     * user on the new session before sending the plan; if the prompt errored
     * afterwards, the user remained navigated (not stranded) and the failed
     * session was deleted per `deleteSessionOnPromptFailure`. The previous
     * post-prompt-only navigation never ran because the prompt error path
     * short-circuited — the user was never navigated at all.
     */
    const { service, forgeClient, calls } = setupTools(
      {
        session: {
          create: async () => ({ id: 'ses_after_create_fail' }),
          promptAsync: async () => { throw new Error('prompt failed') },
          delete: async () => {},
          abort: async () => {},
          get: async () => ({ id: 'ses_after_create_fail' }),
          messages: async () => [],
          status: async () => ({}),
          list: async () => [],
          update: async () => {},
        },
      },
      {
        loop: { enabled: false },
        executionModel: 'test/exec',
      },
    )

    const result = await service.dispatch(
      { surface: 'approval-hook', projectId, directory: TEST_DIR, sourceSessionId: 'src-approval', requestId: 'after-create-fail-nonce' },
      {
        type: 'plan.execute.newSession',
        source: { kind: 'inline', planText: '# Plan\nDo the thing' },
        title: 'After-create one-shot failure',
        executionModel: 'test/exec',
        lifecycle: {
          selectSession: true,
          selectSessionTiming: 'after-create',
          deleteSessionOnPromptFailure: true,
        },
      },
    )

    // The prompt failed and the launch is reported failed (no outcome to
    // commit for a failed one-shot prompt).
    expect(result.ok).toBe(false)

    // But the after-create selection still happened, exactly once, and BEFORE
    // the prompt was attempted.
    const selectCalls = (forgeClient.tui.selectSession as any).mock.calls
    expect(selectCalls.length).toBe(1)
    expect(selectCalls[0][0].sessionID).toBe('ses_after_create_fail')
    const firstSelectIdx = calls.findIndex((c: { method: string }) => c.method === 'tui.selectSession')
    const firstPromptIdx = calls.findIndex((c: { method: string }) => c.method === 'session.promptAsync')
    expect(firstSelectIdx).toBeLessThan(firstPromptIdx)

    // The failed-prompt session was deleted (deleteSessionOnPromptFailure=true).
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.some((c: any[]) => c[0].sessionID === 'ses_after_create_fail')).toBe(true)
  })

  test('replaying a committed requestNonce returns the original session/loop and provisions nothing additional (idempotent)', async () => {
    /**
     * Auditor bug 1: the host agent may retry the generated execute-plan tool
     * instruction (or the panel may replay the same nonce). The prior commit
     * created another session + audited loop before recordExclusive overwrote
     * the existing outcome row — pairing the original loop with a duplicate
     * session and orphaning one of the two loops. The handler now consults the
     * committed outcome row keyed by the requestNonce BEFORE provisioning and,
     * when present, returns that prior result without creating resources.
     */
    const { tools, forgeClient, loopService, newSessionOutcomesRepo } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const nonce = 'nonce-replay-1'
    const args = { title: 'Replay audited', plan: '# Plan\nIdempotent replay', mode: 'new-session', requestNonce: nonce } as any

    const first = await tools['execute-plan'].execute(args, { sessionID: 'src-session' } as any)
    const firstStr = buildResultString(first)
    expect(firstStr).toContain('Goal loop activated')

    // Capture the original loop name + executor session committed by the first
    // launch — both are the authoritative artifacts the replay must return.
    const originalLoops = loopService.listActive()
    expect(originalLoops.length).toBe(1)
    const originalLoopName = originalLoops[0].loopName!
    const originalSessionId = originalLoops[0].sessionId

    const firstCreateCalls = (forgeClient.session.create as any).mock.calls.length
    const firstPromptCalls = (forgeClient.session.promptAsync as any).mock.calls.length

    const second = await tools['execute-plan'].execute(args, { sessionID: 'src-session' } as any)
    const secondStr = buildResultString(second)
    expect(secondStr).toContain('Goal loop activated')

    // No additional session/prompt/workspace were provisioned.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(firstCreateCalls)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(firstPromptCalls)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)

    // The replayed result references the original session id and loop name.
    expect(secondStr).toContain(originalSessionId)
    expect(secondStr).toContain(originalLoopName)

    // Still exactly the one originally-committed loop — no duplicate registered.
    expect(loopService.listActive().length).toBe(1)
    expect(loopService.listActive()[0].loopName).toBe(originalLoopName)

    // The committed outcome row was NOT rewritten (createdAt unchanged) and the
    // server-side handler short-circuited without re-recording.
    const outcome = newSessionOutcomesRepo.findByRequestNonce(projectId, nonce)
    expect(outcome).not.toBeNull()
    expect(outcome!.outcomeSessionId).toBe(originalSessionId)
    expect(outcome!.loopName).toBe(originalLoopName)
  })

  test('replaying a committed requestNonce returns the one-shot fallback session without provisioning anything additional', async () => {
    /**
     * Auditor bug 1 (one-shot variant): the disabled/global fallback records an
     * authoritative outcome row keyed by the nonce with `kind='one-shot'` and
     * no loop name. A replay with the same nonce must short-circuit before
     * provisioning — the original one-shot session is the only artifact.
     */
    const { tools, forgeClient, loopService, newSessionOutcomesRepo } = setupTools(undefined, {
      loop: { enabled: false },
      executionModel: 'test/exec',
    })

    const nonce = 'nonce-replay-one-shot'
    const args = { title: 'Replay one-shot', plan: '# Plan\nIdempotent one-shot', mode: 'new-session', requestNonce: nonce } as any

    const first = await tools['execute-plan'].execute(args, { sessionID: 'src-session' } as any)
    const firstStr = buildResultString(first)
    expect(firstStr).toContain('one-shot fallback')

    // one-shot never registers a loop
    expect(loopService.listActive().length).toBe(0)
    const firstCreateCalls = (forgeClient.session.create as any).mock.calls.length
    const firstPromptCalls = (forgeClient.session.promptAsync as any).mock.calls.length

    const originalOutcome = newSessionOutcomesRepo.findByRequestNonce(projectId, nonce)
    expect(originalOutcome).not.toBeNull()
    expect(originalOutcome!.kind).toBe('one-shot')
    expect(originalOutcome!.loopName).toBeNull()
    const originalSessionId = originalOutcome!.outcomeSessionId

    const second = await tools['execute-plan'].execute(args, { sessionID: 'src-session' } as any)
    const secondStr = buildResultString(second)
    expect(secondStr).toContain('one-shot fallback')
    expect(secondStr).toContain(originalSessionId)

    // Replays do not provision additional resources.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(firstCreateCalls)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(firstPromptCalls)

    // No loop was registered (and none on replay either).
    expect(loopService.listActive().length).toBe(0)

    // The committed one-shot outcome row is unchanged.
    const outcomeAfter = newSessionOutcomesRepo.findByRequestNonce(projectId, nonce)
    expect(outcomeAfter).not.toBeNull()
    expect(outcomeAfter!.outcomeSessionId).toBe(originalSessionId)
    expect(outcomeAfter!.loopName).toBeNull()
    expect(outcomeAfter!.createdAt).toBe(originalOutcome!.createdAt)
  })

  test('concurrent same-name attach conflict deletes the losing launch session while the winning loop stays active (no orphan)', async () => {
    /**
     * Auditor bug 2: non-prompt attach failures (e.g. `already_attached` from a
     * concurrent same-name launch race) used to only delete the freshly-created
     * session when `deleteSessionOnPromptFailure` was enabled. The plan-approval
     * caller disables it, so the loser would leave an orphan session paired
     * with the panel's failure toast. The handler now always deletes a session
     * that never attached (provider-limit restart state excluded), independently
     * of the prompt-failure lifecycle policy.
     *
     * Simulates the race by:
     *   1. Pre-seeding a "winning" running loop under the exact name the loser
     *      will derive (so `attachLoopToSession` returns `already_attached`).
     *   2. Pinning `generateUniqueLoopName` to that name so the loser doesn't
     *      pick a suffixed alternative (mirrors the real pre-persist race).
     *   3. Driving the loser through the plan-approval lifecycle
     *      (`deleteSessionOnPromptFailure: false`) via `service.dispatch`.
     */
    const { forgeClient, loopService, loopHandler, service } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const contestedName = 'contested-audited-loop'
    // The winning launch — already running under the exact name the loser will
    // derive; ships its own executor session so it visibly survives.
    loopService.setState(contestedName, {
      active: true,
      sessionId: 'sess_winner',
      loopName: contestedName,
      worktreeDir: TEST_DIR,
      projectDir: TEST_DIR,
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      phase: 'coding',
      status: 'running' as const,
      worktree: false,
      sandbox: false,
      auditCount: 0,
      errorCount: 0,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      kind: 'goal',
      goal: '# Plan\nOriginal commit',
      executorSessionId: 'sess_winner',
      hostSessionId: 'src-session',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
    } as any)
    loopService.registerLoopSession('sess_winner', contestedName)

    // Pin generateUniqueLoopName so the loser derives the contested name despite
    // the existing row (the real race: both queries ran before either persisted).
    const originalGenerate = loopHandler.loop.generateUniqueLoopName.bind(loopHandler.loop)
    ;(loopHandler.loop as any).generateUniqueLoopName = vi.fn(() => contestedName)

    const result = await service.dispatch(
      { surface: 'approval-hook', projectId, directory: TEST_DIR, sourceSessionId: 'src-approval' },
      {
        type: 'plan.execute.newSession',
        source: { kind: 'inline', planText: '# Plan\nLoser launch' },
        title: 'Contested Launch',
        loopName: contestedName,
        executionModel: 'test/exec',
        auditorModel: 'test/auditor',
        lifecycle: {
          selectSession: true,
          selectSessionTiming: 'after-prompt',
          abortSourceSession: false,
          deleteSessionOnPromptFailure: false,
          returnToSourceOnPromptFailure: false,
        },
      },
    )

    ;(loopHandler.loop as any).generateUniqueLoopName = originalGenerate

    expect(result.ok).toBe(false)

    // The loser created a fresh executor session then lost the attach race.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
    const loserSessionId = (forgeClient.session.create as any).mock.calls[0][0] as Record<string, unknown>
    expect(loserSessionId).toBeDefined()

    // The orphan session was deleted despite deleteSessionOnPromptFailure=false.
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.length).toBe(1)
    // The deleted session is the loser's freshly-created executor (ses_fake_1
    // from the fake client), NOT the winner's 'sess_winner'.
    expect(deleteCalls[0][0].sessionID).toBe('ses_fake_1')

    // The winning loop is untouched and remains the sole active loop.
    const survivors = loopService.listActive()
    expect(survivors.length).toBe(1)
    expect(survivors[0].loopName).toBe(contestedName)
    expect(survivors[0].sessionId).toBe('sess_winner')
    expect(survivors[0].status).toBe('running')
  })

  test('audited-loop prompt_failed preserves the failed session when deleteSessionOnPromptFailure=false (plan-approval lifecycle)', async () => {
    /**
     * Final-audit bug 1: in the audited new-session path, any non-provider-limit
     * attach failure used to unconditionally delete the freshly-created session,
     * regardless of `deleteSessionOnPromptFailure`. The plan-approval caller
     * sets `deleteSessionOnPromptFailure: false` precisely so that a transient
     * prompt failure leaves the replacement session open (its source was already
     * aborted). Deleting it would strand the user with no open replacement.
     *
     * The fix distinguishes `prompt_failed` (honor the lifecycle policy) from
     * pre-attach failures like `already_attached` (always delete the orphan).
     * This test drives the audited path with a throwing `promptAsync` (so
     * `attachLoopToSession` returns `prompt_failed`) under the plan-approval
     * lifecycle and asserts the created session survives.
     */
    const { service, forgeClient, loopService } = setupTools(
      {
        session: {
          create: async () => ({ id: 'ses_loop_prompt_fail' }),
          promptAsync: async () => { throw new Error('prompt failed') },
          delete: async () => {},
          abort: async () => {},
          get: async () => ({ id: 'ses_loop_prompt_fail' }),
          messages: async () => [],
          status: async () => ({}),
          list: async () => [],
          update: async () => {},
        },
      },
      { loop: { defaultMaxIterations: 3 }, executionModel: 'test/exec' },
    )

    const result = await service.dispatch(
      { surface: 'approval-hook', projectId, directory: TEST_DIR, sourceSessionId: 'src-approval' },
      {
        type: 'plan.execute.newSession',
        source: { kind: 'inline', planText: '# Plan\nDo the thing' },
        title: 'Audited prompt failure',
        executionModel: 'test/exec',
        lifecycle: {
          selectSession: false,
          deleteSessionOnPromptFailure: false,
          returnToSourceOnPromptFailure: false,
        },
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('prompt_failed')
    }

    // The session is preserved (deleteSessionOnPromptFailure=false) so the
    // user-facing replacement session is not stranded after source abort.
    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.some((c: any[]) => c[0].sessionID === 'ses_loop_prompt_fail')).toBe(false)

    // The failed launch did not register a loop row (attachLoopToSession
    // self-cleans on prompt_failed).
    expect(loopService.listActive().length).toBe(0)
  })

  test('audited-loop prompt_failed deletes the failed session when deleteSessionOnPromptFailure=true (execute-plan tool lifecycle)', async () => {
    /**
     * Companion to the previous test: the execute-plan tool path sets
     * `deleteSessionOnPromptFailure: true`, so a `prompt_failed` attach result
     * MUST delete the orphan session it created (the panel will surface failure
     * and the user can retry cleanly). The fix preserves this policy while only
     * carving out the plan-approval `delete=false` case.
     */
    const { service, forgeClient, loopService } = setupTools(
      {
        session: {
          create: async () => ({ id: 'ses_loop_prompt_fail_del' }),
          promptAsync: async () => { throw new Error('prompt failed') },
          delete: async () => {},
          abort: async () => {},
          get: async () => ({ id: 'ses_loop_prompt_fail_del' }),
          messages: async () => [],
          status: async () => ({}),
          list: async () => [],
          update: async () => {},
        },
      },
      { loop: { defaultMaxIterations: 3 }, executionModel: 'test/exec' },
    )

    const result = await service.dispatch(
      { surface: 'approval-hook', projectId, directory: TEST_DIR, sourceSessionId: 'src-approval' },
      {
        type: 'plan.execute.newSession',
        source: { kind: 'inline', planText: '# Plan\nDo the thing' },
        title: 'Audited prompt failure delete',
        executionModel: 'test/exec',
        lifecycle: {
          selectSession: false,
          deleteSessionOnPromptFailure: true,
          returnToSourceOnPromptFailure: false,
        },
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('prompt_failed')
    }

    const deleteCalls = (forgeClient.session.delete as any).mock.calls
    expect(deleteCalls.some((c: any[]) => c[0].sessionID === 'ses_loop_prompt_fail_del')).toBe(true)

    expect(loopService.listActive().length).toBe(0)
  })

  test('a direct new-session launch (no crossProcess, no requestNonce) provisions an audited goal loop (in-process confirmation)', async () => {
    /**
     * Final-audit fix: the bundled `/execute-plan` command prompt instructs the
     * agent to call this tool with `mode='new-session'`, a title, and a plan —
     * it has no nonce source and never sets `crossProcess`. A direct launch is
     * confirmed in-process by the tool's own return value (not by a polled
     * cross-process outcome), so it needs no correlation nonce. The previous
     * blanket rejection of nonce-free new-session calls blocked every direct
     * `/execute-plan` New session launch.
     */
    const { tools, forgeClient, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Direct launch', plan: '# Plan\nDo the thing', mode: 'new-session' } as any,
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')

    // A fresh executor session was created and prompted with the audited
    // goal continuation prompt (not the raw plan text).
    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(1)
    const promptCall = (forgeClient.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.parts[0].text).toContain('Do the thing')
    expect(promptCall.parts[0].text).not.toBe('# Plan\nDo the thing')
    expect(promptCall.workspace).toBeUndefined()

    // No worktree/sandbox resources were provisioned (worktree:false goal loop).
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)

    // The audited goal loop is the sole active loop with worktree=false.
    const active = loopService.listActive()
    expect(active.length).toBe(1)
    expect(active[0].kind).toBe('goal')
    expect(active[0].worktree).toBe(false)
    expect(active[0].sessionId).toBe('ses_fake_1')
    expect(active[0].executorSessionId).toBe('ses_fake_1')
    expect(active[0].hostSessionId).toBe('src-session')
  })

  test('a malformed cross-process request (crossProcess=true, no requestNonce) is rejected before any session or loop is provisioned', async () => {
    /**
     * Final-audit fix regression: the TUI execute-plan panel launches New
     * session cross-process via host-agent `promptAsync`, minting a nonce and
     * setting `crossProcess: true`. If the host agent drops the nonce but keeps
     * `crossProcess: true`, the panel cannot confirm or cancel the launch — a
     * timeout + retry would then start a duplicate loop. The server must reject
     * such a malformed cross-process request BEFORE provisioning anything.
     */
    const { tools, forgeClient, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Malformed cross-process', plan: '# Plan\nDo the thing', mode: 'new-session', crossProcess: true } as any,
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('requestNonce')
    expect(resultStr).toContain('cross-process')

    // No session, no prompt, no loop was provisioned — the rejection happened
    // before any resource creation.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect(loopService.listActive().length).toBe(0)
  })

  test('a cross-process launch without a plan argument resolves the staged plan by requestNonce and launches the audited loop', async () => {
    /**
     * Staged-plan protocol: the TUI panel writes the full plan text into
     * `loop_new_session_requests` keyed by the launch nonce BEFORE dispatching
     * the host instruction, and the host agent passes only the nonce. The
     * execute-plan tool must resolve the staged plan as the inline source —
     * never the host session's plan store — and launch normally.
     */
    const { tools, loopService, newSessionRequestsRepo } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const nonce = 'nonce-staged-plan-1'
    const stagedPlanText = '# Plan\nDo the staged thing'
    newSessionRequestsRepo.stagePlan({ projectId, requestNonce: nonce, planText: stagedPlanText })

    const result = await tools['execute-plan'].execute(
      { title: 'Staged plan launch', mode: 'new-session', crossProcess: true, requestNonce: nonce } as any,
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Goal loop activated')

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    expect(active[0].kind).toBe('goal')
    expect(active[0].goal).toContain('Do the staged thing')
  })

  test('a cross-process launch whose staged plan is missing is rejected before any session or loop is provisioned', async () => {
    /**
     * The panel stages the plan pre-dispatch, so a missing staged row implies
     * it was pruned/expired or the server reads a different database. The tool
     * must fail clearly and must NOT fall back to the session plan store (that
     * could execute the wrong plan) or provision anything.
     */
    const { tools, forgeClient, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })

    const result = await tools['execute-plan'].execute(
      { title: 'Missing staged plan', mode: 'new-session', crossProcess: true, requestNonce: 'nonce-never-staged' } as any,
      { sessionID: 'src-session' } as any,
    )

    const resultStr = buildResultString(result)
    expect(resultStr).toContain('Failed to start new session')
    expect(resultStr).toContain('staged plan')

    // Nothing was provisioned — the rejection happened before any resource creation.
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.promptAsync as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect(loopService.listActive().length).toBe(0)
  })

  test('new-session purges orphaned review findings for a reused loop name (tool threads reviewFindingsRepo)', async () => {
    /**
     * Final-audit fix regression: when an earlier loop of the same name expired
     * and its loops row was swept while its review_findings rows remained
     * (no FK to cascade), a later New session reusing that name used to inherit
     * the stale findings — keeping its audits dirty and preventing clean
     * completion. The execute-plan tool must thread ctx.reviewFindingsRepo into
     * the execution service so attachLoopToSession's defensive purge clears
     * them at attach.
     */
    const { tools, loopService } = setupTools(undefined, { loop: { defaultMaxIterations: 5 } })
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopsRepo = createLoopsRepo(db)

    // Mirror the handler's name derivation: generateUniqueLoopName(slugify(title)).
    // No loops row exists for this slug, so the unique name is the slug itself.
    const expectedName = loopService.generateUniqueLoopName(slugify('Reuse add feature'))

    // Seed orphaned findings tied only to the loop name (no loops row),
    // simulating a swept-but-not-FK-cascaded prior loop of the same name.
    reviewFindingsRepo.write({
      projectId, loopName: expectedName,
      file: 'src/a.ts', line: 1, severity: 'bug' as const, description: 'stale inherited finding',
    })
    expect(reviewFindingsRepo.listByLoopName(projectId, expectedName).length).toBeGreaterThan(0)
    expect(loopsRepo.get(projectId, expectedName)).toBeNull()

    await tools['execute-plan'].execute(
      { title: 'Reuse add feature', plan: '# Plan\nFresh run', mode: 'new-session' } as any,
      { sessionID: 'src-session' } as any,
    )

    const active = loopService.listActive()
    expect(active.length).toBe(1)
    expect(active[0].loopName).toBe(expectedName)

    // The reused loop name now has zero findings — the stale ones were purged.
    expect(reviewFindingsRepo.listByLoopName(projectId, expectedName)).toEqual([])
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

  function setupTools(clientOverrides?: Parameters<typeof createFakeForgeClient>[0], configOverride: any = {}) {
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
      config: configOverride,
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    return { tools, forgeClient, loopService }
  }

  test('warns when the new session resolves to a different opencode project than the plugin scope', async () => {
    const { tools } = setupTools({
      session: {
        get: async () => ({ id: 'ses_fake_1', projectID: 'other-project' }),
      },
    } as any)

    const result = await tools['execute-goal'].execute(
      { goal: 'Ship it' } as any,
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

    const result = await tools['execute-goal'].execute(
      { goal: 'Ship it' } as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('Goal loop activated')
    expect(result).not.toContain('WARNING: The new session belongs to project')
  })

  test('rejects a blank goal without provisioning any workspace or session', async () => {
    const { tools, forgeClient } = setupTools()

    const result = await tools['execute-goal'].execute(
      { goal: '   \n  ' } as any,
      { sessionID: 'src-session' } as any,
    )

    expect(result).toContain('Goal text is required')
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.session.create as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
  })

  test('dispatches a managed goal loop in a new worktree session and persists goal text', async () => {
    const { tools, forgeClient, loopService } = setupTools()

    const result = await tools['execute-goal'].execute(
      { goal: 'Ship the execute-goal feature end to end' } as any,
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
    expect(state.goal).toBe('Ship the execute-goal feature end to end')
    expect(state.phase).toBe('coding')
    expect(state.totalSections).toBe(0)

    const plansRepo = createPlansRepo(db)
    expect(plansRepo.getForLoop(projectId, state.loopName)).toBeNull()

    const loopsRepo = createLoopsRepo(db)
    const large = loopsRepo.getLarge(projectId, state.loopName)
    expect(large?.goal).toBe('Ship the execute-goal feature end to end')
  })

  test('does not regress execute-plan new-session mode (still creates a fresh session)', async () => {
    const { tools, forgeClient } = setupTools()

    await tools['execute-plan'].execute(
      { title: 'Add feature', plan: '# Plan\nDo the thing', mode: 'new-session', requestNonce: 'nonce-regression-1' },
      { sessionID: 'src-session' } as any,
    )

    expect((forgeClient.session.create as any).mock.calls.length).toBe(1)
    expect((forgeClient.workspace.warp as any).mock.calls.length).toBe(0)
    expect((forgeClient.workspace.create as any).mock.calls.length).toBe(0)
  })
})
