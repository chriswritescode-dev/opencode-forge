import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopEventsRepo } from '../../src/storage/repos/loop-events-repo'
import { createLoopRunsRepo } from '../../src/storage/repos/loop-runs-repo'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createLoopMetricsRecorder } from '../../src/loop/metrics'
import { createFakeForgeClient } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { loopStateToRow } from '../../src/loop/state'
import type { LoopState } from '../../src/loop/state'
import type { Logger } from '../../src/types'

const PROJECT_ID = 'metrics-project'

function makeLogger(): { logger: Logger; debugs: string[]; errors: string[] } {
  const debugs: string[] = []
  const errors: string[] = []
  const logger: Logger = {
    log: () => {},
    error: (msg: string) => errors.push(msg),
    debug: (msg: string) => debugs.push(msg),
  }
  return { logger, debugs, errors }
}

function mockAssistantMessage(cost: number, tokens: { input: number; output: number; reasoning: number }, model?: string) {
  return {
    info: {
      role: 'assistant' as const,
      finish: 'stop',
      cost,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: 0, write: 0 },
      },
      ...(model ? { model } : {}),
    },
    parts: [{ type: 'text' as const, text: 'message body' }],
  }
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    active: true,
    sessionId: 'loop-session-1',
    loopName: 'metrics-loop',
    worktreeDir: '/tmp/worktree',
    projectDir: '/tmp/project',
    worktreeBranch: 'test/branch',
    iteration: 2,
    maxIterations: 5,
    startedAt: new Date(1_700_000_000_000).toISOString(),
    phase: 'coding',
    errorCount: 0,
    auditCount: 0,
    status: 'running',
    worktree: true,
    modelFailed: false,
    sandbox: false,
    executionModel: 'exec/model',
    auditorModel: 'audit/model',
    currentSectionIndex: 1,
    totalSections: 3,
    finalAuditDone: false,
    kind: 'plan',
    ...overrides,
  }
}

describe('LoopMetricsRecorder', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let loopEventsRepo: ReturnType<typeof createLoopEventsRepo>
  let loopRunsRepo: ReturnType<typeof createLoopRunsRepo>
  let loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-metrics-test-'))
    db = new Database(join(tempDir, 'metrics.db'))
    db.run('PRAGMA foreign_keys = ON')
    setupLoopsTestDb(db)
    loopsRepo = createLoopsRepo(db)
    loopEventsRepo = createLoopEventsRepo(db)
    loopRunsRepo = createLoopRunsRepo(db)
    loopSessionUsageRepo = createLoopSessionUsageRepo(db)

    // loop_session_usage has a FK to loops(project_id, loop_name); insert the
    // parent loop row once so usage/event seeding in tests can reference it.
    const seedState = makeState()
    loopsRepo.insert(loopStateToRow(seedState, PROJECT_ID), {
      lastAuditResult: null,
      postActionReport: null,
      goal: null,
    })
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('recordPhaseEvent', () => {
    test('inserts one loop_events row with summed token totals, model, and event metadata', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            mockAssistantMessage(0.01, { input: 100, output: 50, reasoning: 10 }, 'model-a'),
            mockAssistantMessage(0.05, { input: 200, output: 100, reasoning: 20 }, 'model-b'),
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
          ],
        },
      })
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const state = makeState({ phase: 'auditing', auditCount: 1, iteration: 3, currentSectionIndex: 2 })
      await recorder.recordPhaseEvent({
        state,
        eventType: 'audit_done',
        outcome: 'section_retry',
        verdict: 'dirty',
        sessionId: 'audit-session-9',
        directory: '/tmp/worktree',
        role: 'auditor',
        findingsTotal: 4,
        findingsBugs: 2,
        fallbackModel: 'fallback/model',
      })

      const rows = loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)
      expect(rows).toHaveLength(1)
      const got = rows[0]
      expect(got.eventType).toBe('audit_done')
      expect(got.outcome).toBe('section_retry')
      expect(got.verdict).toBe('dirty')
      expect(got.iteration).toBe(3)
      expect(got.sectionIndex).toBe(2)
      expect(got.role).toBe('auditor')
      expect(got.sessionId).toBe('audit-session-9')
      expect(got.runStartedAt).toBe(new Date(state.startedAt).getTime())
      expect(got.findingsTotal).toBe(4)
      expect(got.findingsBugs).toBe(2)
      // highest-cost model wins (model-b cost 0.05 > model-a cost 0.01)
      expect(got.model).toBe('model-b')
      // summed token totals across both assistant messages
      expect(got.cost).toBeCloseTo(0.06, 6)
      expect(got.inputTokens).toBe(300)
      expect(got.outputTokens).toBe(150)
      expect(got.reasoningTokens).toBe(30)
      expect(got.cacheReadTokens).toBe(0)
      expect(got.cacheWriteTokens).toBe(0)
      expect(got.messageCount).toBe(2)
    })

    test('handles tie in cost by keeping the first-seen model', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            mockAssistantMessage(0.02, { input: 10, output: 5, reasoning: 1 }, 'alpha-model'),
            mockAssistantMessage(0.02, { input: 20, output: 10, reasoning: 2 }, 'beta-model'),
          ],
        },
      })
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
      })

      const state = makeState({ phase: 'coding', totalSections: 0 })
      await recorder.recordPhaseEvent({
        state,
        eventType: 'coding_done',
        outcome: 'section_complete',
        sessionId: 'code-session-1',
        directory: '/tmp/worktree',
        role: 'code',
      })

      const got = loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)[0]
      // summarizeAssistantUsage sorts perModel alphabetically; alpha-model comes
      // first and ties win stays-with-first, so alpha-model wins.
      expect(got.model).toBe('alpha-model')
      expect(got.messageCount).toBe(2)
      expect(got.inputTokens).toBe(30)
    })

    test('nulls sectionIndex when totalSections is 0', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => [mockAssistantMessage(0.01, { input: 1, output: 1, reasoning: 0 })] },
      })
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
      })

      const state = makeState({ phase: 'coding', totalSections: 0, currentSectionIndex: 0 })
      await recorder.recordPhaseEvent({
        state,
        eventType: 'coding_done',
        outcome: 'section_complete',
        sessionId: 'code-session-1',
        directory: '/tmp/worktree',
        role: 'code',
      })

      const got = loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)[0]
      expect(got.sectionIndex).toBeNull()
    })

    test('fetch failure still inserts a zero-usage event row and logs debug', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => {
            throw new Error('session fetch exploded')
          },
        },
      })
      const { logger, debugs } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
      })

      const state = makeState({ phase: 'auditing' })
      await recorder.recordPhaseEvent({
        state,
        eventType: 'audit_done',
        outcome: 'section_retry',
        verdict: 'clean',
        sessionId: 'audit-session-1',
        directory: '/tmp/worktree',
        role: 'auditor',
      })

      const rows = loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)
      expect(rows).toHaveLength(1)
      const got = rows[0]
      expect(got.eventType).toBe('audit_done')
      expect(got.verdict).toBe('clean')
      expect(got.model).toBeNull()
      expect(got.cost).toBe(0)
      expect(got.inputTokens).toBe(0)
      expect(got.outputTokens).toBe(0)
      expect(got.reasoningTokens).toBe(0)
      expect(got.cacheReadTokens).toBe(0)
      expect(got.cacheWriteTokens).toBe(0)
      expect(got.messageCount).toBe(0)
      expect(debugs.length).toBeGreaterThan(0)
    })

    test('missing loopEventsRepo is a no-op that never touches the client', async () => {
      const calls: string[] = []
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => {
            calls.push('session.messages')
            return []
          },
        },
      })
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        // loopEventsRepo intentionally omitted
      })

      const state = makeState()
      await recorder.recordPhaseEvent({
        state,
        eventType: 'coding_done',
        outcome: 'section_complete',
        sessionId: 'code-session-1',
        directory: '/tmp/worktree',
        role: 'code',
      })

      expect(calls).toHaveLength(0)
      expect(loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)).toHaveLength(0)
    })
  })

  describe('recordTermination', () => {
    const seededRunStartedAt = 1_700_000_000_000

    function seedUsageAndEvents() {
      // Seed loop_session_usage with two models for this run, so the aggregate
      // totals can drive the loop_runs row. Each row stamps the run's
      // started_at so run-scoped aggregation matches the seeded run.
      loopSessionUsageRepo.upsertSessionUsage([
        {
          projectId: PROJECT_ID,
          loopName: 'metrics-loop',
          sessionId: 'code-session-1',
          role: 'code',
          model: 'exec/model',
          cost: 0.1,
          inputTokens: 1000,
          outputTokens: 500,
          reasoningTokens: 100,
          cacheReadTokens: 200,
          cacheWriteTokens: 300,
          messageCount: 4,
          capturedAt: Date.now(),
          runStartedAt: seededRunStartedAt,
        },
        {
          projectId: PROJECT_ID,
          loopName: 'metrics-loop',
          sessionId: 'audit-session-1',
          role: 'auditor',
          model: 'audit/model',
          cost: 0.2,
          inputTokens: 2000,
          outputTokens: 1000,
          reasoningTokens: 200,
          cacheReadTokens: 400,
          cacheWriteTokens: 600,
          messageCount: 6,
          capturedAt: Date.now(),
          runStartedAt: seededRunStartedAt,
        },
      ])

      // Seed phase events so auditCountsForRun drives clean/dirty/retry counts.
      loopEventsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        runStartedAt: seededRunStartedAt,
        eventType: 'audit_done',
        outcome: 'section_retry',
        verdict: 'clean',
        iteration: 1,
        sectionIndex: 0,
        sessionId: 'audit-session-0',
        role: 'auditor',
        model: 'audit/model',
        cost: 0.05,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messageCount: 1,
        findingsTotal: 2,
        findingsBugs: 1,
        detail: null,
        createdAt: Date.now(),
      })
      loopEventsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        runStartedAt: seededRunStartedAt,
        eventType: 'audit_done',
        outcome: 'section_complete',
        verdict: 'dirty',
        iteration: 1,
        sectionIndex: 0,
        sessionId: 'audit-session-1',
        role: 'auditor',
        model: 'audit/model',
        cost: 0.05,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messageCount: 1,
        findingsTotal: 3,
        findingsBugs: 2,
        detail: null,
        createdAt: Date.now(),
      })
      loopEventsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        runStartedAt: seededRunStartedAt,
        eventType: 'final_audit_done',
        outcome: 'loop_complete',
        verdict: 'clean',
        iteration: 5,
        sectionIndex: null,
        sessionId: 'audit-final',
        role: 'auditor',
        model: 'audit/model',
        cost: 0.05,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messageCount: 1,
        findingsTotal: 0,
        findingsBugs: 0,
        detail: null,
        createdAt: Date.now(),
      })
    }

    test('writes a loop_terminated event row and a loop_runs row whose totals and audit counts match seeded data', () => {
      seedUsageAndEvents()
      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const state = makeState({
        iteration: 5,
        auditCount: 3,
        errorCount: 1,
        totalSections: 4,
        currentSectionIndex: 3,
        executionModel: 'exec/model',
        auditorModel: 'audit/model',
        executionVariant: 'standard',
        auditorVariant: 'reasoning',
        kind: 'goal',
        status: 'running',
      })
      const completedAt = seededRunStartedAt + 60_000

      recorder.recordTermination(state, { status: 'completed', reason: 'all_sections_done', completedAt })

      // loop_terminated event row
      const events = loopEventsRepo.listByLoop(PROJECT_ID, state.loopName, seededRunStartedAt)
      const terminated = events.find((e) => e.eventType === 'loop_terminated')
      expect(terminated).toBeDefined()
      expect(terminated!.outcome).toBe('all_sections_done')
      expect(JSON.parse(terminated!.detail!)).toEqual({ status: 'completed' })
      expect(terminated!.iteration).toBe(5)
      expect(terminated!.runStartedAt).toBe(seededRunStartedAt)
      expect(terminated!.model).toBeNull()
      expect(terminated!.cost).toBe(0)
      expect(terminated!.inputTokens).toBe(0)
      expect(terminated!.messageCount).toBe(0)

      // loop_runs row
      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs.length).toBe(1)
      const run = runs[0]
      expect(run.projectId).toBe(PROJECT_ID)
      expect(run.loopName).toBe('metrics-loop')
      expect(run.startedAt).toBe(seededRunStartedAt)
      expect(run.completedAt).toBe(completedAt)
      expect(run.status).toBe('completed')
      expect(run.terminationReason).toBe('all_sections_done')
      expect(run.loopKind).toBe('goal')
      expect(run.executionModel).toBe('exec/model')
      expect(run.auditorModel).toBe('audit/model')
      expect(run.executionVariant).toBe('standard')
      expect(run.auditorVariant).toBe('reasoning')
      expect(run.iterations).toBe(5)
      expect(run.auditCount).toBe(3)
      expect(run.errorCount).toBe(1)
      expect(run.totalSections).toBe(4)
      // From seeded events: clean audits = 1 audit_done(clean) + 1 final_audit_done(clean) = 2
      expect(run.cleanAudits).toBe(2)
      // dirty audits = 1 audit_done(dirty)
      expect(run.dirtyAudits).toBe(1)
      // section_retry outcomes = first audit_done row only (section_complete and loop_complete don't count)
      expect(run.sectionRetries).toBe(1)
      expect(run.durationMs).toBe(60_000)
      // From seeded usage aggregate: summed across both models
      expect(run.cost).toBeCloseTo(0.3, 6)
      expect(run.inputTokens).toBe(3000)
      expect(run.outputTokens).toBe(1500)
      expect(run.reasoningTokens).toBe(300)
      expect(run.cacheReadTokens).toBe(600)
      expect(run.cacheWriteTokens).toBe(900)
      expect(run.messageCount).toBe(10)
    })

    test('second recordTermination for the same run replaces (not duplicates) the run row', () => {
      seedUsageAndEvents()
      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const state = makeState({ iteration: 5 })
      const completedAt = seededRunStartedAt + 60_000

      recorder.recordTermination(state, { status: 'running', reason: 'in_progress', completedAt: null })
      recorder.recordTermination(state, { status: 'completed', reason: 'all_sections_done', completedAt })

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs.length).toBe(1)
      expect(runs[0].status).toBe('completed')
      expect(runs[0].terminationReason).toBe('all_sections_done')
      expect(runs[0].completedAt).toBe(completedAt)

      // loop_terminated event is appended each call (audit-style event log),
      // but the run row is deduplicated by PK upsert.
      const terminatedCount = loopEventsRepo
        .listByLoop(PROJECT_ID, state.loopName, seededRunStartedAt)
        .filter((e) => e.eventType === 'loop_terminated').length
      expect(terminatedCount).toBe(2)
    })

    test('missing both repos is a no-op that throws nothing', () => {
      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        // both repos omitted
      })

      const state = makeState()
      expect(() =>
        recorder.recordTermination(state, { status: 'completed', reason: 'done', completedAt: Date.now() }),
      ).not.toThrow()
      expect(loopRunsRepo.listByProject(PROJECT_ID)).toHaveLength(0)
      expect(loopEventsRepo.listByLoop(PROJECT_ID, state.loopName)).toHaveLength(0)
    })

    test('absent loop_session_usage aggregate yields zeroed run totals', () => {
      // Seed only events (no usage rows) so getAggregate returns null.
      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const state = makeState({ iteration: 1 })
      recorder.recordTermination(state, { status: 'completed', reason: 'done', completedAt: seededRunStartedAt + 1000 })

      const run = loopRunsRepo.listByProject(PROJECT_ID)[0]
      expect(run.cost).toBe(0)
      expect(run.inputTokens).toBe(0)
      expect(run.messageCount).toBe(0)
      expect(run.cleanAudits).toBe(0)
      expect(run.dirtyAudits).toBe(0)
      expect(run.sectionRetries).toBe(0)
    })

    test('restart with new startedAt records only the new run\'s usage totals (run isolation)', () => {
      // Two runs of the same loop name. Run 1 terminates; loop is restarted
      // with a new startedAt; run 2 captures fresh usage and terminates. The
      // run 2 loop_runs row must NOT include run 1's usage, even though the
      // prior loop_session_usage rows remain in the table.
      const run1StartedAt = 1_700_000_000_000
      const run1Captured = run1StartedAt + 60_000
      const run2StartedAt = run1StartedAt + 3_600_000
      const run2Captured = run2StartedAt + 60_000

      // Run 1 usage: one code session worth of tokens.
      loopSessionUsageRepo.upsertSessionUsage({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        sessionId: 'run1-code-session',
        role: 'code',
        model: 'exec/model',
        cost: 0.1,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
        messageCount: 4,
        capturedAt: run1Captured,
        runStartedAt: run1StartedAt,
      })

      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const run1State = makeState({ iteration: 2, startedAt: new Date(run1StartedAt).toISOString() })
      recorder.recordTermination(run1State, {
        status: 'cancelled',
        reason: 'user_cancelled',
        completedAt: run1StartedAt + 120_000,
      })

      // Run 1 row records its own totals.
      const afterRun1 = loopRunsRepo.listByProject(PROJECT_ID)
      expect(afterRun1).toHaveLength(1)
      expect(afterRun1[0].startedAt).toBe(run1StartedAt)
      expect(afterRun1[0].cost).toBeCloseTo(0.1, 6)
      expect(afterRun1[0].inputTokens).toBe(1000)
      expect(afterRun1[0].outputTokens).toBe(500)
      expect(afterRun1[0].messageCount).toBe(4)

      // Restart: loop_sessions_usage keeps run 1's row (session-scoped PK), and
      // run 2 captures a fresh, smaller usage row under a new session id.
      loopSessionUsageRepo.upsertSessionUsage({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        sessionId: 'run2-code-session',
        role: 'code',
        model: 'exec/model',
        cost: 0.02,
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 60,
        messageCount: 2,
        capturedAt: run2Captured,
        runStartedAt: run2StartedAt,
      })

      const run2State = makeState({ iteration: 1, startedAt: new Date(run2StartedAt).toISOString() })
      recorder.recordTermination(run2State, {
        status: 'completed',
        reason: 'all_sections_done',
        completedAt: run2StartedAt + 120_000,
      })

      // Run 2 must be a separate row keyed by its own startedAt, and its totals
      // must reflect only run 2's captured usage — not the cumulative total
      // across both runs (which would be cost 0.12, input 1200, etc.).
      const afterRun2 = loopRunsRepo.listByProject(PROJECT_ID)
      expect(afterRun2).toHaveLength(2)
      const run2 = afterRun2.find((r) => r.startedAt === run2StartedAt)
      expect(run2).toBeDefined()
      expect(run2!.status).toBe('completed')
      expect(run2!.terminationReason).toBe('all_sections_done')
      expect(run2!.cost).toBeCloseTo(0.02, 6)
      expect(run2!.inputTokens).toBe(200)
      expect(run2!.outputTokens).toBe(100)
      expect(run2!.reasoningTokens).toBe(20)
      expect(run2!.cacheReadTokens).toBe(40)
      expect(run2!.cacheWriteTokens).toBe(60)
      expect(run2!.messageCount).toBe(2)
    })

    test('restart with equal-millisecond capturedAt excludes prior run (run identity isolation)', () => {
      // Recorder-level regression for the auditor's timestamp-collision
      // finding. The original run-aggregate filter (`captured_at >=
      // runStartedAt`) folded a prior run's row into a restarted run's
      // totals whenever the prior run captured usage in the same Date.now()
      // millisecond as the new run's startedAt. The fix stamps run_started_at
      // on every usage row and aggregates by equality on that column, so
      // captured_at collisions no longer leak across runs.
      const run1StartedAt = 1_700_000_000_000
      const run2StartedAt = run1StartedAt + 1 // +1 ms: a new run identity
      const collisionMs = run2StartedAt

      // Prior run captures usage and stamps run1's started_at. Its captured_at
      // is set to the SAME millisecond as run2's startedAt — the bug trigger.
      loopSessionUsageRepo.upsertSessionUsage({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        sessionId: 'run1-code-session',
        role: 'code',
        model: 'exec/model',
        cost: 0.5,
        inputTokens: 9999,
        outputTokens: 9999,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messageCount: 9,
        capturedAt: collisionMs,
        runStartedAt: run1StartedAt,
      })

      // Restarted run captures its own usage, stamping run2's started_at.
      loopSessionUsageRepo.upsertSessionUsage({
        projectId: PROJECT_ID,
        loopName: 'metrics-loop',
        sessionId: 'run2-code-session',
        role: 'code',
        model: 'exec/model',
        cost: 0.02,
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 60,
        messageCount: 2,
        capturedAt: collisionMs,
        runStartedAt: run2StartedAt,
      })

      const { client } = createFakeForgeClient()
      const { logger } = makeLogger()
      const recorder = createLoopMetricsRecorder({
        client,
        logger,
        projectId: PROJECT_ID,
        loopEventsRepo,
        loopRunsRepo,
        loopSessionUsageRepo,
      })

      const run2State = makeState({ iteration: 1, startedAt: new Date(run2StartedAt).toISOString() })
      recorder.recordTermination(run2State, {
        status: 'completed',
        reason: 'all_sections_done',
        completedAt: run2StartedAt + 120_000,
      })

      const run2 = loopRunsRepo.listByProject(PROJECT_ID).find((r) => r.startedAt === run2StartedAt)
      expect(run2).toBeDefined()
      // Run 2 totals must reflect ONLY run 2's row — the prior-run row's
      // captured_at collision must NOT inflate these totals.
      expect(run2!.cost).toBeCloseTo(0.02, 6)
      expect(run2!.inputTokens).toBe(200)
      expect(run2!.outputTokens).toBe(100)
      expect(run2!.messageCount).toBe(2)
    })
  })
})
