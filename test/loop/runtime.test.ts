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
})
