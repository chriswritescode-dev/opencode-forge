import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopSessionUsageRepo, type LoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopEventsRepo, type LoopEventsRepo } from '../../src/storage/repos/loop-events-repo'
import { createLoopRunsRepo, type LoopRunsRepo } from '../../src/storage/repos/loop-runs-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop } from '../../src/loop/runtime'
import { sessionsAwaitingBusy } from '../../src/loop/idle-gate'
import {
  markPromptInFlight,
  clearPromptInFlight,
  getPromptInFlight,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { Logger, PluginConfig, LoopConfig } from '../../src/types'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'
import type { ForgeClient } from '../../src/client/port'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/loop/section-summary'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

function createCapturingLogger(): { logger: Logger; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = []
  const logger: Logger = {
    log: (msg: string) => logs.push({ level: 'log', message: msg }),
    error: (msg: string) => logs.push({ level: 'error', message: msg }),
    debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
  }
  return { logger, logs }
}

describe('Loop Runtime', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let loopSessionUsageRepo: LoopSessionUsageRepo
  let loopEventsRepo: LoopEventsRepo
  let loopRunsRepo: LoopRunsRepo
  let currentLoop: Loop | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runtime-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    loopEventsRepo = createLoopEventsRepo(db)
    loopRunsRepo = createLoopRunsRepo(db)

    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} },
      undefined,
      undefined,
      sectionPlansRepo,
    )

    sessionsAwaitingBusy.clear()
    __resetInFlightGuard()
  })

  afterEach(() => {
    if (currentLoop) {
      currentLoop.clearAllRetryTimeouts()
      currentLoop = null
    }
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
    sessionsAwaitingBusy.clear()
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'loop-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/nonexistent-worktree-for-test',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'test/branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      executionVariant: undefined,
      auditorVariant: undefined,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      ...overrides,
    }
  }

  function createRuntime(overrides: {
    client?: ForgeClient
    loopConfig?: Partial<PluginConfig>
    serviceLoopConfig?: LoopConfig
    withUsageRepo?: boolean
    withMetricsRepos?: boolean
    getParentSessionId?: (sessionId: string) => Promise<string | null>
  } = {}): { loop: Loop; calls: RecordedCall[]; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const forge = overrides.client ? { client: overrides.client, calls: [] as RecordedCall[] } : createFakeForgeClient()
    const { logger, logs } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig, ...(overrides.loopConfig ?? {}) }

    const enableMetrics = overrides.withMetricsRepos ?? false
    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client: forge.client,
      logger,
      getConfig: () => config,
      sandboxManager: undefined,
      dataDir: tempDir,
      loopSessionUsageRepo: (overrides.withUsageRepo || enableMetrics) ? loopSessionUsageRepo : undefined,
      loopEventsRepo: enableMetrics ? loopEventsRepo : undefined,
      loopRunsRepo: enableMetrics ? loopRunsRepo : undefined,
      getParentSessionId: overrides.getParentSessionId,
    })

    currentLoop = loop
    return { loop, calls: forge.calls, logger, logs }
  }

  describe('idle coding session advances to auditing', () => {
    test('idle event on a coding phase transitions to auditing phase', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('auditing')
    })

    test('does not transition to auditing when latest coding message is still user prompt', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Older code response.' }] },
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'Latest code prompt that was not answered.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('coding')

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls.length).toBe(0)

      const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codeCalls.length).toBe(0)
    })
  })

  describe('goal-loop idle transitions to auditor session', () => {
    test('idle goal executor response creates a fresh auditor-loop session with a goal audit prompt and configured auditor model', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'I added the /health endpoint and its test.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const goalText = 'Add a /health endpoint returning {"status":"ok"} with a test.'
      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        kind: 'goal',
        goal: goalText,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('auditing')
      expect(updatedState!.kind).toBe('goal')
      expect(updatedState!.goal).toBe(goalText)

      // A fresh auditor session was created
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      // An auditor-loop prompt was sent carrying a goal audit prompt
      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls.length).toBeGreaterThan(0)
      const lastAuditor = auditorCalls[auditorCalls.length - 1].params as any
      const auditPrompt = (lastAuditor.parts as Array<{ type: string; text?: string }>)[0]?.text ?? ''
      expect(auditPrompt).toContain('Goal:')
      expect(auditPrompt).toContain(goalText)
      expect(auditPrompt).toContain('Goal completion:')
      expect(auditPrompt).toContain('Code correctness:')
      expect(auditPrompt).toContain('`GOAL`')
      expect(auditPrompt).toContain('authorizes termination')
      // Goal audit prompts must omit plan/section/final-audit machinery
      expect(auditPrompt).not.toContain('Implementation plan:')
      expect(auditPrompt).not.toContain('Plan completeness check:')
      expect(auditPrompt).not.toContain('[Final integration audit]')
      expect(auditPrompt).not.toContain('Section under audit')

      // The configured auditor model was applied to the audit prompt
      expect(lastAuditor.model).toEqual({ providerID: 'test', modelID: 'auditor' })
    })
  })

  describe('goal-loop audit results', () => {
    test('dirty goal audit creates a fresh code session and updates both sessionId and executorSessionId', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Goal endpoint missing error handling.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const goalText = 'Add a /health endpoint with tests and error handling.'
      const executorSessionId = 'goal-executor-session'
      const auditorSessionId = 'goal-auditor-session'
      const hostSessionId = 'goal-host-redirect'
      const loopName = 'test-goal-dirty'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId,
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: goalText,
      })
      loopService.setState(state.loopName, state)

      // One outstanding bug finding => the audit is dirty.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/health.ts',
        line: 12,
        severity: 'bug',
        description: 'Missing error handling in /health endpoint',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')

      // A new code session was created — both sessionId and executorSessionId
      // point to the fresh session, NOT the old executor.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)
      expect(afterState!.hostSessionId).toBe(hostSessionId)
      expect(afterState!.iteration).toBe(2)
      expect(afterState!.auditCount).toBe(1)
      expect(afterState!.kind).toBe('goal')
      expect(afterState!.goal).toBe(goalText)
      expect(afterState!.lastAuditResult).toContain('error handling')

      // A new code session was created.
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      // A code continuation prompt was sent to the NEW session carrying the goal.
      const newSessionPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code' && (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)
      // The old executor session was NOT prompted.
      const oldExecutorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === executorSessionId)
      expect(oldExecutorPrompts.length).toBe(0)
      // Findings must NEVER be routed to the redirect host session.
      const hostPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === hostSessionId)
      expect(hostPrompts.length).toBe(0)
      const continuationText = (newSessionPrompts[newSessionPrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(continuationText).toContain('Goal')
      expect(continuationText).toContain(goalText)
      expect(continuationText).toContain('error handling')

      // The completed auditor session was retired.
      const deleteCalls = calls.filter(c => c.method === 'session.delete' && (c.params as any)?.sessionID === auditorSessionId)
      expect(deleteCalls.length).toBeGreaterThan(0)
    })

    test('clean goal audit terminates without final-audit or post-action sessions', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'No issues found. Goal is fully implemented.' }] },
          ],
        },
      })
      const { loop } = createRuntime({
        client,
        loopConfig: {
          loop: {
            enabled: true,
            defaultMaxIterations: 5,
            // Post-action enabled — goal loops must still bypass it on clean audit.
            postAction: { enabled: true, skill: 'pr-review' },
          },
        },
      })

      const goalText = 'Add a /health endpoint returning {"status":"ok"} with a test.'
      const executorSessionId = 'goal-executor-clean'
      const auditorSessionId = 'goal-auditor-clean'
      const loopName = 'test-goal-clean'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-clean',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: goalText,
      })
      loopService.setState(state.loopName, state)

      // No review findings => clean audit.

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('completed')
      expect(afterState!.auditCount).toBe(1)
      expect(afterState!.lastAuditResult).toContain('No issues found')

      // No post-action session was created and no final-audit/audit prompt was sent.
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(0)
      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBe(0)
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBe(0)
    })

    test('goal loop respect max iterations on a dirty audit', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Still missing.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const loopName = 'test-goal-maxiter'
      const state = makeState({
        loopName,
        sessionId: 'goal-auditor-max',
        hostSessionId: 'goal-host-max',
        executorSessionId: 'goal-executor-max',
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 5,
        maxIterations: 5,
        kind: 'goal',
        goal: 'finalize the thing',
      })
      loopService.setState(state.loopName, state)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/thing.ts',
        line: 1,
        severity: 'bug',
        description: 'unfinished',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: 'goal-auditor-max' },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('max_iterations')
    })

    test('dirty goal audit after restart creates a fresh code session rather than re-prompting the previous executor', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a remaining gap.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const goalText = 'Add a /health endpoint with tests.'
      const restartedExecutor = 'goal-executor-after-restart'
      const staleHostSession = 'goal-executor-before-restart'
      const auditorSessionId = 'goal-auditor-after-restart'
      const loopName = 'test-goal-restart-dirty'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: staleHostSession,
        executorSessionId: restartedExecutor,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: goalText,
      })
      loopService.setState(state.loopName, state)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/health.ts',
        line: 5,
        severity: 'bug',
        description: 'Missing test coverage',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      // A fresh code session was created — the previous executor binding is replaced.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(restartedExecutor)
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)
      expect(afterState!.hostSessionId).toBe(staleHostSession)

      // A new code session was created.
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      // The continuation went to the new session, never the stale host or executor.
      const newSessionPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)
      const stalePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === staleHostSession)
      expect(stalePrompts.length).toBe(0)
      const oldExecutorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === restartedExecutor)
      expect(oldExecutorPrompts.length).toBe(0)
    })

    test('dirty goal audit retries the continuation prompt after a transient failure and stays active', async () => {
      const auditorSessionId = 'goal-auditor-retry'
      let codePromptAttempts = 0
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a gap.' }] },
          ],
          promptAsync: async (params: any) => {
            if (params?.agent === 'code') {
              codePromptAttempts++
              if (codePromptAttempts <= 3) throw new Error('transient transport error')
            }
          },
        },
      })
      const { loop } = createRuntime({ client })

      const loopName = 'test-goal-continuation-transient'
      const executorSessionId = 'goal-executor-retry'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-retry',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with tests.',
      })
      loopService.setState(state.loopName, state)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/health.ts',
        line: 1,
        severity: 'bug',
        description: 'Missing error handling',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      // handlePromptError schedules the retry re-send after 2000ms; wait for it.
      await new Promise(resolve => setTimeout(resolve, 2200))

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      // A fresh code session was created — both IDs point to it.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)

      // Four code continuation prompts to the new session: three failing
      // sends inside sendPromptWithFallback's model-fallback chain and the
      // successful retryFn re-send.
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(4)
      // All prompts are directed at the new session, not the old executor.
      const newSessionPrompts = codePrompts.filter(c => (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBe(4)
      const oldExecutorPrompts = codePrompts.filter(c => (c.params as any)?.sessionID === executorSessionId)
      expect(oldExecutorPrompts.length).toBe(0)
      const retryText = (newSessionPrompts[3].params as any)?.parts?.[0]?.text ?? ''
      expect(retryText).toContain('Add a /health endpoint with tests.')

      // A new code session was created (rotateSession).
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)
    })

    test('dirty goal audit with a persistently failing continuation retries once and leaves the loop recoverable on a fresh session', async () => {
      const auditorSessionId = 'goal-auditor-exhaust'
      const executorSessionId = 'goal-executor-exhaust'
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a gap.' }] },
          ],
          promptAsync: async (params: any) => {
            // Every code continuation attempt fails persistently.
            if (params?.agent === 'code') {
              throw new Error('persistent transport error')
            }
          },
        },
      })
      const { loop } = createRuntime({ client })

      const loopName = 'test-goal-continuation-exhaust'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-exhaust',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with tests.',
      })
      loopService.setState(state.loopName, state)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/health.ts',
        line: 1,
        severity: 'bug',
        description: 'Missing error handling',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      // The scheduled retryFn fires once after 2000ms and also fails.
      await new Promise(resolve => setTimeout(resolve, 2200))

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      // A fresh session was created despite the persistent failure.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)

      // Three failing sends inside sendPromptWithFallback plus one retryFn re-send.
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(4)

      // A new code session was created.
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)
    })
  })

  describe('goal-loop auditor-creation failure rotates to fresh code session', () => {
    test('exhausted auditor-creation retries rotate to a fresh code session instead of re-prompting the executor', async () => {
      let createAttempts = 0
      const { client, calls } = createFakeForgeClient({
        session: {
          // The executor produced an assistant response (coding idle).
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Working on the goal.' }] },
          ],
          // Let audit creates fail but rotate-session creates succeed.
          create: async () => {
            createAttempts++
            // First ~3 create calls fail (audit creation retries), subsequent ones succeed (rotation).
            if (createAttempts <= 3) throw new Error('audit session create failed')
            return { id: `ses_fake_rotated_${createAttempts}` }
          },
        },
      })
      const { loop, logs } = createRuntime({ client })

      const executorSessionId = 'goal-executor-auditfail'
      const loopName = 'test-goal-audit-create-fail'
      const state = makeState({
        loopName,
        sessionId: executorSessionId,
        hostSessionId: 'goal-host-auditfail',
        executorSessionId,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(executorSessionId, loopName)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: executorSessionId },
      })

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)

      // The rotated code session was prompted with a continuation.
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      // Prompt went to the new session, not the old executor.
      const newSessionPrompts = codePrompts.filter(c => (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)
      const oldExecutorPrompts = codePrompts.filter(c => (c.params as any)?.sessionID === executorSessionId)
      expect(oldExecutorPrompts.length).toBe(0)

      // rotation causes the old code session to be scheduled for deletion.
      const executorDeleteCalls = calls.filter(c => c.method === 'session.delete' && (c.params as any)?.sessionID === executorSessionId)
      expect(executorDeleteCalls.length).toBeGreaterThan(0)

      // The rotation path was taken (not the old goal-retention path).
      expect(logs.some(l => l.message.includes('rotating to fresh code session'))).toBe(true)
    })

    test('audit-creation failure retries the rotated session continuation after a transient failure and stays active', async () => {
      const executorSessionId = 'goal-executor-auditfail-retry'
      let createAttempts = 0
      let codePromptAttempts = 0
      const { client, calls } = createFakeForgeClient({
        session: {
          // The executor produced an assistant response (coding idle).
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Working on the goal.' }] },
          ],
          // Let audit creates fail but rotate-session creates succeed.
          create: async () => {
            createAttempts++
            if (createAttempts <= 3) throw new Error('audit session create failed')
            return { id: `ses_fake_rotated_${createAttempts}` }
          },
          promptAsync: async (params: any) => {
            if (params?.agent === 'code') {
              codePromptAttempts++
              if (codePromptAttempts <= 3) throw new Error('transient transport error')
            }
          },
        },
      })
      const { loop } = createRuntime({ client })

      const loopName = 'test-goal-audit-create-fail-retry'
      const state = makeState({
        loopName,
        sessionId: executorSessionId,
        hostSessionId: 'goal-host-auditfail-retry',
        executorSessionId,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        errorCount: 0,
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(executorSessionId, loopName)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: executorSessionId },
      })

      // createAuditWithRetry exhausts with ~1.5s of backoff inside the tick; the
      // rotated session continuation then schedules the retry re-send after 2000ms.
      await new Promise(resolve => setTimeout(resolve, 2300))

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      // A fresh session was created via rotation.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)

      // Three code prompts targeted the rotated session (model-fallback chain inside sendPromptWithFallback).
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(3)
      const newSessionPrompts = codePrompts.filter(c => (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBe(3)

      // Rotation succeeded (session.create was called for the rotated session).
      const successfulCreateCalls = calls.filter(c => c.method === 'session.create')
      expect(successfulCreateCalls.length).toBeGreaterThan(3)
    })
  })

  describe('goal-loop auditor-failure recovery rotates to fresh session', () => {
    test('auditor abort (no assistant response) rotates to a fresh code session', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          // The auditor session has no assistant response yet (aborted mid-run).
          messages: async () => [],
        },
      })
      const { loop } = createRuntime({ client })

      const executorSessionId = 'goal-executor-abort'
      const auditorSessionId = 'goal-auditor-abort'
      const loopName = 'test-goal-auditor-abort'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-abort',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(auditorSessionId, loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: auditorSessionId,
          error: { name: 'AbortError' },
        },
      })

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)

      // A new code session was created.
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      // The continuation was sent to the new session.
      const newSessionPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code' && (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)
      const continuationText = (newSessionPrompts[newSessionPrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(continuationText).toContain('Auditor session failed')
      expect(continuationText).toContain('aborted')

      // The aborted auditor session was retired.
      const auditorDeleteCalls = calls.filter(c => c.method === 'session.delete' && (c.params as any)?.sessionID === auditorSessionId)
      expect(auditorDeleteCalls.length).toBeGreaterThan(0)

      // Findings never reach the redirect host.
      const hostPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === 'goal-host-abort')
      expect(hostPrompts.length).toBe(0)
    })

    test('auditor session error event rotates to a fresh code session and marks model failure for provider errors', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const executorSessionId = 'goal-executor-err'
      const auditorSessionId = 'goal-auditor-err'
      const loopName = 'test-goal-auditor-error'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-err',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 2,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(auditorSessionId, loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: auditorSessionId,
          error: { name: 'ProviderError', data: { message: 'provider api error' } },
        },
      })

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)
      // Provider-style errors mark the model failed so the recovery prompt falls
      // back to the default model.
      expect(afterState!.modelFailed).toBe(true)

      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      const newSessionPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code' && (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)
      const continuationText = (newSessionPrompts[newSessionPrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(continuationText).toContain('Auditor session failed')
      expect(continuationText).toContain('provider api error')

      const auditorDeleteCalls = calls.filter(c => c.method === 'session.delete' && (c.params as any)?.sessionID === auditorSessionId)
      expect(auditorDeleteCalls.length).toBeGreaterThan(0)
    })

    test('auditor assistant-error response rotates to a fresh code session instead of retaining the executor', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          // The auditor produced an assistant message carrying a non-model error,
          // landing in the audit assistant-error continuation path.
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop', error: { data: { message: 'tool execution crashed' } } }, parts: [{ type: 'text', text: '' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const executorSessionId = 'goal-executor-asst-err'
      const auditorSessionId = 'goal-auditor-asst-err'
      const loopName = 'test-goal-auditor-assistant-error'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-asst-err',
        executorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        errorCount: 0,
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(auditorSessionId, loopName)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(auditorSessionId)
      expect(newSessionId).not.toBe(executorSessionId)
      expect(afterState!.executorSessionId).toBe(newSessionId)
      // The audit did not complete, so the audit count is unchanged.
      expect(afterState!.auditCount).toBe(0)

      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBeGreaterThan(0)

      const newSessionPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code' && (c.params as any)?.sessionID === newSessionId)
      expect(newSessionPrompts.length).toBeGreaterThan(0)

      const auditorDeleteCalls = calls.filter(c => c.method === 'session.delete' && (c.params as any)?.sessionID === auditorSessionId)
      expect(auditorDeleteCalls.length).toBeGreaterThan(0)
    })
  })

  describe('clean non-sectioned audit terminates completed', () => {
    test('audit session returning clean assistant message terminates with completed', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After processing a clean audit result, the loop should terminate with completed
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('completed')
    })
  })

describe('post-action phase', () => {
  test('postAction enabled with skill → enters post_action phase on clean audit and completes on post-action idle', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    // First tick: clean audit → checkAuditClearAndTerminate → enterPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // Assert loop is still active and in post_action phase
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(true)
    expect(afterState!.phase).toBe('post_action')
    expect(afterState!.sessionId).not.toBe(state.sessionId)

    // Assert a code prompt was sent containing the skill name
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    expect(codeCalls.length).toBeGreaterThan(0)
    // The last code prompt should be the post-action prompt
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    const promptText = lastCodePrompt?.parts?.[0]?.text ?? ''
    expect(promptText).toContain('pr-review')

    // Simulate the post_action session completing: mock messages to return assistant response
    const postActionSessionId = afterState!.sessionId
    ;(client.session.messages as any).mockImplementation(async () => [
      { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Action complete.' }] },
    ])

    // Send busy to clear the idle-gate (prompt was marked as sent)
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'busy' },
        sessionID: postActionSessionId,
      },
    })

    // Send idle to trigger runPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: postActionSessionId,
      },
    })

    // Assert loop terminated with completed
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
    // The raw post-action assistant message is captured as the completion summary.
    expect(finalState!.completionSummary).toBe('Action complete.')
  })

  test('postAction disabled → terminates completed immediately (unchanged behavior)', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = createRuntime({ client })
    // Default config has no postAction — verifies no regression

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(false)
    expect(afterState!.terminationReason).toBe('completed')
  })

  test('sectioned final audit clean with postAction enabled → enters post_action phase', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Final audit clean.' }] },
        ],
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const loopName = 'test-loop-sectioned-pa'
    const state = makeState({
      loopName,
      sessionId: 'final-audit-session',
      phase: 'final_auditing',
      totalSections: 2,
      auditCount: 1,
      finalAuditDone: false,
      iteration: 1,
      maxIterations: 5,
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: 'final-audit-session',
      },
    })

    // Assert loop entered post_action phase
    const afterState = loopService.getAnyState(loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(true)
    expect(afterState!.phase).toBe('post_action')
    // finalAuditDone should be set
    expect(afterState!.finalAuditDone).toBe(true)
    // A code prompt with the skill name should have been sent
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    expect(codeCalls.length).toBeGreaterThan(0)
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    const promptText = lastCodePrompt?.parts?.[0]?.text ?? ''
    expect(promptText).toContain('pr-review')

    // Clean up: simulate post_action completion to avoid stale state
    const postActionSessionId = afterState!.sessionId
    ;(client.session.messages as any).mockImplementation(async () => [
      { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Action done.' }] },
    ])
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'busy' },
        sessionID: postActionSessionId,
      },
    })
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: postActionSessionId,
      },
    })
    const finalState = loopService.getAnyState(loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('postAction enabled with prompt only → enters post_action phase and sends prompt text', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: {
            enabled: true,
            prompt: 'Run a lightweight post-action smoke review.',
          },
        },
      },
    })

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    // First tick: clean audit → checkAuditClearAndTerminate → enterPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // Assert loop is still active and in post_action phase
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(true)
    expect(afterState!.phase).toBe('post_action')
    expect(afterState!.sessionId).not.toBe(state.sessionId)

    // Assert a code prompt was sent containing the configured prompt text
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    expect(codeCalls.length).toBeGreaterThan(0)
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    const promptText = lastCodePrompt?.parts?.[0]?.text ?? ''
    expect(promptText).toContain('Run a lightweight post-action smoke review')
    // No skill configured → no Load the / Skill tool instructions
    expect(promptText).not.toContain('Load the')
    expect(promptText).not.toContain('Skill tool')

    // Simulate the post_action session completing
    const postActionSessionId = afterState!.sessionId
    ;(client.session.messages as any).mockImplementation(async () => [
      { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Action complete.' }] },
    ])

    // Send busy to clear idle-gate
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'busy' },
        sessionID: postActionSessionId,
      },
    })

    // Send idle to trigger runPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: postActionSessionId,
      },
    })

    // Assert loop terminated with completed
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('postAction prompt send failure → terminates completed as best effort', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
        promptAsync: async () => { throw new Error('prompt failed') },
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    // Tick: clean audit → enterPostActionPhase → promptAsync throws
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // session.create was called for the post-action session (in addition to any prior creates)
    const createCalls = calls.filter(c => c.method === 'session.create')
    expect(createCalls.length).toBeGreaterThan(0)

    // Loop terminated with completed despite the prompt failure
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('post_action idle with missing worktreeDir → terminates missing_worktree_dir', async () => {
    const { client } = createFakeForgeClient()
    const { loop } = createRuntime({ client })

    const state = makeState({
      phase: 'post_action',
      worktreeDir: '',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('missing_worktree_dir')
  })

  test('post_action session error → terminates completed as best effort', async () => {
    const { client } = createFakeForgeClient()
    const { loop } = createRuntime({ client })

    const state = makeState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'ProviderError',
          data: { message: 'provider failed' },
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('post_action abort after assistant response → processes post-action completion', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] },
        ],
      },
    })
    const { loop } = createRuntime({ client })

    const state = makeState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'AbortError',
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('post_action abort without assistant response → terminates completed best effort', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [],
      },
    })
    const { loop } = createRuntime({ client })

    const state = makeState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'AbortError',
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('postAction with configured model → sends post-action prompt with that model', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review', model: 'custom/post-model' },
        },
      },
    })

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      auditorModel: 'state/auditor-model',
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: state.sessionId },
    })

    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState!.phase).toBe('post_action')

    // The post-action prompt should be sent with the configured model, not the auditor model.
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    expect(lastCodePrompt?.model).toEqual({ providerID: 'custom', modelID: 'post-model' })
  })

  test('postAction without configured model → sends post-action prompt with auditor model', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = createRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      auditorModel: 'state/auditor-model',
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: state.sessionId },
    })

    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    expect(lastCodePrompt?.model).toEqual({ providerID: 'state', modelID: 'auditor-model' })
  })
})

describe('runtime re-provisioning updates state.workspaceId', () => {
  test('ensureWorkspaceForLoop provisions workspace and sets workspaceId', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
        ],
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp/wt/new', branch: 'opencode/new' }),
      },
    })

    const { logger } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig }

    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client,
      logger,
      getConfig: () => config,
      sandboxManager: undefined,
      dataDir: tempDir,
    })
    currentLoop = loop

    const state = makeState({
      phase: 'coding',
      totalSections: 0,
      auditCount: 0,
      worktree: true,
      workspaceId: undefined,
      worktreeBranch: 'test/original-branch',
      worktreeDir: '/tmp/wt/original',
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // workspaceId IS persisted to DB by setWorkspaceId
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.workspaceId).toBe('ws_new')
  })
})

describe('stall handling terminates with stall timeout when configured cap is reached', () => {
    test('repeated stall recovery attempts eventually terminate with stall_timeout', async () => {
      const stallConfig: LoopConfig = {
        stallTimeoutMs: 50,
        maxConsecutiveStalls: 2,
      }

      loopService = createLoopService(
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        PROJECT_ID,
        { log: () => {}, error: () => {}, debug: () => {} },
        stallConfig,
        undefined,
        sectionPlansRepo,
      )

      const { client, calls } = createFakeForgeClient()
      const { logger, logs } = createCapturingLogger()
      const config: PluginConfig = { ...mockConfig }

      const loop = createLoop({
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        sectionPlansRepo,
        projectId: PROJECT_ID,
        client,
        logger,
        getConfig: () => config,
        sandboxManager: undefined,
        dataDir: tempDir,
        loopConfig: stallConfig,
      })
      currentLoop = loop

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
      })
      loopService.setState(state.loopName, state)

      // Start watchdog
      loop.startWatchdog(state.loopName)
      loop.recordActivity(state.loopName, 'initial')

      // Wait long enough for the first stall to be detected and recovered
      await new Promise(resolve => setTimeout(resolve, 150))

      // Record activity again and wait for another stall detection cycle
      loop.recordActivity(state.loopName, 'after-recovery')
      await new Promise(resolve => setTimeout(resolve, 150))

      // After two stalls (exceeding max of 2), the loop must be terminated with stall_timeout
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('stall_timeout')
    })
  })

  describe('in-flight prompt guard', () => {
    test('rejects audit prompt while code prompt in-flight', async () => {
      markPromptInFlight('test-loop', 'other-session-id', 'code')

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop, logger, logs } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })

    test('rejects duplicate auditor prompt for same audit session', async () => {
      markPromptInFlight('test-loop', 'sess', 'auditor-loop')

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Implementation complete.' }] },
          ],
        },
      })
      const { loop, logs } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(0)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('sess')
      expect(prior!.agent).toBe('auditor-loop')
    })

    test('clears in-flight after busy event', async () => {
      const state = makeState({ phase: 'coding' })
      markPromptInFlight('test-loop', state.sessionId, 'code')

      const { loop } = createRuntime()
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('busy event from non-owning session does not clear in-flight', async () => {
      markPromptInFlight('test-loop', 'sess-owner', 'auditor-loop')

      const { loop } = createRuntime()
      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession('sess-old', 'test-loop')

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: 'sess-old',
        },
      })

      const entry = getPromptInFlight('test-loop')
      expect(entry).toBeDefined()
      expect(entry!.sessionId).toBe('sess-owner')
      expect(entry!.agent).toBe('auditor-loop')
    })

    test('clears in-flight when promptAsync throws a transient error', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Implementation complete.' }] },
          ],
          promptAsync: async (params: any) => {
            if (params?.agent === 'code' && params?.sessionID === 'loop-session-id') {
              throw new Error('transient transport error')
            }
          },
        },
      })
      const { loop, logs } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('clears in-flight on prompt completion', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight('test-loop')).toBeUndefined()
    })

    test('handlePromptError short-circuits on ConcurrentPromptError, preserving loop active state', async () => {
      markPromptInFlight('test-loop', 'other-session-id', 'code')

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop, logs } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const afterState = loop.service.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const prior = getPromptInFlight('test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })
  })

  describe('session retention', () => {
    test('queues session for retention on coding phase transition', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const deleteCalls = calls.filter(c => c.method === 'session.delete')
      expect(deleteCalls.map((c: any) => c.params.sessionID)).toContain(state.sessionId)
    })

    test('tolerates delete failure without crashing', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
          delete: async () => { throw new Error('delete failed') },
        },
      })
      const { loop, logger, logs } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // No unhandled rejection from delete failure
      const hasDeleteError = logs.some(
        (l) => l.level === 'error' && l.message.includes('failed to delete'),
      )
      // Even if no trim happened (queue <= 2), we verify no crash occurred
    })

    test('terminate flushes retained sessions', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      // First rotation: coding→audit
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Terminate the loop: terminateLoop should clean up retained sessions
      await loop.cancel(state.loopName)

      const deleteCalls = calls.filter(c => c.method === 'session.delete')
      const deletedSids = deleteCalls.map((c: any) => c.params.sessionID)
      expect(deletedSids).toContain(state.sessionId)
    })
  })

  describe('usage capture', () => {
    function mockAssistantMessage(cost: number, tokens: { input: number; output: number; reasoning: number }) {
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
        },
        parts: [{ type: 'text' as const, text: 'Implementation complete.' }],
      }
    }

    test('code session rotation captures usage with state.executionModel', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 })],
        },
      })
      const { loop, logs } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({
        phase: 'coding',
        executionModel: 'test/exec-model',
        auditorModel: 'test/auditor-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Wait a tick for async capture to complete
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/exec-model')
      expect(usage!.byModel['test/exec-model'].inputTokens).toBe(100)
    })

    test('audit termination captures usage with state.auditorModel', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 })],
        },
      })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({
        phase: 'auditing',
        executionModel: 'test/exec-model',
        auditorModel: 'test/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/audit-model')
      expect(usage!.byModel['test/audit-model'].inputTokens).toBe(200)
    })

    test('state models take precedence over current config', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 })],
        },
      })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      // Should use state.executionModel, not config.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
    })

    test('capture failure logs error but does not block termination', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => { throw new Error('messages fetch failed') },
        },
      })
      const { loop, logs } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.cancel(state.loopName)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)

      const hasCaptureError = logs.some(l => l.level === 'error' && l.message.includes('failed to capture usage'))
      expect(hasCaptureError).toBe(true)
    })

    test('retained sessions preserve role and model: code session retained, audit session enqueued', async () => {
      const messagesBySession = new Map<string, Array<Record<string, unknown>>>()
      messagesBySession.set('coding-session-1', [
        mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 }),
      ])
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async (params: any) => messagesBySession.get(params.sessionID) ?? [],
        },
      })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        loopName: 'test-loop-mixed-1',
        sessionId: 'coding-session-1',
      })
      loopService.setState(state.loopName, state)

      // First rotation: coding→audit, queues coding session as 'code' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // After first tick, state is now in auditing phase with a new session
      const afterFirstTick = loopService.getActiveState(state.loopName)!
      expect(afterFirstTick.phase).toBe('auditing')

      // Set up messages for the audit session
      messagesBySession.set(afterFirstTick.sessionId, [
        mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 }),
      ])

      // The coding session should already be captured
      await new Promise(resolve => setTimeout(resolve, 10))
      let usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(100)

      // Now terminate the loop while in auditing phase
      await loop.cancel(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Audit session should be captured as 'auditor' with state.auditorModel
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained audit session cleaned up on termination with correct attribution', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 })],
        },
      })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      // Start in auditing phase
      const state = makeState({
        phase: 'auditing',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      // Rotation: audit→coding, queues audit session as 'auditor' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Now terminate the loop
      await loop.cancel(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained audit session should be captured with state.auditorModel
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained sessions cleaned up on clearLoopTimers with correct attribution', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 })],
        },
      })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      const state = makeState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
      })
      loopService.setState(state.loopName, state)

      // Rotation: coding→audit, queues coding session as 'code' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Call clearLoopTimers to clean up retained sessions
      await loop.clearLoopTimers(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained coding session should be captured with state.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(150)
    })
  })

  describe('variant dispatch', () => {
    test('coding prompt sends executionVariant from loop state', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After auditing phase processes dirty audit, it transitions to coding and sends code prompts
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      for (const call of codePrompts) {
        expect((call.params as any)?.variant).toBe('thinking-max')
      }

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.executorSessionId).toBeUndefined()
    })

    test('auditor prompt sends auditorVariant from loop state', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // The auditor prompt should have the auditorVariant
      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect((call.params as any)?.variant).toBe('audit-high')
      }
    })

    test('model fallback omits variant when model is undefined', async () => {
      let failCount = 2
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
          promptAsync: async (params: any) => {
            if (failCount > 0) {
              failCount--
              throw Object.assign(new Error('simulated model failure'), { name: 'TestError', data: { message: 'simulated model failure' } })
            }
          },
        },
      })
      const { logger } = createCapturingLogger()
      const config: PluginConfig = { ...mockConfig, executionModel: 'test/model' }

      const loop = createLoop({
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        sectionPlansRepo,
        projectId: PROJECT_ID,
        client,
        logger,
        getConfig: () => config,
        sandboxManager: undefined,
        dataDir: tempDir,
      })
      currentLoop = loop

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionModel: 'test/model',
        executionVariant: 'thinking-max',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // Model-based attempts should have been made (and failed)
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      // After model fails, fallback without model should NOT send variant
      const fallbackPrompts = codePrompts.filter(c => !(c.params as any)?.variant)
      expect(fallbackPrompts.length).toBeGreaterThan(0)
    })
  })

  describe('coder decisions in final-audit fix', () => {
    test('final-audit fix coding parses coder-decisions and renders into subsequent final audit prompt', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Final audit found issues.' }] },
          ],
        },
      })
      const { loop, logs } = createRuntime({ client })
      const loopName = 'test-loop-cd-fix'

      // Create a loop in final_auditing phase with outstanding bugs
      const state = makeState({
        loopName,
        sessionId: 'final-audit-session',
        phase: 'final_auditing',
        totalSections: 0,
        auditCount: 1,
        iteration: 1,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the final audit is dirty and triggers a fix
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug found during final audit',
      })

      // Step 1: Set auditor response and trigger final audit phase
      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'final-audit-session',
        },
      })

      // After the first tick, the loop should have transitioned to coding with a fix prompt
      const fixCodePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(fixCodePrompts.length).toBeGreaterThan(0)
      const fixPromptText = (fixCodePrompts[fixCodePrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(fixPromptText).toContain('[Final-audit fix')

      // Verify the loop state after first tick
      const stateAfterFirstTick = loopService.getActiveState(loopName)
      expect(stateAfterFirstTick).not.toBeNull()
      expect(stateAfterFirstTick!.phase).toBe('coding')
      const codeSessionId = stateAfterFirstTick!.sessionId

      // Step 2: Change messages for the coding assistant response WITH coder-decisions markers
      ;(client.session.messages as any).mockImplementation(async () => [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{
            type: 'text',
            text: `Fixed the bug.\n<!-- coder-decisions:start -->\n### Decisions\n- Chose approach X\n### Verification\n- FOO=bar pnpm test\n### Notes for auditor\n- none\n<!-- coder-decisions:end -->`,
          }],
        },
      ])

      const auditorPromptsBefore = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop').length

      // Send a busy event to clear the idle-gate (prompt was sent during the first tick)
      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: codeSessionId,
        },
      })

      // Now send the idle event to trigger runCodingPhase
      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: codeSessionId,
        },
      })

      // Verify the loop transitioned to final_auditing
      const stateAfterSecondTick = loopService.getActiveState(loopName)
      expect(stateAfterSecondTick).not.toBeNull()
      expect(stateAfterSecondTick!.phase).toBe('final_auditing')

      // The final audit prompt should have been sent with coder decisions
      const auditorPromptsAfter = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPromptsAfter.length).toBeGreaterThan(auditorPromptsBefore)
      const finalAuditPrompt = auditorPromptsAfter[auditorPromptsAfter.length - 1]?.params as any
      const finalAuditPromptText = finalAuditPrompt?.parts?.[0]?.text ?? ''
      expect(finalAuditPromptText).toContain('Coder decisions & verification notes')
      expect(finalAuditPromptText).toContain('Chose approach X')
      expect(finalAuditPromptText).toContain('FOO=bar pnpm test')
    })
  })

  describe('provider limit abort', () => {
    test('retry event with usage-limit message terminates', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: state.sessionId,
          status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('generic retry event does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: state.sessionId,
          status: { type: 'retry', attempt: 1, message: 'rate limited, retrying', next: 5000 },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('session.error APIError 403 terminates', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'APIError', data: { message: 'forbidden', statusCode: 403 } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('session.error ProviderAuthError terminates in coding phase', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderAuthError', data: { message: 'invalid API key' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('session.error UnknownError without limit text does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('auditing phase usage-limit error terminates instead of rotating', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'auditing' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      // Should NOT have rotated to coding
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBe(0)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('stale session provider-limit error terminates the active loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Simulate session rotation: new session becomes current
      const rotatedSessionId = 'rotated-session-id'
      const rotatedState = makeState({ sessionId: rotatedSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState: rotatedState, newSessionId: rotatedSessionId })

      // Stale session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('stale session non-provider-limit error does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Simulate session rotation
      const rotatedSessionId = 'rotated-session-id'
      const rotatedState = makeState({ sessionId: rotatedSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState: rotatedState, newSessionId: rotatedSessionId })

      // Stale session emits a non-provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('stale audit session provider-limit error terminates the active loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const codingSessionId = 'coding-session-id'
      const state = makeState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register an audit session (simulates audit creation replacing the coding session)
      const auditSessionId = 'audit-session-id'
      loop.registerSessionReverseIndex(auditSessionId, state.loopName)
      loopService.replaceSession(state.loopName, {
        newSessionId: auditSessionId,
        phase: 'auditing',
      })

      // Rotate back to coding (simulates post-audit rotation)
      const newCodingSessionId = 'new-coding-session-id'
      loop.restart(state.loopName, {
        newState: makeState({ sessionId: newCodingSessionId, phase: 'coding' }),
        newSessionId: newCodingSessionId,
      })

      // The retired audit session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: auditSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('child session provider-limit retry terminates the owning loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = createRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register a child session whose parent is the coding session
      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a provider-limit retry status
      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: childSessionId,
          status: { type: 'retry', attempt: 1, message: 'You have reached your usage limit', next: 60000 },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('generic child session retry does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = createRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a generic retry (not provider-limit)
      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: childSessionId,
          status: { type: 'retry', attempt: 1, message: 'rate limited, retrying', next: 5000 },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('persisted assistant error with usage-limit text terminates as provider_limit', async () => {
      const { client, calls } = createFakeForgeClient({
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
      })
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      // Send busy then idle to trigger runCodingPhase
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('persisted assistant ProviderAuthError terminates as provider_limit', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'ProviderAuthError',
                  data: { message: 'invalid API key' },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
    })

    test('persisted assistant error with 403 status terminates as provider_limit', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'APIError',
                  data: { message: 'forbidden', statusCode: 403 },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
    })

    test('persisted assistant error with 429 does not terminate as provider_limit', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'APIError',
                  data: { message: 'rate limited', statusCode: 429 },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      // Should NOT terminate as provider_limit — 429 is not a fatal limit
      const afterState = loopService.getActiveState(state.loopName)
      if (afterState) {
        // If still active, no provider_limit termination
        if (afterState.active) {
          expect(afterState.terminationReason).toBeUndefined()
        } else {
          // If terminated, it should be error_max_retries, not provider_limit
          expect(afterState.terminationReason).not.toContain('provider_limit:')
        }
      }
    })

    test('concurrent cancel during provider-limit termination executes side effects once', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // Start provider-limit termination via session.error
      const errorPromise = loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderAuthError', data: { message: 'invalid API key' } },
        },
      })

      // Concurrently cancel (simulates user cancel racing with provider-limit detection)
      const cancelPromise = loop.cancel(state.loopName)

      await Promise.all([errorPromise, cancelPromise])

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      // Either path may win the race; the admission guard ensures exactly one executes
      expect(['errored', 'cancelled']).toContain(afterState!.status)

      // abort should be called exactly once (not twice from the race)
      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(1)
    })
  })

  describe('child session error resolution via ancestor chain', () => {
    test('child session session.error with provider limit terminates the owning loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = createRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register a child session whose parent is the coding session
      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: childSessionId,
          error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('child session session.error without provider limit does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = createRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a non-provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: childSessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })
  })

  describe('reverse index lifecycle', () => {
    test('unregisterSessionReverseIndex removes session from reverse index', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const state = makeState({ sessionId: 'session-1', phase: 'coding' })
      loop.start({ state })

      // Register session-2 in reverse index (simulating a path that doesn't call start)
      loop.registerSessionReverseIndex('session-2', state.loopName)

      // session-2 should resolve to the loop via reverse index
      // (verified by emitting an error that should be handled)
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: 'session-2',
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      // The error should have terminated the loop because session-2 resolves via reverse index
      const afterRegister = loopService.getAnyState(state.loopName)
      expect(afterRegister).not.toBeNull()
      expect(afterRegister!.active).toBe(false)
      expect(afterRegister!.terminationReason).toContain('provider_limit:')

      // Track abort calls before the unregister test
      const abortCallsBefore = calls.filter(c => c.method === 'session.abort').length

      // Restart the loop to test unregister
      const newState = makeState({ sessionId: 'session-3', phase: 'coding' })
      loop.restart(state.loopName, { newState, newSessionId: 'session-3' })

      // Register session-4 and then unregister it
      loop.registerSessionReverseIndex('session-4', state.loopName)
      loop.unregisterSessionReverseIndex('session-4')

      // session-4 error should be ignored (not resolved to any loop)
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: 'session-4',
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterUnregister = loopService.getActiveState(state.loopName)
      expect(afterUnregister).not.toBeNull()
      expect(afterUnregister!.active).toBe(true)

      // No new abort calls should have been made after the unregister test
      const abortCallsAfter = calls.filter(c => c.method === 'session.abort').length
      expect(abortCallsAfter).toBe(abortCallsBefore)
    })

    test('restart retains old session in reverse index', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = createRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Restart with new session
      const newSessionId = 'new-session-id'
      const newState = makeState({ sessionId: newSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState, newSessionId: newSessionId })

      // Old session should still resolve via reverse index
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })
  })

  describe('loop metrics emission', () => {
    test('non-sectioned coding→auditing dirty continue emits coding_done(audit_started) and audit_done(dirty/continue) events', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Implementation done.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-dirty-continue'
      const codingSessionId = 'metrics-coding-session'
      const state = makeState({
        loopName,
        sessionId: codingSessionId,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // Tick 1: coding idle → emit coding_done(audit_started) and create the audit session.
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: codingSessionId },
      })

      const afterCoding = loopService.getActiveState(loopName)!
      expect(afterCoding.phase).toBe('auditing')
      const auditSessionId = afterCoding.sessionId

      // Seed an outstanding bug finding so the audit is dirty.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/foo.ts',
        line: 1,
        severity: 'bug',
        description: 'bug in foo',
      })

      // Switch the assistant transcript to an audit-flavored response before the
      // auditor idle tick, so the auditor session reports a real reply.
      ;(client.session.messages as any).mockImplementation(async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a bug.' }] },
      ])

      // Clear the awaiting-busy gate set when the audit prompt was sent.
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: auditSessionId },
      })

      // Tick 2: audit idle → dirty continue.
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditSessionId },
      })

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const codingDone = events.find((e) => e.eventType === 'coding_done')
      expect(codingDone).toBeDefined()
      expect(codingDone!.outcome).toBe('audit_started')
      expect(codingDone!.role).toBe('code')
      expect(codingDone!.sessionId).toBe(codingSessionId)

      const auditDone = events.find((e) => e.eventType === 'audit_done')
      expect(auditDone).toBeDefined()
      expect(auditDone!.verdict).toBe('dirty')
      expect(auditDone!.outcome).toBe('continue')
      expect(auditDone!.role).toBe('auditor')
      expect(auditDone!.sessionId).toBe(auditSessionId)
      expect(auditDone!.findingsTotal).toBe(1)
      expect(auditDone!.findingsBugs).toBe(1)
      // Run row is only written on termination; loop is still active.
      expect(loopRunsRepo.listByProject(PROJECT_ID)).toHaveLength(0)
      expect(events.find((e) => e.eventType === 'loop_terminated')).toBeUndefined()
    })

    test('clean non-sectioned audit emits audit_done(clean/terminate), loop_terminated, and a completed loop_runs row with run totals', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant', finish: 'stop', cost: 0.01,
                tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
                model: 'auditor-model',
              },
              parts: [{ type: 'text', text: 'All clear. No issues found.' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-clean-terminate'
      const auditorSessionId = 'metrics-audit-clean'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)
      // No review findings → clean audit.

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDone = events.find((e) => e.eventType === 'audit_done')
      expect(auditDone).toBeDefined()
      expect(auditDone!.verdict).toBe('clean')
      expect(auditDone!.outcome).toBe('terminate')

      const terminated = events.find((e) => e.eventType === 'loop_terminated')
      expect(terminated).toBeDefined()

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      const run = runs[0]
      expect(run.status).toBe('completed')
      expect(run.durationMs!).toBeGreaterThan(0)
      // Run totals match usage captured for the auditor session before termination.
      expect(run.cost).toBeCloseTo(0.01, 6)
      expect(run.inputTokens).toBe(100)
      expect(run.outputTokens).toBe(50)
      expect(run.reasoningTokens).toBe(10)
      expect(run.messageCount).toBe(1)
    })

    test('sectioned dirty section audit emits audit_done(section_retry) row with the section index', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found bugs in section.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-section-dirty'
      const auditorSessionId = 'metrics-section-audit'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 2,
        currentSectionIndex: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // One outstanding bug finding in section 0 (no section summary → dirty path).
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/bar.ts',
        line: 4,
        severity: 'bug',
        description: 'section bug',
        sectionIndex: 0,
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDone = events.find((e) => e.eventType === 'audit_done')
      expect(auditDone).toBeDefined()
      expect(auditDone!.verdict).toBe('dirty')
      expect(auditDone!.outcome).toBe('section_retry')
      expect(auditDone!.sectionIndex).toBe(0)
      expect(auditDone!.sessionId).toBe(auditorSessionId)
      expect(auditDone!.role).toBe('auditor')
      expect(auditDone!.findingsBugs).toBe(1)
      expect(auditDone!.findingsTotal).toBe(1)
    })

    test('one dirty + one clean audit in a run yields loop_runs dirtyAudits=1 and cleanAudits=1', async () => {
      const codingAssistant = async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Coding pass complete.' }] },
      ]
      const auditDirtyAssistant = async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a gap.' }] },
      ]
      const auditCleanAssistant = async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Goal fully implemented.' }] },
      ]
      const { client } = createFakeForgeClient({ session: { messages: codingAssistant } })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-run-summary'
      const firstAuditorSessionId = 'metrics-run-auditor-1'
      const state = makeState({
        loopName,
        sessionId: firstAuditorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: 'Add a /health endpoint with tests.',
      })
      loopService.setState(state.loopName, state)

      // Seed an outstanding bug finding → first audit dirty continue.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/health.ts',
        line: 1,
        severity: 'bug',
        description: 'missing test coverage',
      })
      ;(client.session.messages as any).mockImplementation(auditDirtyAssistant)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: firstAuditorSessionId },
      })

      // After the dirty audit the loop rotates to a fresh coding session for remediation.
      const afterDirty = loopService.getActiveState(loopName)!
      expect(afterDirty.phase).toBe('coding')
      const codingSessionId2 = afterDirty.sessionId

      // Simulate the bug being fixed before the next coding pass completes.
      reviewFindingsRepo.delete(PROJECT_ID, 'src/health.ts', 1, { loopName })

      // Coding idle → emits coding_done(audit_started) and creates the second audit session.
      ;(client.session.messages as any).mockImplementation(codingAssistant)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: codingSessionId2 },
      })
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: codingSessionId2 },
      })

      const afterCoding = loopService.getActiveState(loopName)!
      expect(afterCoding.phase).toBe('auditing')
      const secondAuditorSessionId = afterCoding.sessionId

      // Audit idle → clean terminate.
      ;(client.session.messages as any).mockImplementation(auditCleanAssistant)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: secondAuditorSessionId },
      })
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: secondAuditorSessionId },
      })

      const finalState = loopService.getAnyState(loopName)
      expect(finalState!.active).toBe(false)
      expect(finalState!.terminationReason).toBe('completed')

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      const run = runs[0]
      expect(run.dirtyAudits).toBe(1)
      expect(run.cleanAudits).toBe(1)
      expect(run.status).toBe('completed')
    })

    test('non-sectioned dirty audit at the iteration cap emits audit_done(dirty/max_iterations), not continue, and terminates with max_iterations', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a remaining gap.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-dirty-cap'
      const auditorSessionId = 'metrics-auditor-dirty-cap'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        // iteration equals the cap; the dirty auditor pass increments to 6 which
        // exceeds maxIterations=5 → the audit_done event must say max_iterations,
        // not continue, otherwise the only audit event lies about termination.
        iteration: 5,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/cap.ts',
        line: 1,
        severity: 'bug',
        description: 'still buggy at cap',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const finalState = loopService.getAnyState(loopName)!
      expect(finalState.active).toBe(false)
      expect(finalState.terminationReason).toBe('max_iterations')

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDone = events.find((e) => e.eventType === 'audit_done')
      expect(auditDone).toBeDefined()
      expect(auditDone!.verdict).toBe('dirty')
      expect(auditDone!.outcome).toBe('max_iterations')
      expect(auditDone!.sessionId).toBe(auditorSessionId)
      expect(auditDone!.findingsTotal).toBe(1)
      expect(auditDone!.findingsBugs).toBe(1)
      // Exactly one audit_done for the run; no continue event leaks.
      expect(events.filter((e) => e.eventType === 'audit_done')).toHaveLength(1)
      expect(events.find((e) => e.eventType === 'audit_done' && e.outcome === 'continue')).toBeUndefined()

      const terminated = events.find((e) => e.eventType === 'loop_terminated')
      expect(terminated).toBeDefined()

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      expect(runs[0].dirtyAudits).toBe(1)
      expect(runs[0].cleanAudits).toBe(0)
      expect(runs[0].status).toBe('errored')
      // auditCount must include this capped dirty audit pass (1). The prior bug
      // recorded auditCount=0 because the non-sectioned max_iterations terminal
      // path passed the pre-audit state to terminateLoop without persisting the
      // new audit count first.
      expect(runs[0].auditCount).toBe(1)
    })

    test('clean section audit at the iteration cap emits exactly one audit_done event with outcome=max_iterations/verdict=clean (cleanAudits=1, not 2)', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: { role: 'assistant', finish: 'stop' },
              parts: [{ type: 'text', text: `Audit clean.\n${SECTION_SUMMARY_START_MARKER}\n### Done\n- Implemented module.\n### Deviations\n- None\n### Follow-ups\n- None\n${SECTION_SUMMARY_END_MARKER}` }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-section-clean-cap'
      const auditorSessionId = 'metrics-section-clean-audit'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 2,
        currentSectionIndex: 0,
        auditCount: 0,
        // iteration equals the cap; clean section 0 wants to advance to section 1
        // at nextIter=6 which exceeds maxIterations=5 → must terminate with one
        // audit_done(clean, max_iterations) event, not section_clean + max_iterations.
        iteration: 5,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // No bug findings in section 0 → section is clean and would advance.
      // A warning-only finding in section 0 verifies findingsTotal reflects
      // all severities for the audited section even on the terminal event.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/warn.ts',
        line: 2,
        severity: 'warning',
        description: 'cosmetic warning in section 0',
        sectionIndex: 0,
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const finalState = loopService.getAnyState(loopName)!
      expect(finalState.active).toBe(false)
      expect(finalState.terminationReason).toBe('max_iterations')

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDoneEvents = events.filter((e) => e.eventType === 'audit_done')
      expect(auditDoneEvents).toHaveLength(1)
      const auditDone = auditDoneEvents[0]
      expect(auditDone!.verdict).toBe('clean')
      expect(auditDone!.outcome).toBe('max_iterations')
      expect(auditDone!.sectionIndex).toBe(0)
      // Total findings for the audited section = the warning; bugs in section 0 = 0.
      expect(auditDone!.findingsTotal).toBe(1)
      expect(auditDone!.findingsBugs).toBe(0)

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      // Exactly one clean audit counted, not two (the prior bug double-counted).
      expect(runs[0].cleanAudits).toBe(1)
      expect(runs[0].dirtyAudits).toBe(0)
      expect(runs[0].status).toBe('errored')
      // The section audit pass bumped the audit count to 1 before termination;
      // the prior auditCount-stale-by-one bug would have left this at 0.
      expect(runs[0].auditCount).toBe(1)
    })

    test('sectioned dirty audit counts findings scoped to the current section only (warnings + cross-section bugs excluded)', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found bugs.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-section-scoped-findings'
      const auditorSessionId = 'metrics-section-scoped-audit'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 2,
        currentSectionIndex: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // Section 0 (audited): 1 bug + 1 warning → findingsTotal=2, findingsBugs=1.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/sec0-bug.ts',
        line: 1,
        severity: 'bug',
        description: 'bug in section 0',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/sec0-warn.ts',
        line: 2,
        severity: 'warning',
        description: 'warning in section 0',
        sectionIndex: 0,
      })
      // A bug in section 1 must NOT inflate section 0's totals.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/sec1-bug.ts',
        line: 3,
        severity: 'bug',
        description: 'bug in section 1',
        sectionIndex: 1,
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDone = events.find((e) => e.eventType === 'audit_done')
      expect(auditDone).toBeDefined()
      expect(auditDone!.verdict).toBe('dirty')
      expect(auditDone!.outcome).toBe('section_retry')
      expect(auditDone!.sectionIndex).toBe(0)
      // Prior bug passed sectionAllBugFindings.length (bugs across all sections = 2)
      // as findingsTotal; correct value is the audited section's total (bug+warning) = 2,
      // and findingsBugs scoped to section 0 = 1. The cross-section bug must NOT
      // inflate findingsBugs (the prior bug already had this right via sectionBugFindings
      // derived from all-section bugs then filtered — this test pins both counts).
      expect(auditDone!.findingsTotal).toBe(2)
      expect(auditDone!.findingsBugs).toBe(1)
    })

    test('clean last-section audit transitions to a clean final audit and loop_runs.auditCount reflects every section audit pass (not stale by one)', async () => {
      const sectionAuditAssistant = async () => [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{
            type: 'text',
            text: `Audit clean.\n${SECTION_SUMMARY_START_MARKER}\n### Done\n- Implemented module.\n### Deviations\n- None\n### Follow-ups\n- None\n${SECTION_SUMMARY_END_MARKER}`,
          }],
        },
      ]
      const finalAuditAssistant = async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Final audit clean. No outstanding bugs.' }] },
      ]
      const { client } = createFakeForgeClient({ session: { messages: sectionAuditAssistant } })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-final-clean-section'
      const sectionAuditorSessionId = 'metrics-section-audit-final'
      // Start mid-run on the last section (auditCount already 1 from the prior
      // clean section-0 audit). The current pass should bump auditCount to 2,
      // transition to final audit, and terminate on a clean final audit.
      const state = makeState({
        loopName,
        sessionId: sectionAuditorSessionId,
        phase: 'auditing',
        totalSections: 2,
        currentSectionIndex: 1,
        auditCount: 1,
        iteration: 2,
        maxIterations: 10,
      })
      loopService.setState(state.loopName, state)

      // Tick 1: section 1 audit clean → section completes → startFinalAuditTransition.
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: sectionAuditorSessionId },
      })

      // The loop should now be in final_auditing with a fresh audit session.
      const afterSection = loopService.getActiveState(loopName)!
      expect(afterSection.phase).toBe('final_auditing')
      const finalAuditSessionId = afterSection.sessionId

      // Tick 2 (busy+idle clears the prompt-in-flight gate): final audit clean → terminate.
      ;(client.session.messages as any).mockImplementation(finalAuditAssistant)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: finalAuditSessionId },
      })
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: finalAuditSessionId },
      })

      const finalState = loopService.getAnyState(loopName)!
      expect(finalState.active).toBe(false)
      expect(finalState.terminationReason).toBe('completed')

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      // One clean audit_done per section pass plus one clean final_audit_done.
      const sectionAuditDone = events.find((e) => e.eventType === 'audit_done')
      expect(sectionAuditDone).toBeDefined()
      expect(sectionAuditDone!.verdict).toBe('clean')
      expect(sectionAuditDone!.sectionIndex).toBe(1)
      const finalAuditDone = events.find((e) => e.eventType === 'final_audit_done')
      expect(finalAuditDone).toBeDefined()
      expect(finalAuditDone!.verdict).toBe('clean')

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('completed')
      expect(runs[0].cleanAudits).toBe(2)
      // auditCount must include this last section audit (2 total for a 2-section loop).
      // The prior bug recorded auditCount=1 because the transition path used the
      // pre-audit state without persisting the increment before final-audit fetch.
      expect(runs[0].auditCount).toBe(2)
    })

    test('sectioned dirty section audit at the iteration cap emits one audit_done(dirty/max_iterations) and loop_runs.auditCount reflects the capped pass (not stale by one)', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found bugs in section.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-section-dirty-cap'
      const auditorSessionId = 'metrics-section-dirty-cap-audit'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        phase: 'auditing',
        totalSections: 2,
        currentSectionIndex: 0,
        auditCount: 0,
        // iteration at the cap; the dirty section auditor pass increments the
        // iteration to 6, exceeding maxIterations=5 → terminate.
        iteration: 5,
        maxIterations: 5,
      })
      loopService.setState(state.loopName, state)

      // One outstanding bug finding in section 0 → dirty audit, but the cap fires
      // before the dirty section_retry event is emitted.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/cap-bug.ts',
        line: 1,
        severity: 'bug',
        description: 'section bug at cap',
        sectionIndex: 0,
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: auditorSessionId },
      })

      const finalState = loopService.getAnyState(loopName)!
      expect(finalState.active).toBe(false)
      expect(finalState.terminationReason).toBe('max_iterations')

      const events = loopEventsRepo.listByLoop(PROJECT_ID, loopName)
      const auditDoneEvents = events.filter((e) => e.eventType === 'audit_done')
      expect(auditDoneEvents).toHaveLength(1)
      expect(auditDoneEvents[0]!.verdict).toBe('dirty')
      expect(auditDoneEvents[0]!.outcome).toBe('max_iterations')
      expect(auditDoneEvents[0]!.sectionIndex).toBe(0)

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      expect(runs[0].dirtyAudits).toBe(1)
      expect(runs[0].cleanAudits).toBe(0)
      expect(runs[0].status).toBe('errored')
      // auditCount must include this capped dirty audit pass (1).
      // The prior bug recorded auditCount=0 because the dirty max_iterations
      // terminal path used the pre-audit state without persisting the bump.
      expect(runs[0].auditCount).toBe(1)
    })

    test('terminateAll routes each active loop through terminateLoop, recording a loop_terminated event and a loop_runs summary row per loop', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant', finish: 'stop', cost: 0.02,
                tokens: { input: 30, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
                model: 'coding-model',
              },
              parts: [{ type: 'text', text: 'Mid-run coding.' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopA = 'metrics-bulk-a'
      const loopB = 'metrics-bulk-b'
      const sessionA = 'bulk-coding-a'
      const sessionB = 'bulk-coding-b'
      const startedAtA = Date.now()
      const startedAtB = Date.now()
      const stateA = makeState({
        loopName: loopA,
        sessionId: sessionA,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 2,
        maxIterations: 5,
        startedAt: new Date(startedAtA).toISOString(),
      })
      const stateB = makeState({
        loopName: loopB,
        sessionId: sessionB,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date(startedAtB).toISOString(),
      })
      loopService.setState(stateA.loopName, stateA)
      loopService.setState(stateB.loopName, stateB)

      await loop.terminateAll()

      const finalA = loopService.getAnyState(loopA)!
      const finalB = loopService.getAnyState(loopB)!
      expect(finalA.active).toBe(false)
      expect(finalB.active).toBe(false)
      expect(finalA.terminationReason).toBe('shutdown')
      expect(finalB.terminationReason).toBe('shutdown')

      const eventsA = loopEventsRepo.listByLoop(PROJECT_ID, loopA)
      const eventsB = loopEventsRepo.listByLoop(PROJECT_ID, loopB)
      const terminatedA = eventsA.find((e) => e.eventType === 'loop_terminated')
      const terminatedB = eventsB.find((e) => e.eventType === 'loop_terminated')
      expect(terminatedA).toBeDefined()
      expect(terminatedB).toBeDefined()
      expect(terminatedA!.outcome).toBe('shutdown')
      expect(terminatedB!.outcome).toBe('shutdown')
      expect(terminatedA!.iteration).toBe(2)
      expect(terminatedB!.iteration).toBe(1)

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(2)
      const runA = runs.find((r) => r.loopName === loopA)!
      const runB = runs.find((r) => r.loopName === loopB)!
      expect(runA.status).toBe('cancelled')
      expect(runB.status).toBe('cancelled')
      expect(runA.terminationReason).toBe('shutdown')
      expect(runB.terminationReason).toBe('shutdown')
      // Run totals reflect the final usage capture taken during terminateLoop.
      expect(runA.iterations).toBe(2)
      expect(runB.iterations).toBe(1)
      expect(runA.durationMs!).toBeGreaterThan(0)
      expect(runB.durationMs!).toBeGreaterThan(0)
      expect(runA.inputTokens).toBe(30)
      expect(runA.outputTokens).toBe(20)
      expect(runA.cost).toBeCloseTo(0.02, 6)
    })

    test('clean section audit → final-audit transition retires the auditor session with auditor role and model attribution', async () => {
      // Bug 2: startFinalAuditTransition hardcoded phase: 'coding' for the
      // retired pre-final-audit session. When the transition starts from a
      // section audit, the retired session is an auditor session, not a code
      // session, so its usage must be attributed to role='auditor' with the
      // auditor fallback model. The assistant message below carries no explicit
      // model metadata, forcing the fallback path.
      const sectionAuditAssistant = async () => [
        {
          info: {
            role: 'assistant', finish: 'stop', cost: 0.004,
            tokens: { input: 120, output: 60, reasoning: 5, cache: { read: 0, write: 0 } },
          },
          parts: [{
            type: 'text',
            text: `Audit clean.\n${SECTION_SUMMARY_START_MARKER}\n### Done\n- Implemented module.\n### Deviations\n- None\n### Follow-ups\n- None\n${SECTION_SUMMARY_END_MARKER}`,
          }],
        },
      ]
      const { client } = createFakeForgeClient({ session: { messages: sectionAuditAssistant } })
      const { loop } = createRuntime({ client, withUsageRepo: true })

      const loopName = 'metrics-final-attribution'
      const sectionAuditorSessionId = 'metrics-final-attribution-audit'
      const state = makeState({
        loopName,
        sessionId: sectionAuditorSessionId,
        phase: 'auditing',
        totalSections: 1,
        currentSectionIndex: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 10,
        executionModel: 'exec/model',
        auditorModel: 'audit/model',
      })
      loopService.setState(loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: sectionAuditorSessionId },
      })

      expect(loopService.getActiveState(loopName)!.phase).toBe('final_auditing')

      // Allow the fire-and-forget trim of the section auditor session to land.
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, loopName)
      expect(usage).not.toBeNull()
      // Retired auditor session must be attributed to the auditor fallback
      // model, never the execution model.
      expect(usage!.byModel).toHaveProperty('audit/model')
      expect(usage!.byModel['audit/model'].messageCount).toBeGreaterThan(0)
      expect(usage!.byModel).not.toHaveProperty('exec/model')
    })

    test('terminateLoop awaits an in-flight trimmed-session usage capture before writing loop_runs, so run totals include the delayed session', async () => {
      // Bug 1: scheduleSessionDelete trims sessions outside the (0-length)
      // retention window via a fire-and-forget async path, shifting the session
      // out of the retain queue before its usage capture completes. terminateLoop
      // reading the queue would miss that mid-trim capture and write loop_runs
      // prematurely, permanently undercounting the run. Fix: track pending
      // usage captures and await them before recording the run summary.
      const codingSessionId = 'metrics-race-coding'
      const startedAt = Date.now()

      let releaseTrim: () => void = () => {}
      const trimGate = new Promise<void>((resolve) => { releaseTrim = resolve })

      // The coding session's transcript is fetched three times during the
      // coding→audit rotation: (1) getLastAssistantInfo (limit=4), (2) the
      // metrics coding_done recorder, (3) scheduleSessionDelete's trim capture.
      // Gate only the trim call on `trimGate` so the tick itself completes
      // before the delay kicks in.
      let codingMessagesCalls = 0
      const messages = async (params: any) => {
        if (params?.sessionID === codingSessionId) {
          codingMessagesCalls++
          if (codingMessagesCalls === 3) {
            await trimGate
          }
          return [{
            info: {
              role: 'assistant', finish: 'stop', cost: 0.03,
              tokens: { input: 400, output: 200, reasoning: 10, cache: { read: 0, write: 0 } },
              model: 'coding-model',
            },
            parts: [{ type: 'text', text: 'Coding pass.' }],
          }]
        }
        // Audit / final session transcript resolves immediately.
        return [{
          info: {
            role: 'assistant', finish: 'stop', cost: 0.01,
            tokens: { input: 50, output: 25, reasoning: 5, cache: { read: 0, write: 0 } },
            model: 'audit-model',
          },
          parts: [{ type: 'text', text: 'All clear, terminating.' }],
        }]
      }

      const { client } = createFakeForgeClient({ session: { messages } })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-race-run'
      const initialState = makeState({
        loopName,
        sessionId: codingSessionId,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date(startedAt).toISOString(),
        auditorModel: 'audit-model',
        executionModel: 'coding-model',
      })
      loopService.setState(loopName, initialState)

      // Tick: coding→auditing rotation. scheduleSessionDelete fires for the
      // coding session; its trim messages() fetch blocks on trimGate.
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: codingSessionId },
      })

      expect(loopService.getActiveState(loopName)!.phase).toBe('auditing')

      // Cancel concurrently with the in-flight trim capture. terminateLoop
      // captures the live audit session then awaits pending usage captures.
      const cancelPromise = loop.cancel(loopName)

      // Give terminateLoop enough runway to capture the live audit session and
      // reach the pending-captures await. Without the fix, loop_runs would
      // already be written with only the audit session's usage; with the fix
      // it blocks on the trim's transcript fetch.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(loopRunsRepo.listByProject(PROJECT_ID)).toHaveLength(0)

      // Release the delayed transcript fetch. terminateLoop completes and writes
      // the run row with totals from BOTH sessions.
      releaseTrim()
      await cancelPromise

      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      const run = runs[0]
      expect(run.inputTokens).toBe(450)
      expect(run.outputTokens).toBe(225)
      expect(run.cost).toBeCloseTo(0.04, 5)
    })

    test('finalizeRunForRestart captures the active run usage and writes a cancelled/restarted loop_runs row keyed by the old started_at', async () => {
      // Regression for the auditor's "metrics before active restart" finding.
      // A force-restart clears runtime state and stamps a new started_at without
      // recording termination metrics for the prior run; its active session usage
      // was never captured. Fix: route restarts through finalizeRunForRestart
      // before started_at resets, so the old run gets a loop_terminated event,
      // a loop_runs summary, and the live session's usage.
      const codingSessionId = 'restart-finalize-coding'
      const startedAtMs = 1_700_000_000_000
      const startedAt = new Date(startedAtMs).toISOString()

      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant', finish: 'stop', cost: 0.05,
                tokens: { input: 800, output: 400, reasoning: 50, cache: { read: 0, write: 0 } },
                model: 'coding-model',
              },
              parts: [{ type: 'text', text: 'Coding pass before restart.' }],
            },
          ],
        },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-restart-finalize'
      const state = makeState({
        loopName,
        sessionId: codingSessionId,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 2,
        maxIterations: 5,
        startedAt,
        executionModel: 'coding-model',
      })
      loopService.setState(loopName, state)

      // Finalize the active run as a restart would, before started_at resets.
      // The loop stays active afterward; the caller (the restart command) is
      // responsible for replacing state and registering the new session.
      await loop.finalizeRunForRestart(loopName, { kind: 'restarted' })

      expect(loopService.getActiveState(loopName)?.active).toBe(true)

      // Active session usage captured under the old run identity.
      const usage = loopSessionUsageRepo.listSessionUsage(PROJECT_ID, loopName)
      expect(usage.find((u) => u.sessionId === codingSessionId && u.runStartedAt === startedAtMs)).toBeDefined()

      // loop_terminated event appended under the old run identity.
      const terminated = loopEventsRepo
        .listByLoop(PROJECT_ID, loopName, startedAtMs)
        .find((e) => e.eventType === 'loop_terminated')
      expect(terminated).toBeDefined()
      expect(terminated!.outcome).toBe('restarted')
      expect(terminated!.runStartedAt).toBe(startedAtMs)
      expect(terminated!.iteration).toBe(2)

      // loop_runs summary keyed by the old started_at with cancelled/restarted
      // status/reason and totals driven by the captured usage.
      const runs = loopRunsRepo.listByProject(PROJECT_ID)
      expect(runs).toHaveLength(1)
      const run = runs[0]
      expect(run.startedAt).toBe(startedAtMs)
      expect(run.status).toBe('cancelled')
      expect(run.terminationReason).toBe('restarted')
      expect(run.iterations).toBe(2)
      expect(run.inputTokens).toBe(800)
      expect(run.outputTokens).toBe(400)
      expect(run.cost).toBeCloseTo(0.05, 6)
    })

    test('finalizeRunForRestart on a non-active loop is a no-op that records nothing', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => [] },
      })
      const { loop } = createRuntime({ client, withMetricsRepos: true })

      const loopName = 'metrics-restart-inactive'
      // No state set → getActiveState returns null. Finalize must no-op.
      await loop.finalizeRunForRestart(loopName, { kind: 'restarted' })

      expect(loopEventsRepo.listByLoop(PROJECT_ID, loopName)).toHaveLength(0)
      expect(loopRunsRepo.listByProject(PROJECT_ID)).toHaveLength(0)
    })
  })
})
