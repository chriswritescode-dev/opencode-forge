import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoop } from '../../src/loop/runtime'
import type { LoopState } from '../../src/loop/state'
import type { Logger, PluginConfig } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const assistantMessage = (text: string) => [
  {
    info: { role: 'assistant', finish: 'stop' },
    parts: [{ type: 'text', text }],
  },
]

const sectionSummaryText = (done: string) =>
  `<!-- section-summary:start -->
### Done
- ${done}
### Deviations
- None
### Follow-ups
- None
<!-- section-summary:end -->`

describe('Runtime transition logging', () => {
  let db: Database
  let loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  let loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string
  const projectId = 'test-project'
  const loopName = 'logged-loop'

  /**
   * Build a fresh loop instance backed by the shared DB but with a per-test
   * fake ForgeClient. The shared `loop` field is not retained so each test
   * starts from a clean loops table state (the prior instance writes rows via
   * setState on `start`).
   */
  function buildLoop(opts: {
    clientTweaks?: Parameters<typeof createFakeForgeClient>[0]
    getConfig?: () => PluginConfig
  }): ReturnType<typeof createLoop> {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
      loopTransitionsRepo,
    )
    const { client } = createFakeForgeClient(opts.clientTweaks)
    return createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      client,
      logger: mockLogger,
      getConfig: opts.getConfig ?? (() => ({}) as PluginConfig),
      loopService,
      loopSessionUsageRepo,
    })
  }

  function buildInitialState(overrides: Partial<LoopState>): LoopState {
    return {
      active: true,
      sessionId: 'audit-sess',
      loopName,
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp/proj',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      errorCount: 0,
      auditCount: 1,
      status: 'running',
      phase: 'auditing',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      kind: 'plan',
      ...overrides,
    } as LoopState
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runtime-transition-logging-'))
    db = new Database(join(tempDir, 'runtime-transition-logging.db'))
    setupLoopsTestDb(db)

    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    loopSessionUsageRepo = createLoopSessionUsageRepo(db)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function tickIdle(loopInstance: ReturnType<typeof createLoop>, sessionId: string): Promise<void> {
    return loopInstance.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: sessionId },
    })
  }

  function getRows() {
    return loopTransitionsRepo.listForLoop(projectId, loopName)
  }

  describe('Bug 1: no phantom final_audit_fix row on iteration cap', () => {
    test('capped dirty final audit records only the terminate row, not a final_audit_fix row', async () => {
      const state = buildInitialState({
        phase: 'final_auditing',
        iteration: 5,
        maxIterations: 5,
        currentSectionIndex: 0,
        totalSections: 2,
      })

      reviewFindingsRepo.write({
        projectId,
        loopName,
        file: 'src/x.ts',
        line: 1,
        severity: 'bug',
        description: 'unfixed bug',
        sectionIndex: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: { session: { messages: async () => assistantMessage('final audit still has findings') } },
      })
      loopInstance.start({ state })

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].transitionKind).toBe('terminate')
      expect(rows[0].fromPhase).toBe('final_auditing')
      expect(rows[0].toPhase).toBeNull()
      expect(rows[0].eventType).toBe('max_iterations')
    })
  })

  describe('Bug 2a: rewind fast-path produces exactly one row', () => {
    test('rewind-all-completed jump to final audit logs a section-clean/start-final-audit row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        currentSectionIndex: 1,
        totalSections: 3,
      })

      // Insert all 3 sections as completed with summaries so the digest matches totalSections.
      // Insert AFTER loopInstance.start writes the parent loops row (section_plans
      // has an FK to loops(project_id, loop_name)).
      const loopInstance = buildLoop({
        clientTweaks: { session: { messages: async () => assistantMessage(sectionSummaryText('completed section 1 cleanly')) } },
      })
      loopInstance.start({ state })

      for (let i = 0; i < 3; i++) {
        db.run(
          `INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, started_at, completed_at, summary_done, summary_deviations, summary_follow_ups, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [projectId, loopName, i, `Section ${i + 1}`, `Content ${i + 1}`, 'completed', 0, Date.now(), Date.now(), `Done ${i}`, null, null, Date.now()],
        )
      }

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].eventType).toBe('section-clean')
      expect(rows[0].transitionKind).toBe('start-final-audit')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('final_auditing')
      expect(rows[0].sectionIndex).toBe(1)
    })
  })

  describe('Bug 2b: audit-error continuation records the recovery row', () => {
    test('audit-error branch in runAuditingPhase logs auditing → coding error-recovery row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant message carrying a non-provider error so
            // detectAndHandleAssistantError returns assistantErrorDetected=true
            // (error name/message do not match the provider/auth/model/api regex
            // nor the provider-limit classifier).
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
          },
        },
      })
      loopInstance.start({ state })

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
    })
  })

  describe('Bug 2c: session-error recovery logs the recovery row', () => {
    test('auditing session.error event rolls back to coding and logs the recovery row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 2,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: { session: { messages: async () => [] } },
      })
      loopInstance.start({ state })

      await loopInstance.tick({
        type: 'session.error',
        properties: {
          sessionID: 'audit-sess',
          error: { name: 'ExecutionError', data: { message: 'audit session blew up' } },
        },
      })

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].eventType).toBe('audit-session-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
    })
  })

  describe('Bug 3: post-action entry row precedes the terminal row by id', () => {
    test('audit-clear redirect into post_action logs the phase row before the terminate row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
      })

      // Audit-clear: assistant text present, no outstanding findings.
      // Post-action enabled: enterPostActionPhase is invoked.
      // promptAsync throws: terminateLoop is called inside enterPostActionPhase.
      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            messages: async () => assistantMessage('audit clean, no findings'),
            promptAsync: async () => { throw new Error('post-action prompt delivery failed') },
          },
        },
        getConfig: () => ({ loop: { postAction: { enabled: true, skill: 'polish-output' } } }) as PluginConfig,
      })
      loopInstance.start({ state })

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      expect(rows).toHaveLength(2)
      // ID order: phase row first, terminate row second (chronological).
      expect(rows[0].eventType).toBe('audit-clear')
      expect(rows[0].transitionKind).toBe('phase')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('post_action')
      expect(rows[1].eventType).toBe('completed')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].fromPhase).toBe('post_action')
      expect(rows[1].toPhase).toBeNull()
      // Strict id ordering check: the phase row's id is strictly less than the
      // terminal row's id (this is the bug-3 regression guard).
      expect(rows[0].id).toBeLessThan(rows[1].id)
    })
  })

  describe('Bug 4: failed final-audit creation leaves no phantom final_auditing row', () => {
    test('section-clean → start-final-audit with session.create failing records no transition row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        currentSectionIndex: 1,
        totalSections: 2,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Audit text carries a section-summary so the section-clean path fires.
            messages: async () => assistantMessage(sectionSummaryText('completed section 1 cleanly')),
            // session.create throws so createAuditSession returns null and
            // startFinalAuditTransition returns false WITHOUT persisting the
            // final_auditing phase or recording its start-final-audit row.
            create: async () => { throw new Error('session.create unavailable') },
          },
        },
      })
      loopInstance.start({ state })

      for (let i = 0; i < 2; i++) {
        db.run(
          `INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts, started_at, completed_at, summary_done, summary_deviations, summary_follow_ups, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [projectId, loopName, i, `Section ${i + 1}`, `Content ${i + 1}`, 'completed', 0, Date.now(), Date.now(), `Done ${i}`, null, null, Date.now()],
        )
      }

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      // No phantom final_auditing row: start-final-audit transition recording
      // is gated on successful phase persistence inside startFinalAuditTransition.
      expect(rows.filter(r => r.transitionKind === 'start-final-audit')).toHaveLength(0)
      expect(rows.filter(r => r.toPhase === 'final_auditing')).toHaveLength(0)
      // handlePromptError increments the error count but does not terminate
      // (no retryFn, errorCount starts at 0, MAX_RETRIES not yet exhausted),
      // so no terminal row is produced either.
      expect(rows.filter(r => r.transitionKind === 'terminate')).toHaveLength(0)
    })
  })

  describe('Bug 5: audit-error recovery row precedes any prompt-failure terminate row', () => {
    test('audit-error branch with a provider-limit prompt failure logs the recovery row before the terminate row', async () => {
      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant message carries a non-provider error so
            // detectAndHandleAssistantError returns assistantErrorDetected=true.
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            // The recovery continuation prompt's send fails as a provider auth
            // error — classifyProviderLimit returns non-null and handlePromptError
            // terminates immediately. We assert the rotate row precedes the
            // terminate row chronologically (by id).
            promptAsync: async () => {
              const err = new Error('auth refused')
              err.name = 'ProviderAuthError'
              throw err
            },
          },
        },
      })
      loopInstance.start({ state })

      await tickIdle(loopInstance, 'audit-sess')

      const rows = getRows()
      // The recovery transition row is recorded inside rotateAndSendContinuation
      // AFTER replaceSession (the phase commit) and BEFORE the prompt send,
      // so a prompt-send failure that terminates does not reverse chronology.
      expect(rows).toHaveLength(2)
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      expect(rows[1].eventType).toBe('provider_limit')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].fromPhase).toBe('coding')
      expect(rows[1].toPhase).toBeNull()
      // Strict id ordering: recovery row was inserted before the terminate row.
      expect(rows[0].id).toBeLessThan(rows[1].id)
    })
  })

  describe('Bug 6: terminateAll records one shutdown terminal row per active loop', () => {
    test('multi-loop terminateAll logs exactly one shutdown/terminate row per loop', async () => {
      const sharedLoop = buildLoop({})
      // Two active loops with distinct phases; both share the same DB-backed
      // loopsService via createLoopEventHandler wiring is unnecessary — start
      // each on the same loopInstance so the parent loops rows exist.
      sharedLoop.start({
        state: buildInitialState({
          loopName: 'loop-A',
          sessionId: 'sess-a',
          phase: 'coding',
          iteration: 2,
        }),
      })
      sharedLoop.start({
        state: buildInitialState({
          loopName: 'loop-B',
          sessionId: 'sess-b',
          phase: 'auditing',
          iteration: 3,
        }),
      })

      await sharedLoop.terminateAll()

      const rowsA = loopTransitionsRepo.listForLoop(projectId, 'loop-A')
      const rowsB = loopTransitionsRepo.listForLoop(projectId, 'loop-B')
      expect(rowsA).toHaveLength(1)
      expect(rowsB).toHaveLength(1)
      for (const r of [...rowsA, ...rowsB]) {
        expect(r.eventType).toBe('shutdown')
        expect(r.transitionKind).toBe('terminate')
        expect(r.toPhase).toBeNull()
        expect(r.status).toBe('cancelled')
        expect(r.reason).toBe('shutdown')
      }
      // Each row's fromPhase mirrors the loop's persisted phase at shutdown.
      expect(rowsA[0].fromPhase).toBe('coding')
      expect(rowsB[0].fromPhase).toBe('auditing')
    })
  })

  describe('Bug 7: terminateAll shares the terminatingLoops admission guard', () => {
    test('shutdown racing with cancel records exactly one terminal row from the canonical path', async () => {
      // Pause usage capture inside the in-flight terminateLoop (cancel) so the
      // loop is admitted (terminatingLoops.has) but still listed active when
      // terminateAll fires. Without the admission-guard check, terminateAll
      // would record a second shutdown row before the canonical cancel row lands.
      let releaseMessages: () => void = () => {}
      const messagesPaused = new Promise<void>((resolve) => {
        releaseMessages = resolve
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // terminateLoop awaits client.session.messages during usage capture.
            // Hold the promise until we have triggered terminateAll so the race
            // window is deterministic.
            messages: async () => {
              await messagesPaused
              return assistantMessage('ok')
            },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({
        state: buildInitialState({
          loopName: 'race-loop',
          sessionId: 'sess-race',
          phase: 'coding',
          iteration: 4,
        }),
      })

      // Kick off the canonical cancel path. It admits the loop into
      // terminatingLoops and then awaits usage capture on `messages`.
      const cancelPromise = loopInstance.cancel('race-loop')

      // Yield through the microtask chain (cancel → terminateLoopByName →
      // terminateLoop → captureLoopSessionUsage → client.session.messages) so
      // terminateLoop is admitted and suspended awaiting `messages` before
      // shutdown fires. A setTimeout(0) boundary drains all queued microtasks.
      await new Promise((r) => setTimeout(r, 0))

      // Shutdown fires while the cancel path is still awaiting usage capture.
      await loopInstance.terminateAll()

      // Release usage capture so the canonical cancel path completes and
      // records its terminal row.
      releaseMessages()
      await cancelPromise

      const rows = loopTransitionsRepo.listForLoop(projectId, 'race-loop')
      expect(rows).toHaveLength(1)
      expect(rows[0].transitionKind).toBe('terminate')
      // The canonical cancel path wins (not a duplicate shutdown row).
      expect(rows[0].eventType).toBe('user_aborted')
      expect(rows[0].fromPhase).toBe('coding')
      expect(rows[0].toPhase).toBeNull()
    })
  })

  describe('Bug 8: terminateLoop records the authoritative phase on final-audit provider-limit', () => {
    test('persisted final-audit error with usage-limit terminates with fromPhase=final_auditing', async () => {
      // A loop in final_auditing whose assistant message carries a provider-
      // limit error signal must terminate with fromPhase=final_auditing. This
      // guards the defensive fix in terminateLoop that adopts the authoritative
      // under-admission-guard state rather than the caller's snapshot: a stale
      // caller could have recorded the wrong fromPhase/iteration/session.
      const state = buildInitialState({
        phase: 'final_auditing',
        sessionId: 'audit-sess',
        iteration: 2,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            messages: async () => [
              {
                info: {
                  role: 'assistant',
                  finish: 'stop',
                  error: {
                    name: 'ProviderError',
                    data: { message: 'You have reached your usage limit', statusCode: 403 },
                  },
                },
                parts: [{ type: 'text', text: '' }],
              },
            ],
          },
        },
      })
      loopInstance.start({ state })

      await tickIdle(loopInstance, 'audit-sess')

      const afterState = loopInstance.service.getAnyState(loopName)!
      expect(afterState).not.toBeNull()
      expect(afterState.active).toBe(false)
      expect(afterState.status).toBe('errored')
      expect(afterState.terminationReason).toContain('provider_limit:')

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].transitionKind).toBe('terminate')
      expect(rows[0].eventType).toBe('provider_limit')
      // Authoritative phase at termination time — final_auditing, not a stale
      // caller-supplied phase.
      expect(rows[0].fromPhase).toBe('final_auditing')
      expect(rows[0].toPhase).toBeNull()
      expect(rows[0].status).toBe('errored')
      expect(rows[0].iteration).toBe(2)
    })
  })

  describe('Bug 9: cancel serialized with phase rotation', () => {
    test('cancel racing an audit-error rotation produces rotate row + terminal row whose fromPhase matches the persisted phase', async () => {
      // Pause the post-rotation prompt send inside the tick handler. The tick
      // acquires the state lock for the duration of the auditing phase runner,
      // records the audit-error → coding recovery row, then suspends awaiting
      // `promptAsync`. While the lock is still held, fire `loop.cancel` — it
      // queues behind `withStateLock` instead of running concurrently. On
      // release, the tick completes, the lock is released, and cancel then
      // reads the authoritative post-rotation phase (`coding`) before recording
      // the terminal row. Result: one rotate row + one terminal row, with the
      // terminal row's `fromPhase` matching the persisted phase exactly.
      let releasePrompt: () => void = () => {}
      const promptPaused = new Promise<void>((resolve) => {
        releasePrompt = resolve
      })

      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant message carries a non-provider error so the audit-error
            // branch fires `rotateAndSendContinuation` (auditing → coding).
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            // Hold the post-rotation prompt send so the tick's state lock is
            // retained while cancel queues behind it.
            promptAsync: async () => { await promptPaused },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({ state })

      // Kick off the auditing idle tick. It records the recovery row then
      // suspends at the paused prompt send while still holding the state lock.
      const tickPromise = tickIdle(loopInstance, 'audit-sess')

      // Yield through the microtask chain so the tick handler has acquired the
      // lock, runAudittingPhase has read the assistant message, rotated to
      // coding (recording the recovery row), and is now awaiting promptAsync.
      await new Promise((r) => setTimeout(r, 0))

      // Fire cancel while the tick is mid-flight. cancel queues behind the
      // tick's lock; it cannot read state until the tick releases the lock.
      const cancelPromise = loopInstance.cancel(state.loopName)

      // Release the prompt send → tick finishes, releases the lock → cancel
      // acquires the lock, observes the authoritative post-rotation phase
      // (`coding`), and records the terminal row with that fromPhase.
      releasePrompt()
      await tickPromise
      await cancelPromise

      const rows = getRows()
      expect(rows).toHaveLength(2)
      // Chronological order: rotate row first, terminal row second.
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      expect(rows[1].eventType).toBe('user_aborted')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].toPhase).toBeNull()
      // Terminal fromPhase matches the persisted post-rotation phase, not the
      // stale caller-supplied phase (`auditing`).
      expect(rows[1].fromPhase).toBe('coding')
      // The persisted loops row's phase is `coding` — terminal fromPhase
      // matches it exactly.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.phase).toBe('coding')
      expect(rows[1].fromPhase).toBe(persisted.phase)
      // Strict id ordering: rotate row precedes the terminal row chronologically.
      expect(rows[0].id).toBeLessThan(rows[1].id)
    })
  })

  describe('Bug 10: restart preserves transition history and appends one restart row', () => {
    test('restart into another phase preserves prior rows and records exactly one restart transition', () => {
      const loopInstance = buildLoop({})
      const initialState = buildInitialState({
        phase: 'auditing',
        iteration: 2,
        maxIterations: 10,
        totalSections: 0,
      })
      loopInstance.start({ state: initialState })

      // Seed transition history directly so we can assert preservation across
      // the restart call. These rows represent prior phase changes that would
      // be cascade-deleted by the old deleteState + setState restart path.
      loopTransitionsRepo.insert({
        projectId,
        loopName,
        eventType: 'section-clean',
        transitionKind: 'advance-section',
        fromPhase: 'auditing',
        toPhase: 'coding',
        status: null,
        reason: null,
        iteration: 1,
        sectionIndex: 0,
      })
      loopTransitionsRepo.insert({
        projectId,
        loopName,
        eventType: 'audit-clear',
        transitionKind: 'phase',
        fromPhase: 'coding',
        toPhase: 'auditing',
        status: null,
        reason: null,
        iteration: 2,
        sectionIndex: null,
      })

      const seededRows = loopTransitionsRepo.listForLoop(projectId, loopName)
      expect(seededRows).toHaveLength(2)

      // Restart into a fresh session in `coding` phase. The previous
      // destructive implementation would have cascade-deleted the seeded rows;
      // the in-place restore path preserves them.
      const restartedState = buildInitialState({
        sessionId: 'restarted-session',
        phase: 'coding',
        iteration: 3,
      })
      loopInstance.restart(loopName, {
        newState: restartedState,
        newSessionId: 'restarted-session',
      })

      const rows = loopTransitionsRepo.listForLoop(projectId, loopName)
      // Two seeded rows preserved + exactly one new restart row.
      expect(rows).toHaveLength(3)
      // The first two rows are the seeded ones, unchanged and in id order.
      expect(rows[0].id).toBe(seededRows[0].id)
      expect(rows[0].eventType).toBe('section-clean')
      expect(rows[1].id).toBe(seededRows[1].id)
      expect(rows[1].eventType).toBe('audit-clear')
      // The new restart row appends after the seeded rows in chronological id order.
      expect(rows[2].eventType).toBe('restart')
      expect(rows[2].transitionKind).toBe('rotate')
      expect(rows[2].fromPhase).toBe('auditing')
      expect(rows[2].toPhase).toBe('coding')
      expect(rows[2].iteration).toBe(3)
      expect(rows[0].id).toBeLessThan(rows[1].id)
      expect(rows[1].id).toBeLessThan(rows[2].id)

      // The parent loops row still exists and reflects the restarted session/phase.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted).not.toBeNull()
      expect(persisted.active).toBe(true)
      expect(persisted.phase).toBe('coding')
      expect(persisted.sessionId).toBe('restarted-session')
    })
  })

  describe('Bug 12: worktree.failed termination serialized with phase rotation', () => {
    test('worktree.failed racing an audit-error rotation produces rotate row + terminal row using the authoritative phase', async () => {
      // Pause the post-rotation prompt send inside the tick handler. The tick
      // acquires the state lock for the duration of the auditing phase runner,
      // records the audit-error → coding recovery row, then suspends awaiting
      // `promptAsync`. While the lock is still held, fire `worktree.failed` —
      // it queues behind `withStateLock` instead of running concurrently. On
      // release, the tick finishes, the lock is released, worktree.failed
      // acquires the lock, observes the authoritative post-rotation phase
      // (`coding`), and records the terminal row with that fromPhase. Result:
      // exactly one rotate row + one terminal row, with the terminal row's
      // fromPhase matching the persisted phase and the rotate row preceding the
      // terminal row chronologically (by id).
      let releasePrompt: () => void = () => {}
      const promptPaused = new Promise<void>((resolve) => {
        releasePrompt = resolve
      })

      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
        worktreeDir: '/tmp/wt-failed',
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant message carries a non-provider error so the audit-error
            // branch fires `rotateAndSendContinuation` (auditing → coding).
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            // Hold the post-rotation prompt send so the tick's state lock is
            // retained while worktree.failed queues behind it.
            promptAsync: async () => { await promptPaused },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({ state })

      // Kick off the auditing idle tick. It records the recovery row then
      // suspends at the paused prompt send while still holding the state lock.
      const tickPromise = tickIdle(loopInstance, 'audit-sess')

      // Yield through the microtask chain so the tick handler has acquired the
      // lock, runAuditingPhase has read the assistant message, rotated to
      // coding (recording the recovery row), and is now awaiting promptAsync.
      await new Promise((r) => setTimeout(r, 0))

      // Fire worktree.failed while the tick is mid-flight. It queues behind the
      // tick's lock; it cannot read state until the tick releases the lock.
      const worktreeFailedPromise = loopInstance.tick({
        type: 'worktree.failed',
        properties: { message: 'branch deleted', directory: '/tmp/wt-failed' },
      })

      // Release the prompt send → tick finishes, releases the lock →
      // worktree.failed acquires the lock, observes the authoritative
      // post-rotation phase (`coding`), and records the terminal row.
      releasePrompt()
      await tickPromise
      await worktreeFailedPromise

      const rows = getRows()
      expect(rows).toHaveLength(2)
      // Chronological order: rotate row first, terminal row second.
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      expect(rows[1].eventType).toBe('worktree_failed')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].toPhase).toBeNull()
      // Authoritative post-rotation phase — coding, not the stale caller-
      // supplied phase (`auditing`).
      expect(rows[1].fromPhase).toBe('coding')
      // The persisted loops row's phase is `coding` — terminal fromPhase
      // matches it exactly.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.active).toBe(false)
      expect(persisted.phase).toBe('coding')
      expect(rows[1].fromPhase).toBe(persisted.phase)
      // Strict id ordering: rotate row precedes the terminal row chronologically.
      expect(rows[0].id).toBeLessThan(rows[1].id)
    })
  })

  describe('Bug 11: Loop.setPhase records a transition row on change, none on no-op', () => {
    test('coding → auditing via Loop.setPhase records exactly one matching row', () => {
      const loopInstance = buildLoop({})
      loopInstance.start({
        state: buildInitialState({
          phase: 'coding',
          iteration: 4,
          currentSectionIndex: 2,
          totalSections: 5,
        }),
      })

      // Sanity: no rows before the call.
      expect(getRows()).toHaveLength(0)

      loopInstance.setPhase(loopName, 'auditing')

      const rows = getRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].eventType).toBe('set-phase')
      expect(rows[0].transitionKind).toBe('phase')
      expect(rows[0].fromPhase).toBe('coding')
      expect(rows[0].toPhase).toBe('auditing')
      // Iteration/section are sourced from the prior persisted state.
      expect(rows[0].iteration).toBe(4)
      expect(rows[0].sectionIndex).toBe(2)

      // The persisted phase matches the requested target.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.phase).toBe('auditing')
    })

    test('coding → coding via Loop.setPhase records no row', () => {
      const loopInstance = buildLoop({})
      loopInstance.start({
        state: buildInitialState({
          phase: 'coding',
          iteration: 4,
          totalSections: 0,
        }),
      })

      loopInstance.setPhase(loopName, 'coding')

      // No-op: phase unchanged, so no transition row is recorded.
      expect(getRows()).toHaveLength(0)
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.phase).toBe('coding')
    })

    test('Loop.setPhase on an unknown loop records no row and does not throw', () => {
      const loopInstance = buildLoop({})

      // No prior state exists for this name; setPhase persists the phase via the
      // service but, with no priorState, records no transition row.
      expect(() => loopInstance.setPhase('unknown-loop', 'auditing')).not.toThrow()
      expect(loopTransitionsRepo.listForLoop(projectId, 'unknown-loop')).toHaveLength(0)
    })
  })

  describe('Bug 13: terminateAll serialized with in-flight phase rotation', () => {
    test('terminateAll racing a paused audit-error rotation records phase row before shutdown row', async () => {
      // Pause the post-rotation prompt send inside the tick handler. The tick
      // acquires the state lock for the duration of the auditing phase runner,
      // records the audit-error → coding recovery row, then suspends awaiting
      // `promptAsync`. While the lock is still held, fire `loop.terminateAll`
      // — its contended-loop pass queues a `withStateLock` behind the tick.
      // On release the tick finishes (releases the lock), terminateAll's
      // queued body acquires the lock, re-reads the authoritative post-
      // rotation phase (`coding`), and records the shutdown row. Result:
      // rotate row precedes shutdown row chronologically (by id), and the
      // shutdown row's fromPhase matches the persisted `coding` phase exactly.
      let releasePrompt: () => void = () => {}
      const promptPaused = new Promise<void>((resolve) => {
        releasePrompt = resolve
      })

      const state = buildInitialState({
        phase: 'auditing',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant message carries a non-provider error so the audit-error
            // branch fires `rotateAndSendContinuation` (auditing → coding).
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            // Hold the post-rotation prompt send so the tick's state lock is
            // retained while terminateAll queues behind it.
            promptAsync: async () => { await promptPaused },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({ state })

      // Kick off the auditing idle tick. It records the recovery row then
      // suspends at the paused prompt send while still holding the state lock.
      const tickPromise = tickIdle(loopInstance, 'audit-sess')

      // Yield through the microtask chain so the tick handler has acquired the
      // lock, runAuditingPhase has read the assistant message, rotated to
      // coding (recording the recovery row), and is now awaiting promptAsync.
      await new Promise((r) => setTimeout(r, 0))

      // Fire terminateAll while the tick is mid-flight. terminateAll's
      // contended-loop pass queues a withStateLock behind the tick's lock —
      // it cannot read state until the tick releases the lock.
      const terminateAllPromise = loopInstance.terminateAll()

      // Release the prompt send → tick finishes (rotate row already recorded
      // while holding the lock), releases the lock → terminateAll's queued
      // body acquires the lock, observes the authoritative post-rotation
      // phase (`coding`), records the shutdown row, and persists the
      // cancellation.
      releasePrompt()
      await tickPromise
      await terminateAllPromise

      const rows = getRows()
      expect(rows).toHaveLength(2)
      // Chronological order: rotate row first, shutdown row second.
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      expect(rows[1].eventType).toBe('shutdown')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].toPhase).toBeNull()
      expect(rows[1].status).toBe('cancelled')
      expect(rows[1].reason).toBe('shutdown')
      // The shutdown row's fromPhase matches the authoritative post-rotation
      // phase (coding), proving terminateAll re-read state under the lock
      // rather than using the pre-rotation snapshot phase (`auditing`).
      expect(rows[1].fromPhase).toBe('coding')
      // Strict id ordering: rotate row precedes shutdown row chronologically.
      expect(rows[0].id).toBeLessThan(rows[1].id)

      // The persisted loops row's phase is `coding` (cancelled). The shutdown
      // row's fromPhase matches it exactly.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.active).toBe(false)
      expect(persisted.phase).toBe('coding')
      expect(rows[1].fromPhase).toBe(persisted.phase)
    })
  })

  describe('Bug 14: exhausted retry termination serialized with phase rotation', () => {
    test('retry body exhausting mid-flight holds the state lock so an in-flight terminateAll cannot race the terminal row', async () => {
      // Start a plan-kind loop in the auditing phase with a persisted
      // errorCount=1 (one shy of MAX_RETRIES-1=2 so the retry's recursive
      // handlePromptError exhausts after the tick's first failure). The audit
      // assistant message carries a non-provider error so the audit-error
      // branch rotates auditing → coding AND skips resetErrorCountIfNeeded
      // (assistantErrorDetected=true), preserving the seeded errorCount.
      //
      // Tick flow:
      //   - audit-error branch fires rotateAndSendContinuation (records the
      //     audit-error/error-recovery row auditing → coding)
      //   - the continuation prompt's single sendPromptWithFallback
      //     attempt (no model configured → callWithoutModel only) throws →
      //     handlePromptError increments errorCount (1 → 2 in DB) and
      //     schedules the 2-second retry timer
      //
      // 2 seconds later the retry timer fires, its body wraps in withStateLock
      // and retryFn's defaultSend makes one more promptAsync call. We pause
      // that call so the retry body holds the per-loop state lock. Then fire
      // `loop.terminateAll`: terminateAll's contended-loop pass detects
      // stateLocks.has(loopName) === true and queues a withStateLock behind
      // the retry body instead of racing it. Release the pause → defaultSend
      // throws → its catch invokes handlePromptError recursively → errorCount
      // 2 → 3 exhausts → terminateLoop records the error_max_retries row
      // with fromPhase=`coding` (the authoritative persisted phase). Lock
      // releases → terminateAll's queued lock body observes inactive state
      // and skips. Result: exactly one recovery row (audit-error → coding) + one
      // terminal row (error_max_retries, coding → null), strict id ordering,
      // terminal fromPhase matches the persisted phase. No duplicate shutdown
      // row fires from terminateAll.
      let codePromptAttempts = 0
      let releaseRetry: () => void = () => {}
      const retryPaused = new Promise<void>((resolve) => {
        releaseRetry = resolve
      })

      const state = buildInitialState({
        phase: 'auditing',
        sessionId: 'audit-sess',
        iteration: 1,
        maxIterations: 10,
        totalSections: 0,
        errorCount: 1,
        auditCount: 1,
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Assistant audit message carries a non-provider error so the
            // audit-error branch fires `rotateAndSendContinuation`
            // (auditing → coding) and `resetErrorCountIfNeeded` skips
            // (assistantErrorDetected=true preserves the persisted errorCount).
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            promptAsync: async (params: any) => {
              if (params?.agent === 'code') {
                codePromptAttempts++
                // getConfig returns {} (no loop model configured), so
                // retryWithModelFallback takes the `!model` fast-path and
                // calls callWithoutModel exactly once per attempt.
                //
                // attempt 1 (tick's sendPromptWithFallback): throw →
                //   handlePromptError (errorCount 1 → 2 in DB) schedules
                //   the 2-second retry timer.
                // attempt 2 (retry's defaultSend): pause on `retryPaused`,
                //   then on release throw `transient transport error 2`.
                //   defaultSend catches and calls handlePromptError
                //   recursively → errorCount 2 → 3 exhausts →
                //   terminateLoop records the error_max_retries row.
                if (codePromptAttempts === 1) throw new Error('transient transport error')
                if (codePromptAttempts === 2) {
                  await retryPaused
                  throw new Error('transient transport error 2')
                }
                throw new Error('unexpected code prompt')
              }
            },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({ state })

      // Tick fires runAuditingPhase → audit-error branch → rotate to coding
      // (records the audit-error/error-recovery row) → continuation prompt
      // fails → handlePromptError schedules the 2-second retry timer
      // (errorCount 1 → 2 in DB).
      await tickIdle(loopInstance, 'audit-sess')

      // Wait for the retry timer to fire (~2s). Its body wraps in
      // withStateLock and pauses on `retryPaused`, holding the lock.
      await new Promise((r) => setTimeout(r, 2200))
      // Yield through microtasks so the retry body has acquired the lock,
      // read fresh state, called retryFn → defaultSend → and is now
      // suspended on `retryPaused`.
      await new Promise((r) => setTimeout(r, 0))

      // Fire terminateAll while the retry body holds the lock. terminateAll's
      // contended-loop pass detects stateLocks.has(loopName) === true (set by
      // the retry body's withStateLock) and queues a withStateLock behind it.
      const terminateAllPromise = loopInstance.terminateAll()

      // Release the retry pause → defaultSend catches the throw → recursive
      // handlePromptError exhausts (errorCount 2 → 3) → terminateLoop
      // records the terminal row with fromPhase=coding (authoritative) →
      // lock releases → terminateAll's queued lock body observes inactive
      // state and skips.
      releaseRetry()
      await terminateAllPromise

      const rows = getRows()
      // Exactly two rows: the audit-error → coding recovery row (recorded
      // during the tick under the tick's lock), plus the terminal
      // error_max_retries row (recorded by the retry body's exhausted
      // termination, serialized under the retry's lock). No duplicate
      // shutdown row from terminateAll (it observed inactive state under its
      // queued lock body).
      expect(rows).toHaveLength(2)
      expect(rows[0].eventType).toBe('audit-error')
      expect(rows[0].transitionKind).toBe('error-recovery')
      expect(rows[0].fromPhase).toBe('auditing')
      expect(rows[0].toPhase).toBe('coding')
      expect(rows[1].eventType).toBe('error_max_retries')
      expect(rows[1].transitionKind).toBe('terminate')
      expect(rows[1].fromPhase).toBe('coding')
      expect(rows[1].toPhase).toBeNull()
      expect(rows[1].status).toBe('errored')
      // Strict id ordering: recovery row precedes the terminal row chronologically.
      expect(rows[0].id).toBeLessThan(rows[1].id)

      // Persisted loops row reflects the retry's termination (coding phase,
      // errored). The terminal row's fromPhase matches it exactly.
      const persisted = loopInstance.service.getAnyState(loopName)!
      expect(persisted.active).toBe(false)
      expect(persisted.phase).toBe('coding')
      expect(persisted.status).toBe('errored')
      expect(rows[1].fromPhase).toBe(persisted.phase)
    })
  })

  describe('Bug 15: terminateAll snapshot-gap loops receive exactly one ordered shutdown row', () => {
    test('loop activated while shutdown awaits a contended lock receives exactly one shutdown row', async () => {
      // Scenario: terminateAll snapshots [loop-A] (contended — its audit-error
      // rotation tick holds the per-loop lock paused on promptAsync). While
      // terminateAll awaits that lock, loop-B becomes active (simulating a
      // concurrent restart completing). The old implementation only recorded
      // rows for loops in the initial snapshot and fell back to a raw
      // loopService.terminateAll() for snapshot-gap loops — that wrote
      // cancelled rows without recording any transition row. The fix replaces
      // the raw fallback with a guarded re-sweep that admits/records/
      // terminates gap loops through the same shared path. Result: exactly one
      // shutdown row per loop, in chronological id order (A's row before B's).
      let releasePrompt: () => void = () => {}
      const promptPaused = new Promise<void>((resolve) => {
        releasePrompt = resolve
      })

      const loopInstance = buildLoop({
        clientTweaks: {
          session: {
            // Audit-error message → rotate auditing → coding (records the
            // recovery row under the tick's lock), then hold the
            // continuation prompt so the tick stays mid-flight while we
            // drive the snapshot-gap scenario.
            messages: async () => [
              {
                info: { role: 'assistant', finish: 'stop', error: { name: 'RuntimeError', data: { message: 'boom while auditing' } } },
                parts: [{ type: 'text', text: 'partial audit' }],
              },
            ],
            promptAsync: async () => { await promptPaused },
            abort: async () => {},
          },
        },
      })
      loopInstance.start({
        state: buildInitialState({
          loopName: 'gap-loop-A',
          sessionId: 'sess-a',
          phase: 'auditing',
          iteration: 1,
          maxIterations: 10,
          totalSections: 0,
        }),
      })

      // Kick off the auditing idle tick. It records the audit-error → coding
      // recovery row, then suspends at the paused continuation prompt while
      // still holding the per-loop state lock.
      const tickPromise = tickIdle(loopInstance, 'sess-a')
      // Yield through microtasks so the tick has acquired the lock and is now
      // suspended on promptAsync.
      await new Promise((r) => setTimeout(r, 0))

      // Fire terminateAll. Its snapshot is [gap-loop-A]; A is contended
      // (stateLocks has it) so the deferred locked pass queues behind the
      // tick's lock. While we wait, start gap-loop-B (simulating a concurrent
      // restart completing — B was not in the initial snapshot).
      const terminateAllPromise = loopInstance.terminateAll()

      // Yield once so the contended-pass withStateLock for A is queued.
      await new Promise((r) => setTimeout(r, 0))

      // Snapshot-gap: loop-B activates after terminateAll's snapshot was taken
      // and while A's contended-pass is still awaiting the lock.
      loopInstance.start({
        state: buildInitialState({
          loopName: 'gap-loop-B',
          sessionId: 'sess-b',
          phase: 'coding',
          iteration: 3,
          maxIterations: 10,
          totalSections: 0,
        }),
      })

      // Release A's prompt send → tick finishes, releases the lock →
      // terminateAll's queued body for A acquires the lock, records A's
      // shutdown row, and terminates A. The deferred pass completes; the
      // sweep loop then re-snapshots and finds gap-loop-B active,
      // uncontended, not admitted — admits/records/terminates B through the
      // same shared path.
      releasePrompt()
      await tickPromise
      await terminateAllPromise

      const rowsA = loopTransitionsRepo.listForLoop(projectId, 'gap-loop-A')
      const rowsB = loopTransitionsRepo.listForLoop(projectId, 'gap-loop-B')

      // A: rotate row + exactly one shutdown terminate row.
      expect(rowsA).toHaveLength(2)
      expect(rowsA[0].eventType).toBe('audit-error')
      expect(rowsA[0].transitionKind).toBe('error-recovery')
      expect(rowsA[0].fromPhase).toBe('auditing')
      expect(rowsA[0].toPhase).toBe('coding')
      expect(rowsA[1].eventType).toBe('shutdown')
      expect(rowsA[1].transitionKind).toBe('terminate')
      expect(rowsA[1].toPhase).toBeNull()
      expect(rowsA[1].status).toBe('cancelled')
      expect(rowsA[1].reason).toBe('shutdown')
      // Shutdown row's fromPhase matches the authoritative post-rotation
      // phase (coding), proving terminateAll re-read state under the lock.
      expect(rowsA[1].fromPhase).toBe('coding')

      // B (the snapshot-gap loop): exactly one shutdown terminate row.
      expect(rowsB).toHaveLength(1)
      expect(rowsB[0].eventType).toBe('shutdown')
      expect(rowsB[0].transitionKind).toBe('terminate')
      expect(rowsB[0].fromPhase).toBe('coding')
      expect(rowsB[0].toPhase).toBeNull()
      expect(rowsB[0].status).toBe('cancelled')
      expect(rowsB[0].reason).toBe('shutdown')
      expect(rowsB[0].iteration).toBe(3)

      // Strict id ordering across loops: A's shutdown row precedes B's
      // shutdown row chronologically (A was recorded first under its lock,
      // B was recorded in the following sweep).
      expect(rowsA[1].id).toBeLessThan(rowsB[0].id)

      // Both loops are now inactive in the persisted state.
      const persistedA = loopInstance.service.getAnyState('gap-loop-A')!
      const persistedB = loopInstance.service.getAnyState('gap-loop-B')!
      expect(persistedA.active).toBe(false)
      expect(persistedA.status).toBe('cancelled')
      expect(persistedB.active).toBe(false)
      expect(persistedB.status).toBe('cancelled')
    })
  })
})