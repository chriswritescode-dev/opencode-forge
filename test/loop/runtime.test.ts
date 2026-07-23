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
    getParentSessionId?: (sessionId: string) => Promise<string | null>
  } = {}): { loop: Loop; calls: RecordedCall[]; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const forge = overrides.client ? { client: overrides.client, calls: [] as RecordedCall[] } : createFakeForgeClient()
    const { logger, logs } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig, ...(overrides.loopConfig ?? {}) }

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
      loopSessionUsageRepo: overrides.withUsageRepo ? loopSessionUsageRepo : undefined,
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

    test('dirty goal audit that fails to rotate the code session persists the completed audit before terminating with session_creation_failed', async () => {
      // The auditor reports a bug, so the audit is dirty and the runtime
      // attempts a fresh code-session rotation. session.create is made to
      // throw -> rotateSession rejects -> the catch path must persist the
      // completed audit (count + result) BEFORE terminating, otherwise the
      // terminal row would carry stale pre-audit auditCount/lastAuditResult.
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Goal endpoint missing error handling.' }] },
          ],
          create: async () => {
            throw new Error('Failed to create new session.')
          },
        },
      })
      const { loop, logs } = createRuntime({ client })

      const goalText = 'Add a /health endpoint with tests and error handling.'
      const auditorSessionId = 'goal-auditor-rotation-fail'
      const loopName = 'test-goal-rotation-fail'
      const state = makeState({
        loopName,
        sessionId: auditorSessionId,
        hostSessionId: 'goal-host-rotation-fail',
        executorSessionId: 'goal-executor-rotation-fail',
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

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('session_creation_failed')

      // The completed audit must survive the rotation failure: auditCount
      // reflects the audit that finished, and lastAuditResult carries the
      // auditor's text — not the stale pre-audit values (auditCount=0 / empty).
      expect(afterState!.auditCount).toBe(1)
      expect(afterState!.lastAuditResult).toContain('error handling')

      // The rotation-failure termination was logged exactly once.
      expect(logs.filter((l) => l.level === 'error' && l.message.includes('session rotation failed during goal dirty audit')).length).toBe(1)

      // Exactly one session.create attempt was made (the failed rotation);
      // the auditor session was never replaced.
      const createCalls = calls.filter((c) => c.method === 'session.create')
      expect(createCalls.length).toBe(1)
      const codePrompts = calls.filter((c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(0)
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

    test('goal loop with worktree:false cycles coding→auditing→coding→completed without workspace operations', async () => {
      const projectDir = '/tmp/test-no-worktree-project'
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Goal work done.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client })

      const goalText = 'Add a /health endpoint returning {"status":"ok"} with a test.'
      const loopName = 'test-goal-no-worktree-cycle'
      const state = makeState({
        loopName,
        sessionId: 'no-wt-exec',
        worktreeDir: projectDir,
        projectDir,
        worktreeBranch: undefined,
        worktree: false,
        workspaceId: undefined,
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        kind: 'goal',
        goal: goalText,
        executorSessionId: 'no-wt-exec',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      let current = loopService.getActiveState(state.loopName)
      expect(current).not.toBeNull()
      expect(current!.phase).toBe('auditing')
      const firstAuditorSessionId = current!.sessionId
      expect(current!.executorSessionId).toBeUndefined()

      const persistedAuditingRow = loopsRepo.get(PROJECT_ID, loopName)
      expect(persistedAuditingRow?.executorSessionId ?? null).toBeNull()

      const firstAuditPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop' && (c.params as any)?.sessionID === firstAuditorSessionId,
      )
      expect(firstAuditPrompts.length).toBeGreaterThan(0)
      expect((firstAuditPrompts[0].params as any).workspace).toBeUndefined()

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/health.ts',
        line: 12,
        severity: 'bug',
        description: 'Missing error handling in /health endpoint',
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: firstAuditorSessionId },
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: firstAuditorSessionId },
      })

      current = loopService.getActiveState(state.loopName)
      expect(current).not.toBeNull()
      expect(current!.phase).toBe('coding')
      expect(current!.iteration).toBe(2)
      expect(current!.auditCount).toBe(1)
      const rotatedCodeSessionId = current!.sessionId
      expect(rotatedCodeSessionId).not.toBe(firstAuditorSessionId)
      expect(current!.executorSessionId).toBe(rotatedCodeSessionId)

      const continuationPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code' && (c.params as any)?.sessionID === rotatedCodeSessionId,
      )
      expect(continuationPrompts.length).toBeGreaterThan(0)
      const continuationText = (continuationPrompts[continuationPrompts.length - 1].params as any).parts?.[0]?.text ?? ''
      expect(continuationText).toContain('Goal')
      expect(continuationText).toContain(goalText)
      expect((continuationPrompts[continuationPrompts.length - 1].params as any).workspace).toBeUndefined()

      reviewFindingsRepo.deleteByLoopName(PROJECT_ID, loopName)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: rotatedCodeSessionId },
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: rotatedCodeSessionId },
      })

      current = loopService.getActiveState(state.loopName)
      expect(current).not.toBeNull()
      expect(current!.phase).toBe('auditing')
      const secondAuditorSessionId = current!.sessionId
      expect(secondAuditorSessionId).not.toBe(rotatedCodeSessionId)

      const secondAuditPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop' && (c.params as any)?.sessionID === secondAuditorSessionId,
      )
      expect(secondAuditPrompts.length).toBeGreaterThan(0)
      expect((secondAuditPrompts[0].params as any).workspace).toBeUndefined()

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'busy' }, sessionID: secondAuditorSessionId },
      })

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: secondAuditorSessionId },
      })

      const finalState = loopService.getAnyState(state.loopName)
      expect(finalState).not.toBeNull()
      expect(finalState!.active).toBe(false)
      expect(finalState!.terminationReason).toBe('completed')
      expect(finalState!.worktree).toBe(false)
      expect(finalState!.workspaceId).toBeUndefined()
      expect(finalState!.executorSessionId).toBeUndefined()

      const persistedFinalRow = loopsRepo.get(PROJECT_ID, loopName)
      expect(persistedFinalRow?.executorSessionId ?? null).toBeNull()

      const workspaceCreateCalls = calls.filter((c) => c.method === 'workspace.create')
      const workspaceWarpCalls = calls.filter((c) => c.method === 'workspace.warp')
      expect(workspaceCreateCalls.length).toBe(0)
      expect(workspaceWarpCalls.length).toBe(0)

      const allPrompts = calls.filter((c) => c.method === 'session.promptAsync')
      expect(allPrompts.length).toBeGreaterThan(0)
      for (const c of allPrompts) {
        expect((c.params as any).workspace).toBeUndefined()
      }
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

    test('model fallback retains variant when model is undefined', async () => {
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
      // Variants are spread independently of model: even the fallback attempt
      // (which uses the default/session model) must retain the configured variant.
      const fallbackPrompts = codePrompts.filter(c => !(c.params as any)?.model)
      expect(fallbackPrompts.length).toBeGreaterThan(0)
      for (const call of fallbackPrompts) {
        expect((call.params as any)?.variant).toBe('thinking-max')
      }
    })

    test('variant-only coding rotation retains variant with no explicit model', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, loopConfig: { executionModel: undefined } })

      const state = makeState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionModel: undefined,
        executionVariant: 'thinking-max',
      })
      loopService.setState(state.loopName, state)

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
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      for (const call of codePrompts) {
        expect((call.params as any)?.variant).toBe('thinking-max')
        expect((call.params as any)?.model).toBeUndefined()
      }
    })

    test('variant-only auditor rotation retains variant with no explicit model', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = createRuntime({ client, loopConfig: { executionModel: undefined } })

      const state = makeState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        executionModel: undefined,
        auditorModel: undefined,
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect((call.params as any)?.variant).toBe('audit-high')
        expect((call.params as any)?.model).toBeUndefined()
      }
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

      // After the first tick, the loop should have transitioned to final_audit_fix with a fix prompt.
      const fixCodePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(fixCodePrompts.length).toBeGreaterThan(0)
      const fixPromptText = (fixCodePrompts[fixCodePrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(fixPromptText).toContain('[Final-audit fix')

      // Verify the loop state after first tick
      const stateAfterFirstTick = loopService.getActiveState(loopName)
      expect(stateAfterFirstTick).not.toBeNull()
      expect(stateAfterFirstTick!.phase).toBe('final_audit_fix')
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
})
