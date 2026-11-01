import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopAttemptsRepo } from '../../src/storage/repos/loop-attempts-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import type { LoopAttemptsRepo } from '../../src/storage/repos/loop-attempts-repo'
import type { LoopService } from '../../src/loop/service'
const Database = require('better-sqlite3')
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
type Database = ReturnType<typeof Database>

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

/**
 * Minimal non-reentrant mutex emulating the runtime's per-loop state lock
 * (`withStateLock`). Used by the provider-limit deadlock regression test to
 * prove that `deps.loop.terminate` is no longer invoked while `runExclusive`
 * still holds the lock.
 */
function createNonReentrantMutex() {
  let locked = false
  const waiters: Array<() => void> = []
  return {
    acquire: (): Promise<void> => {
      if (!locked) {
        locked = true
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    release: (): void => {
      const next = waiters.shift()
      if (next) {
        next()
      } else {
        locked = false
      }
    },
    isLocked: (): boolean => locked,
  }
}

describe('handleLoopRestart from stall_timeout', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopTransitionsRepo: LoopTransitionsRepo
  let loopAttemptsRepo: LoopAttemptsRepo
  let loopService: LoopService

  const mockPendingTeardowns = {
    register: () => {},
    unregister: () => {},
    get: () => undefined,
  }

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-restart-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    loopAttemptsRepo = createLoopAttemptsRepo(db)
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
      loopTransitionsRepo,
      undefined,
      undefined,
      loopAttemptsRepo,
    )
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  function insertLoop(overrides: Partial<{
    loopName: string
    phase: string
    currentSectionIndex: number
    totalSections: number
    iteration: number
    status: string
    terminationReason: string | null
    active: boolean
    worktree: boolean
    workspaceId: string | null
    worktreeBranch: string | null
    auditorModel: string | null
    auditorVariant: string | null
    executionModel: string | null
    executionVariant: string | null
    startedAt: number
    baseCommit: string | null
    standbySessionId: string | null
  }> = {}) {
    const defaults = {
      loopName: 'test-loop',
      phase: 'coding',
      currentSectionIndex: 0,
      totalSections: 0,
      iteration: 1,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      active: false,
      worktree: false,
      workspaceId: null as string | null,
      worktreeBranch: null as string | null,
      auditorModel: null as string | null,
      auditorVariant: null as string | null,
      executionModel: null as string | null,
      executionVariant: null as string | null,
      startedAt: Date.now(),
      baseCommit: null as string | null,
      standbySessionId: null as string | null,
    }
    const opts = { ...defaults, ...overrides }
    loopsRepo.insert({
      projectId: PROJECT_ID,
      loopName: opts.loopName,
      status: opts.status as any,
      currentSessionId: 'session-old',
      worktree: opts.worktree,
      worktreeDir: '/tmp',
      worktreeBranch: opts.worktreeBranch,
      projectDir: '/tmp',
      maxIterations: 10,
      iteration: opts.iteration,
      auditCount: 0,
      errorCount: 0,
      phase: opts.phase as any,
      executionModel: opts.executionModel,
      auditorModel: opts.auditorModel,
      executionVariant: opts.executionVariant,
      auditorVariant: opts.auditorVariant,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: opts.startedAt,
      completedAt: null,
      terminationReason: opts.terminationReason,
      completionSummary: null,
      workspaceId: opts.workspaceId,
      hostSessionId: null,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      baseCommit: opts.baseCommit,
      standbySessionId: opts.standbySessionId,
    }, { lastAuditResult: null })
  }

  test('restart from stall_timeout resumes at persisted section/iteration with coding phase', async () => {
    insertLoop({
      loopName: 'stall-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 2,
      iteration: 4,
      totalSections: 5,
      phase: 'coding',
    })

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'stall-loop',
      sections: [
        { index: 0, title: 'Setup', content: 'Install deps' },
        { index: 1, title: 'Build', content: 'Compile' },
        { index: 2, title: 'Test', content: 'Run tests' },
        { index: 3, title: 'Deploy', content: 'Ship it' },
        { index: 4, title: 'Cleanup', content: 'Tidy up' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, 'stall-loop', 0, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, 'stall-loop', 1, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, 'stall-loop', 2, 'in_progress')

    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'stall-loop',
      file: 'src/warn.ts',
      line: 6,
      severity: 'warning',
      description: 'Warning on the current section must not trigger the continuation prompt',
      sectionIndex: 2,
    })

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-123' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'stall-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.iteration).toBe(1)
    expect(result.data.loopName).toBe('stall-loop')
    expect(result.data.sessionId).toBe('new-session-123')
    expect(result.data.previousSessionId).toBe('session-old')

    const newState = loopService.getActiveState('stall-loop')!
    expect(newState).not.toBeNull()
    expect(newState.phase).toBe('coding')
    expect(newState.currentSectionIndex).toBe(2)
    expect(newState.iteration).toBe(1)
    expect(newState.totalSections).toBe(5)

    expect(buildSectionInitialPromptSpy).toHaveBeenCalledTimes(1)

    const retained = reviewFindingsRepo.listByLoopName(PROJECT_ID, 'stall-loop')
    expect(retained).toHaveLength(1)
  })

  test('restart captures usage for and deletes the standby session before starting fresh', async () => {
    insertLoop({
      loopName: 'standby-restart-loop',
      phase: 'auditing',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      standbySessionId: 'session-standby',
    })

    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const noopFn = () => {}

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client, calls } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-standby' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async (params: any) => params.sessionID === 'session-standby'
          ? [{
              info: {
                role: 'assistant',
                finish: 'stop',
                cost: 0.001,
                tokens: { input: 120, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [{ type: 'text', text: 'Earlier coding turn.' }],
            }]
          : [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
        service: mockLoopService,
        listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
        listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
        setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
      loopSessionUsageRepo,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'standby-restart-loop' },
      },
    )

    expect(result.ok).toBe(true)

    const usage = loopSessionUsageRepo.listSessionUsage(PROJECT_ID, 'standby-restart-loop')
      .find((row) => row.sessionId === 'session-standby')
    expect(usage?.role).toBe('code')
    expect(usage?.inputTokens).toBe(120)
    expect(
      calls.some((call) => call.method === 'session.delete' && (call.params as any).sessionID === 'session-standby'),
    ).toBe(true)
    expect(loopsRepo.get(PROJECT_ID, 'standby-restart-loop')!.standbySessionId).toBeNull()
  })

  test('restart clears a pending handoff', async () => {
    insertLoop({
      loopName: 'handoff-restart-loop',
      phase: 'coding',
      status: 'stalled',
      terminationReason: 'stall_timeout',
    })

    const pending = loopsRepo.upsertPendingHandoff({
      projectId: PROJECT_ID,
      loopName: 'handoff-restart-loop',
      sessionId: 'session-old',
      role: 'coder',
      phase: 'coding',
      sectionIndex: 0,
      iteration: 1,
      payload: {
        changes: [{ summary: 'Old change', reason: 'Old reason' }],
        deviations: [],
        verification: [{ command: 'pnpm test', cwd: '.', outcome: 'pass', changedAfter: false }],
      },
    })

    const noopFn = () => {}

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-handoff' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
        service: mockLoopService,
        listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
        listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
        setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'handoff-restart-loop' },
      },
    )

    expect(result.ok).toBe(true)
    expect(loopsRepo.getPendingHandoff(PROJECT_ID, 'handoff-restart-loop')).toBeNull()
    const history = loopsRepo.listHandoffs(PROJECT_ID, 'handoff-restart-loop')
    expect(history).toHaveLength(1)
    expect(history[0].id).toBe(pending.record.id)
    expect(history[0].status).toBe('discarded')
    expect((client.session.promptAsync as any).mock.calls).toHaveLength(1)
  })

  test('restart of a non-sectioned loop sends the plan with the coder handoff instruction exactly once', async () => {
    insertLoop({
      loopName: 'plan-restart-loop',
      phase: 'coding',
      status: 'stalled',
      terminationReason: 'stall_timeout',
    })

    const planText = '# Plan Restart\n\nImplement the change.'
    plansRepo.writeForLoop(PROJECT_ID, 'plan-restart-loop', planText)

    const noopFn = () => {}

    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'plan-restart-session' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      plansRepo,
      loopsRepo,
      loop: {
        service: mockLoopService,
        listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
        listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
        setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'plan-restart-loop' },
      },
    )

    expect(result.ok).toBe(true)
    expect((client.session.promptAsync as any).mock.calls).toHaveLength(1)
    const promptText = (client.session.promptAsync as any).mock.calls[0][0].parts[0].text as string
    expect(promptText.startsWith(planText)).toBe(true)
    expect(promptText.match(/## Required: coder handoff/g)).toHaveLength(1)
  })

  test('restart with persisted current-section bug findings uses continuation prompt with remediation policy and full finding detail', async () => {
    insertLoop({
      loopName: 'bug-restart-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 1,
      iteration: 5,
      totalSections: 3,
      phase: 'coding',
    })

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      sections: [
        { index: 0, title: 'A', content: 'content A' },
        { index: 1, title: 'B', content: 'content B' },
        { index: 2, title: 'C', content: 'content C' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, 'bug-restart-loop', 0, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, 'bug-restart-loop', 1, 'in_progress')

    const currentSectionDescription = 'Current section bug: the restart must inline this full description verbatim'
    const currentSectionScenario = 'Scenario: restart with persisted current-section findings uses the continuation prompt'
    const earlierSectionDescription = 'Earlier section bug the restart prompt must include'
    const laterSectionDescription = 'Later section bug that must not leak into the restart prompt'
    const warningDescription = 'Current section warning that must not leak into the restart prompt'
    const crossSectionDescription = 'Cross-section bug the restart prompt must include'

    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      file: 'src/current.ts',
      line: 10,
      severity: 'bug',
      description: currentSectionDescription,
      scenario: currentSectionScenario,
      sectionIndex: 1,
    })
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      file: 'src/earlier.ts',
      line: 15,
      severity: 'bug',
      description: earlierSectionDescription,
      sectionIndex: 0,
    })
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      file: 'src/later.ts',
      line: 25,
      severity: 'bug',
      description: laterSectionDescription,
      sectionIndex: 2,
    })
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      file: 'src/warn.ts',
      line: 30,
      severity: 'warning',
      description: warningDescription,
      sectionIndex: 1,
    })
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'bug-restart-loop',
      file: 'src/cross.ts',
      line: 40,
      severity: 'bug',
      description: crossSectionDescription,
    })

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildSectionContinuationPrompt: (state, notice, bugs) => loopService.buildSectionContinuationPrompt(state, notice, bugs),
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-bug-restart' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'bug-restart-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.iteration).toBe(1)

    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    const promptText = promptCall.parts[0].text as string

    expect(promptText).toContain(currentSectionDescription)
    expect(promptText).toContain(currentSectionScenario)
    expect(promptText).toContain('Remediation policy')
    expect(promptText).toContain('[Loop section 2/3 -- iteration 1/10 (continuation)]')

    expect(promptText).toContain(earlierSectionDescription)
    expect(promptText).toContain(crossSectionDescription)
    expect(promptText).not.toContain(laterSectionDescription)
    expect(promptText).not.toContain(warningDescription)

    expect(buildSectionInitialPromptSpy).not.toHaveBeenCalled()

    const retained = reviewFindingsRepo.listByLoopName(PROJECT_ID, 'bug-restart-loop')
    expect(retained).toHaveLength(5)
  })

  test('restart from stall_timeout resets iteration budget to 1', async () => {
    insertLoop({
      loopName: 'iter-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 1,
      iteration: 7,
      totalSections: 3,
      phase: 'coding',
    })

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'iter-loop',
      sections: [
        { index: 0, title: 'A', content: 'content A' },
        { index: 1, title: 'B', content: 'content B' },
        { index: 2, title: 'C', content: 'content C' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, 'iter-loop', 0, 'completed')
    sectionPlansRepo.setStatus(PROJECT_ID, 'iter-loop', 1, 'in_progress')

    const noopFn = () => {}

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      terminate: (name, opts) => loopService.terminate(name, opts),
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-456' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'iter-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.iteration).toBe(1)

    const newState = loopService.getActiveState('iter-loop')!
    expect(newState.iteration).toBe(1)
    expect(newState.currentSectionIndex).toBe(1)
    expect(newState.phase).toBe('coding')
  })

  test('restart creates fresh workspace for preserved worktree', async () => {
    insertLoop({
      loopName: 'worktree-loop',
      status: 'errored',
      terminationReason: 'max_iterations',
      iteration: 10,
      worktree: true,
      workspaceId: 'ws_old',
    })

    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-worktree' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp', branch: 'forge/worktree-loop' }),
        list: async () => [],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: 'worktree-loop' } },
    )

    expect(result.ok).toBe(true)
    expect(client.workspace.create).toHaveBeenCalledWith({
      type: 'forge',
      branch: null,
      extra: {
        loopName: 'worktree-loop',
        projectDirectory: '/tmp',
        workspaceCreatedAt: expect.any(Number),
      },
    })
    const newState = loopService.getActiveState('worktree-loop')!
    expect(newState.workspaceId).toBe('ws_new')
    expect(newState.iteration).toBe(1)
  })

  test('restart re-creates the workspace on the persisted custom branch without a baseRef', async () => {
    insertLoop({
      loopName: 'custom-branch-loop',
      status: 'errored',
      terminationReason: 'max_iterations',
      iteration: 2,
      worktree: true,
      workspaceId: 'ws_old',
      worktreeBranch: 'feature/custom',
    })

    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-custom-branch' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp', branch: 'feature/custom' }),
        list: async () => [],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: 'custom-branch-loop' } },
    )

    expect(result.ok).toBe(true)
    const createArgs = (client.workspace.create as any).mock.calls[0][0]
    expect(createArgs.extra.branch).toBe('feature/custom')
    expect(createArgs.extra).not.toHaveProperty('baseRef')
    expect(loopService.getActiveState('custom-branch-loop')!.worktreeBranch).toBe('feature/custom')
  })

  test('restart preserves the stored baseCommit unchanged', async () => {
    const baseCommit = 'f'.repeat(40)
    insertLoop({
      loopName: 'based-loop',
      status: 'errored',
      terminationReason: 'max_iterations',
      iteration: 3,
      worktree: true,
      workspaceId: 'ws_old',
      baseCommit,
    })

    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-based' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp', branch: 'forge/based-loop' }),
        list: async () => [
          {
            id: 'ws_old',
            type: 'forge',
            name: 'based-loop',
            branch: null,
            directory: '/tmp',
            projectID: PROJECT_ID,
            extra: { baseRef: 'stale-ref-from-start' },
          },
        ],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: 'based-loop' } },
    )

    expect(result.ok).toBe(true)
    expect(loopsRepo.get(PROJECT_ID, 'based-loop')!.baseCommit).toBe(baseCommit)
    expect(loopService.getActiveState('based-loop')!.baseCommit).toBe(baseCommit)
    // The restart reuses the branch; a stale baseRef from the original create
    // must not be replayed (it would make the adapter refuse to reuse the branch).
    const createArgs = (client.workspace.create as any).mock.calls[0][0]
    expect(createArgs.extra).not.toHaveProperty('baseRef')
  })

  test('restart keeps portable permission rules from the previous workspace (no permission widening)', async () => {
    const portableRule = { permission: 'webfetch', pattern: '*', action: 'deny' as const }
    insertLoop({
      loopName: 'portable-loop',
      status: 'errored',
      terminationReason: 'max_iterations',
      iteration: 10,
      worktree: true,
      workspaceId: 'ws_old',
    })

    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-portable' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp', branch: 'forge/portable-loop' }),
        list: async () => [
          {
            id: 'ws_old',
            type: 'forge',
            name: 'portable-loop',
            branch: null,
            directory: '/tmp',
            projectID: PROJECT_ID,
            extra: {
              permissionRules: [portableRule],
              startRef: 'abc123',
              syncRef: 'refs/forge/portable-loop',
              gitRemote: 'origin',
            },
          },
        ],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      // Remote-like config: no loop.permissions on the server, rules come only from the workspace.
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: 'portable-loop' } },
    )

    expect(result.ok).toBe(true)

    const sessionCreateArgs = (client.session.create as any).mock.calls[0][0]
    expect(sessionCreateArgs.permission).toContainEqual(portableRule)

    expect(client.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: {
          permissionRules: [portableRule],
          startRef: 'abc123',
          syncRef: 'refs/forge/portable-loop',
          gitRemote: 'origin',
          loopName: 'portable-loop',
          projectDirectory: '/tmp',
          workspaceCreatedAt: expect.any(Number),
        },
      }),
    )
  })

  test('restart from stall_timeout re-enters post_action when persisted phase is post_action and postAction is configured', async () => {
    insertLoop({
      loopName: 'post-action-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 0,
      iteration: 3,
      totalSections: 0,
      phase: 'post_action',
      auditorVariant: 'audit-high',
      executionVariant: 'thinking-max',
    })

    const noopFn = () => {}
    const buildPostActionPromptSpy = vi.fn()
    const buildSectionInitialPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildPostActionPrompt: buildPostActionPromptSpy,
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-pa-001' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true, postAction: { enabled: true, skill: 'pr-review' } },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'post-action-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const newState = loopService.getActiveState('post-action-loop')!
    expect(newState.phase).toBe('post_action')
    expect(newState.iteration).toBe(1)

    expect(buildPostActionPromptSpy).toHaveBeenCalledTimes(1)
    expect(buildPostActionPromptSpy).toHaveBeenCalledWith(expect.any(Object), { skill: 'pr-review', prompt: undefined })
    expect(buildSectionInitialPromptSpy).not.toHaveBeenCalled()

    // No configured post-action model → the auditor model is used, sent with the
    // auditor's variant (not the persisted execution variant).
    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.model).toEqual({ providerID: 'prov', modelID: 'aud' })
    expect(promptCall.variant).toBe('audit-high')
  })

  test('restart commits new current_session_id BEFORE runExclusive releases (no stale-event race)', async () => {
    insertLoop({
      loopName: 'race-loop',
      phase: 'auditing',
      totalSections: 0,
      iteration: 1,
      status: 'stalled',
      terminationReason: 'stall_timeout',
    })

    const noopFn = () => {}

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'race-new-session' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    let capturedResolvedNew: string | null | undefined
    let capturedResolvedOld: string | null | undefined
    let capturedPhase: string | null | undefined

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => {
        const result = await fn()
        // Capture loop service state at the exact moment the lock release completes,
        // BEFORE the outer restart body sends prompts and persists to DB.
        capturedResolvedNew = loopService.resolveLoopName('race-new-session')
        capturedResolvedOld = loopService.resolveLoopName('session-old')
        capturedPhase = loopService.getActiveState('race-loop')?.phase ?? null
        return result
      },
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'race-loop' },
      },
    )

    expect(result.ok).toBe(true)

    // At the moment runExclusive released, the new session should already be
    // registered so concurrent observers never see the stale old session.
    expect(capturedResolvedNew).toBe('race-loop')
    expect(capturedResolvedOld).toBeNull()
    expect(capturedPhase).toBe('coding')
  })

  test('force-restart from auditing phase sends exactly one code prompt and detaches old session', async () => {
    insertLoop({
      loopName: 'audit-restart-loop',
      phase: 'auditing',
      totalSections: 0,
      iteration: 2,
      status: 'running',
      terminationReason: null,
      active: true,
    })

    const noopFn = () => {}

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-code-session' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    let capturedResolvedNew: string | null | undefined
    let capturedResolvedOld: string | null | undefined
    let capturedPhase: string | null | undefined

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => {
        const result = await fn()
        capturedResolvedNew = loopService.resolveLoopName('new-code-session')
        capturedResolvedOld = loopService.resolveLoopName('session-old')
        capturedPhase = loopService.getActiveState('audit-restart-loop')?.phase ?? null
        return result
      },
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'audit-restart-loop' },
        force: true,
      },
    )

    expect(result.ok).toBe(true)

    // Exactly one session create and one prompt dispatch
    expect((client.session.create as any).mock.calls).toHaveLength(1)
    expect((client.session.promptAsync as any).mock.calls).toHaveLength(1)

    // Prompt sent with code agent to new session
    expect((client.session.promptAsync as any).mock.calls[0][0].agent).toBe('code')
    expect((client.session.promptAsync as any).mock.calls[0][0].sessionID).toBe('new-code-session')

    // At the moment runExclusive released, new session is registered and old is gone
    expect(capturedResolvedNew).toBe('audit-restart-loop')
    expect(capturedResolvedOld).toBeNull()
    expect(capturedPhase).toBe('coding')

    // Exactly one abort for the old session
    expect((client.session.abort as any).mock.calls).toHaveLength(1)
    expect((client.session.abort as any).mock.calls[0][0].sessionID).toBe('session-old')
  })

  test('post-action-disabled restart records the completed terminal transition row', async () => {
    insertLoop({
      loopName: 'post-action-disabled-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 0,
      iteration: 2,
      totalSections: 0,
      phase: 'post_action',
    })

    const noopFn = () => {}

    // The disabled-post-action restart branch calls loop.service.terminate and
    // loop.service.recordTransition. Delegate both to the real loopService so
    // the terminal row is persisted through the same shared path used by the
    // runtime.
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      terminate: (name, opts) => loopService.terminate(name, opts),
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      buildPostActionPrompt: () => 'should-not-be-called',
      buildSectionInitialPrompt: () => 'should-not-be-called',
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'should-not-be-used' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      // postAction NOT configured → resolvePostActionConfig returns enabled=false.
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'post-action-disabled-loop' },
      },
    )

    // The restart returns the disabled-post-action error outcome (the restart
    // service wraps the in-lock failure as a 500 internal_error response,
    // which is the existing behavior of the dispatch path; the row assertion
    // below is what we actually care about for the bug fix).
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(500)
    expect(result.error.message).toContain('post-action is disabled')

    // Exactly one terminal transition row was persisted through the shared path.
    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, 'post-action-disabled-loop')
    expect(rows).toHaveLength(1)
    expect(rows[0].eventType).toBe('completed')
    expect(rows[0].transitionKind).toBe('terminate')
    expect(rows[0].fromPhase).toBe('post_action')
    expect(rows[0].toPhase).toBeNull()
    expect(rows[0].status).toBe('completed')
    expect(rows[0].reason).toBe('completed')
    expect(rows[0].iteration).toBe(2)
  })

  async function createRestartOverrideService(promptImpl?: () => Promise<void>, abortImpl?: () => Promise<void>) {
    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'override-restart-session' }),
        get: async () => ({}),
        promptAsync: async () => { await promptImpl?.() },
        abort: async () => { await abortImpl?.() },
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true, postAction: { enabled: true, skill: 'pr-review' } },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    return { service, client }
  }

  test('restart applies auditor model/variant overrides to the restarted prompt and persisted loop', async () => {
    insertLoop({
      loopName: 'override-audit-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'post_action',
      totalSections: 0,
      auditorModel: 'prov/oldaud',
      auditorVariant: 'low',
    })

    const { service, client } = await createRestartOverrideService()

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'override-audit-loop' },
        auditorModel: 'prov/newaud',
        auditorVariant: 'max',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.model).toEqual({ providerID: 'prov', modelID: 'newaud' })
    expect(promptCall.variant).toBe('max')

    const row = loopsRepo.get(PROJECT_ID, 'override-audit-loop')!
    expect(row.auditorModel).toBe('prov/newaud')
    expect(row.auditorVariant).toBe('max')
    expect(row.auditorFallbackIndex).toBe(0)
    expect(row.status).toBe('running')

    const activeState = loopService.getActiveState('override-audit-loop')!
    expect(activeState.auditorModel).toBe('prov/newaud')
    expect(activeState.auditorVariant).toBe('max')
  })

  test('restart without auditor overrides preserves the persisted auditor model and variant', async () => {
    insertLoop({
      loopName: 'preserve-audit-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
      totalSections: 0,
      auditorModel: 'prov/oldaud',
      auditorVariant: 'high',
    })

    const { service, client } = await createRestartOverrideService()

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'preserve-audit-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.model).toEqual({ providerID: 'prov', modelID: 'exec' })
    expect(promptCall.variant).toBeUndefined()

    const row = loopsRepo.get(PROJECT_ID, 'preserve-audit-loop')!
    expect(row.auditorModel).toBe('prov/oldaud')
    expect(row.auditorVariant).toBe('high')
    expect(row.auditorFallbackIndex).toBe(0)
  })

  test('restart with an empty auditor variant clears the persisted variant', async () => {
    insertLoop({
      loopName: 'clear-audit-variant-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'post_action',
      totalSections: 0,
      auditorModel: 'prov/oldaud',
      auditorVariant: 'high',
    })

    const { service, client } = await createRestartOverrideService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'clear-audit-variant-loop' },
        auditorModel: 'prov/newaud',
        auditorVariant: '',
      },
    )

    expect(result.ok).toBe(true)
    expect((client.session.promptAsync as any).mock.calls[0][0].variant).toBeUndefined()
    expect(loopsRepo.get(PROJECT_ID, 'clear-audit-variant-loop')!.auditorVariant).toBeNull()
  })

  test('failed restart with auditor overrides rolls back all prior model fields', async () => {
    loopsRepo.insert({
      projectId: PROJECT_ID,
      loopName: 'rollback-override-loop',
      status: 'stalled',
      currentSessionId: 'session-old',
      worktree: false,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
      maxIterations: 10,
      iteration: 3,
      auditCount: 1,
      errorCount: 0,
      phase: 'coding',
      executionModel: 'prov/oldexec',
      auditorModel: 'prov/oldaud',
      executionVariant: 'med',
      auditorVariant: 'high',
      modelFailed: true,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: 'stall_timeout',
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      auditorFallbackIndex: 1,
    }, { lastAuditResult: null })

    const { service } = await createRestartOverrideService(() => Promise.reject(new Error('prompt delivery failed')))

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'rollback-override-loop' },
        auditorModel: 'prov/newaud',
        auditorVariant: 'max',
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('could not send prompt to new session')

    const row = loopsRepo.get(PROJECT_ID, 'rollback-override-loop')!
    expect(row.status).toBe('stalled')
    expect(row.terminationReason).toBe('stall_timeout')
    expect(row.executionModel).toBe('prov/oldexec')
    expect(row.executionVariant).toBe('med')
    expect(row.auditorModel).toBe('prov/oldaud')
    expect(row.auditorVariant).toBe('high')
    expect(row.auditorFallbackIndex).toBe(1)
    expect(row.modelFailed).toBe(true)
  })

  test('force restart of an active loop applies auditor overrides', async () => {
    insertLoop({
      loopName: 'force-override-loop',
      status: 'running',
      terminationReason: null,
      phase: 'coding',
      totalSections: 0,
      iteration: 4,
      active: true,
      auditorModel: 'prov/oldaud',
      auditorVariant: 'high',
    })

    const { service } = await createRestartOverrideService()

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'force-override-loop' },
        force: true,
        auditorModel: 'prov/newaud',
        auditorVariant: 'max',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.sessionId).toBe('override-restart-session')
    expect(result.data.previousSessionId).toBe('session-old')

    const row = loopsRepo.get(PROJECT_ID, 'force-override-loop')!
    expect(row.status).toBe('running')
    expect(row.auditorModel).toBe('prov/newaud')
    expect(row.auditorVariant).toBe('max')
    expect(row.auditorFallbackIndex).toBe(0)
  })

  test('force restart of an active loop applies execution overrides', async () => {
    insertLoop({
      loopName: 'force-exec-override-loop',
      status: 'running',
      terminationReason: null,
      phase: 'coding',
      totalSections: 0,
      iteration: 4,
      active: true,
      executionModel: 'prov/oldexec',
      executionVariant: 'low',
      auditorModel: 'prov/oldaud',
      auditorVariant: 'high',
    })

    const { service, client } = await createRestartOverrideService()

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'force-exec-override-loop' },
        force: true,
        executionModel: 'prov/newexec',
        executionVariant: 'max',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.model).toEqual({ providerID: 'prov', modelID: 'newexec' })
    expect(promptCall.variant).toBe('max')

    const row = loopsRepo.get(PROJECT_ID, 'force-exec-override-loop')!
    expect(row.executionModel).toBe('prov/newexec')
    expect(row.executionVariant).toBe('max')
    expect(row.auditorModel).toBe('prov/oldaud')
    expect(row.auditorVariant).toBe('high')

    const activeState = loopService.getActiveState('force-exec-override-loop')!
    expect(activeState.executionModel).toBe('prov/newexec')
    expect(activeState.executionVariant).toBe('max')
    expect(activeState.auditorModel).toBe('prov/oldaud')
    expect(activeState.auditorVariant).toBe('high')
  })

  test('restart with an empty execution variant clears the persisted variant', async () => {
    insertLoop({
      loopName: 'clear-exec-variant-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
      totalSections: 0,
      executionModel: 'prov/oldexec',
      executionVariant: 'high',
    })

    const { service, client } = await createRestartOverrideService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'clear-exec-variant-loop' },
        executionModel: 'prov/newexec',
        executionVariant: '',
      },
    )

    expect(result.ok).toBe(true)
    expect((client.session.promptAsync as any).mock.calls[0][0].variant).toBeUndefined()
    expect(loopsRepo.get(PROJECT_ID, 'clear-exec-variant-loop')!.executionVariant).toBeNull()
  })

  test('force restart stops when the active session cannot be aborted', async () => {
    insertLoop({
      loopName: 'abort-failure-loop',
      status: 'running',
      terminationReason: null,
      phase: 'coding',
      totalSections: 0,
      active: true,
    })

    const { service, client } = await createRestartOverrideService(undefined, () => Promise.reject(new Error('abort failed')))
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'abort-failure-loop' },
        force: true,
        auditorModel: 'prov/newaud',
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Could not abort active loop session session-old: abort failed')
    expect(client.session.create).not.toHaveBeenCalled()
    expect(loopsRepo.get(PROJECT_ID, 'abort-failure-loop')!.currentSessionId).toBe('session-old')
  })
})

describe('handleLoopRestart restartability rules', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopTransitionsRepo: LoopTransitionsRepo
  let loopService: LoopService
  let notifySpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-restart-rules-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    notifySpy = vi.fn()
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      notifySpy,
      sectionPlansRepo,
      loopTransitionsRepo,
    )
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  function insertLoop(overrides: Partial<{
    loopName: string
    phase: string
    currentSectionIndex: number
    totalSections: number
    iteration: number
    status: string
    terminationReason: string | null
    active: boolean
    worktree: boolean
    worktreeDir: string
    worktreeBranch: string | null
    projectDir: string
    workspaceId: string | null
    hostSessionId: string | null
    startedAt: number
    sandboxSettings: { enabled?: boolean; resources?: { memory?: string; cpus?: string; dockerDisk?: string; cacheDisk?: string } } | null
  }> = {}) {
    const defaults = {
      loopName: 'test-loop',
      phase: 'coding',
      currentSectionIndex: 0,
      totalSections: 0,
      iteration: 1,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      active: false,
      worktree: false,
      worktreeDir: '/tmp/test-worktree',
      worktreeBranch: null as string | null,
      projectDir: '/tmp',
      workspaceId: null as string | null,
      hostSessionId: null as string | null,
      startedAt: Date.now(),
      sandboxSettings: null as { enabled?: boolean; resources?: { memory?: string; cpus?: string; dockerDisk?: string; cacheDisk?: string } } | null,
    }
    const opts = { ...defaults, ...overrides }
    loopsRepo.insert({
      projectId: PROJECT_ID,
      loopName: opts.loopName,
      status: opts.status as any,
      currentSessionId: 'session-old',
      worktree: opts.worktree,
      worktreeDir: opts.worktreeDir,
      worktreeBranch: opts.worktreeBranch,
      projectDir: opts.projectDir,
      maxIterations: 10,
      iteration: opts.iteration,
      auditCount: 0,
      errorCount: 0,
      phase: opts.phase as any,
      executionModel: null,
      auditorModel: null,
      executionVariant: null,
      auditorVariant: null,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: opts.startedAt,
      completedAt: null,
      terminationReason: opts.terminationReason,
      completionSummary: null,
      workspaceId: opts.workspaceId,
      hostSessionId: opts.hostSessionId,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      sandboxSettings: opts.sandboxSettings,
    }, { lastAuditResult: null })
  }

  async function createMockService(opts?: { sandboxManager?: unknown; terminate?: (name: string, reason: any) => Promise<boolean>; config?: Record<string, any>; runExclusive?: (name: string, fn: () => Promise<any>) => Promise<any> }) {
    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      terminate: (name, opts) => loopService.terminate(name, opts),
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      buildContinuationPrompt: () => 'continuation prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-restart' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws-new', directory: '/tmp', branch: 'main' }),
        list: async () => [],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: opts?.runExclusive ?? (async <T>(name: string, fn: () => Promise<T>) => fn()),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockPendingTeardowns = {
      register: noopFn,
      unregister: noopFn,
      get: () => undefined,
    }

    // Default terminate: persist errored status and termination reason, then mark inactive.
    const defaultTerminate = async (name: string, reason: any) => {
      const state = loopService.getActiveState(name)
      if (!state?.active) return false
      loopService.terminate(name, {
        status: 'errored',
        reason: reason.kind === 'provider_limit' ? `provider_limit: ${reason.message}` : reason.kind,
        completedAt: Date.now(),
      })
      return true
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        ...(opts?.config ?? {}),
      },
      logger: mockLogger,
      dataDir: '/tmp',

      plansRepo,
      loopsRepo,
      loop: {
          service: mockLoopService,
          listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
          listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
          setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          terminate: opts?.terminate ?? defaultTerminate,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      pendingTeardowns: mockPendingTeardowns as any,
      client,
      sandboxManager: opts?.sandboxManager as any,
    })

    return {
      service,
      client,
    }
  }

  test('restart proceeds when expectedStartedAt matches the current generation', async () => {
    const startedAt = Date.now() - 60_000
    insertLoop({
      loopName: 'generation-match-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
      startedAt,
    })

    const { service } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'generation-match-loop' },
        expectedStartedAt: new Date(startedAt).toISOString(),
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.sessionId).toBe('new-session-restart')
  })

  test('stale expectedStartedAt is rejected before aborting the active session', async () => {
    const startedAt = Date.now() - 60_000
    insertLoop({
      loopName: 'stale-generation-loop',
      status: 'running',
      phase: 'coding',
      startedAt,
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'stale-generation-loop' },
        force: true,
        expectedStartedAt: new Date(startedAt - 1000).toISOString(),
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe(
      'Loop "stale-generation-loop" was restarted since it was selected. Reopen the restart dialog to see its current state.',
    )
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(client.session.create).not.toHaveBeenCalled()
  })

  test('a second restart with the same stale expectedStartedAt is rejected after the first completed', async () => {
    const startedAt = Date.now() - 60_000
    insertLoop({
      loopName: 'sequential-generation-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
      startedAt,
    })

    const { service, client } = await createMockService()
    const first = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'sequential-generation-loop' },
        expectedStartedAt: new Date(startedAt).toISOString(),
      },
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(client.session.abort).not.toHaveBeenCalled()

    const second = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'sequential-generation-loop' },
        force: true,
        expectedStartedAt: new Date(startedAt).toISOString(),
      },
    )

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.message).toContain('was restarted since it was selected')
    expect(client.session.abort).not.toHaveBeenCalled()

    const state = loopService.getActiveState('sequential-generation-loop')
    expect(state?.sessionId).toBe(first.data.sessionId)
  })

  test.each([
    ['cancelled', 'user_aborted'],
    ['errored', 'max_iterations'],
    ['errored', 'error_max_retries'],
    ['stalled', 'stall_timeout'],
    ['errored', 'audit_retry_exhausted'],
  ])(
    'restarts %s loop with terminationReason %s without force',
    async (status, terminationReason) => {
      const loopName = `restart-${status}-${terminationReason.replace(/:/g, '_')}`
      insertLoop({
        loopName,
        status,
        terminationReason,
        phase: 'coding',
      })

      const { service } = await createMockService()
      const result = await service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.restart' as const,
          selector: { kind: 'exact' as const, name: loopName },
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.loopName).toBe(loopName)
      expect(result.data.previousSessionId).toBe('session-old')
      expect(result.data.sessionId).toBe('new-session-restart')
      expect(result.data.iteration).toBe(1)

      const newState = loopService.getActiveState(loopName)
      expect(newState).not.toBeNull()
      expect(newState?.terminationReason).toBeFalsy()
      expect(newState?.completedAt).toBeFalsy()
      expect(newState?.active).toBe(true)
    },
  )

  test('completed loop cannot restart', async () => {
    insertLoop({
      loopName: 'completed-loop',
      status: 'completed',
      terminationReason: 'completed',
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'completed-loop' },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('completed successfully and cannot be restarted')

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.promptAsync).not.toHaveBeenCalled()

    const newState = loopService.getActiveState('completed-loop')
    expect(newState).toBeNull()
  })

  test('completed loop with null terminationReason cannot restart', async () => {
    insertLoop({
      loopName: 'completed-loop-null-reason',
      status: 'completed',
      terminationReason: null,
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'completed-loop-null-reason' },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('completed successfully and cannot be restarted')

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.promptAsync).not.toHaveBeenCalled()

    const newState = loopService.getActiveState('completed-loop-null-reason')
    expect(newState).toBeNull()
  })

  test('missing worktree blocks restart', async () => {
    const missingDir = join(tmpdir(), `missing-worktree-${Date.now()}`)
    insertLoop({
      loopName: 'missing-worktree-loop',
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: true,
      worktreeDir: missingDir,
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'missing-worktree-loop' },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('worktree directory no longer exists')

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(client.workspace.create).not.toHaveBeenCalled()

    const newState = loopService.getActiveState('missing-worktree-loop')
    expect(newState).toBeNull()
  })

  test('missing worktree but surviving branch allows restart (recreates worktree from branch)', async () => {
    const loopName = 'branch-survives-loop'
    // Real repo whose forge/<loopName> branch outlives the pruned worktree directory.
    const repoDir = mkdtempSync(join(tmpdir(), 'restart-branch-repo-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    git('init', '-q')
    git('-c', 'user.email=t@t.co', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'init')
    git('branch', `forge/${loopName}`)

    const missingDir = join(tmpdir(), `pruned-worktree-${Date.now()}`)
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: true,
      worktreeDir: missingDir,
      projectDir: repoDir,
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: repoDir },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Restart proceeded: a fresh worktree workspace was requested and a new code session created.
    expect(client.workspace.create).toHaveBeenCalled()
    expect(client.session.create).toHaveBeenCalled()

    const newState = loopService.getActiveState(loopName)
    expect(newState?.active).toBe(true)
  })

  test('sandbox starts after the worktree is recreated, using the refreshed directory', async () => {
    const loopName = 'sandbox-order-loop'
    const repoDir = mkdtempSync(join(tmpdir(), 'restart-sandbox-repo-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    git('init', '-q')
    git('-c', 'user.email=t@t.co', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'init')
    git('branch', `forge/${loopName}`)

    const missingDir = join(tmpdir(), `pruned-sandbox-worktree-${Date.now()}`)
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: true,
      worktreeDir: missingDir,
      projectDir: repoDir,
      phase: 'coding',
    })

    const sandboxStartSpy = vi.fn().mockResolvedValue({ containerName: 'forge-sandbox' })
    const sandboxManager = {
      start: sandboxStartSpy,
      runtime: { sandboxContainerName: () => 'forge-sandbox' },
    }

    const { service, client } = await createMockService({ sandboxManager })
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: repoDir },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Sandbox started with the recreated worktree directory, not the pruned one.
    expect(sandboxStartSpy).toHaveBeenCalledWith(loopName, '/tmp', undefined, undefined)

    // And only after the worktree workspace was recreated.
    expect(client.workspace.create).toHaveBeenCalled()
    expect(Math.min(...sandboxStartSpy.mock.invocationCallOrder))
      .toBeGreaterThan(Math.min(...(client.workspace.create as any).mock.invocationCallOrder))
  })

  test('restart of a loop that opted out of the sandbox does not start it and keeps sandbox=false', async () => {
    const loopName = 'sandbox-optout-loop'
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: false,
      phase: 'coding',
      sandboxSettings: { enabled: false },
    })

    const sandboxStartSpy = vi.fn().mockResolvedValue({ containerName: 'forge-sandbox' })
    const sandboxManager = {
      start: sandboxStartSpy,
      runtime: { sandboxContainerName: () => 'forge-sandbox' },
    }

    const { service } = await createMockService({ sandboxManager })
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.sandbox).toBe(false)
    expect(sandboxStartSpy).not.toHaveBeenCalled()

    const newState = loopService.getActiveState(loopName)
    expect(newState?.active).toBe(true)
    expect(newState?.sandbox).toBe(false)
    expect(newState?.sandboxSettings).toEqual({ enabled: false })
  })

  test('retries a transient "Session not found" on restart prompt instead of rolling back', async () => {
    const loopName = 'transient-session-loop'
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: false,
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    // First outer attempt (2 model tries + 1 fallback) fails with a transient
    // not-found; the next attempt after backoff succeeds.
    let calls = 0
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      calls += 1
      if (calls <= 3) {
        throw { name: 'NotFoundError', data: { message: `Session not found: ses_x` } }
      }
      // success - return undefined
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toBeGreaterThan(3)

    const newState = loopService.getActiveState(loopName)
    expect(newState?.active).toBe(true)
    expect(newState?.terminationReason).toBeFalsy()
  })

  test('rolls back to previous state when restart prompt keeps failing', async () => {
    const loopName = 'persistent-fail-loop'
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      worktree: false,
      phase: 'coding',
    })

    const { service, client } = await createMockService()
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'NotFoundError', data: { message: 'Session not found: ses_x' } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('could not send prompt')

    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeNull()
  })

  test('restart prompt failure with provider limit terminates loop instead of rolling back', async () => {
    const loopName = 'provider-limit-restart-loop'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
    })

    const terminateSpy = vi.fn(async (name: string, reason: any) => {
      const state = loopService.getActiveState(name)
      if (!state?.active) return false
      loopService.terminate(name, {
        status: 'errored',
        reason: reason.kind === 'provider_limit' ? `provider_limit: ${reason.message}` : reason.kind,
        completedAt: Date.now(),
      })
      return true
    })
    const { service, client } = await createMockService({ terminate: terminateSpy })

    // Prompt fails with a usage-limit error
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'APIError', data: { message: 'You have reached your usage limit', statusCode: 429 } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    // Terminate was called with provider_limit reason
    expect(terminateSpy).toHaveBeenCalledOnce()
    const [terminatedName, reason] = terminateSpy.mock.calls[0]
    expect(terminatedName).toBe(loopName)
    expect(reason).toEqual({ kind: 'provider_limit', message: expect.stringContaining('usage limit') })

    // State is errored with provider_limit reason (set by the default terminate mock)
    const newState = loopService.getAnyState(loopName)
    expect(newState).not.toBeNull()
    expect(newState?.status).toBe('errored')
    expect(newState?.terminationReason).toContain('provider_limit')

    // New session was NOT rolled back (state was terminated, not reverted)
    expect(newState?.sessionId).toBe('new-session-restart')
  })

  test('restart prompt failure with non-provider-limit error still rolls back', async () => {
    const loopName = 'generic-fail-restart-loop'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
    })

    const terminateSpy = vi.fn(async () => true)
    const { service, client } = await createMockService({ terminate: terminateSpy })

    // Prompt fails with a generic non-provider-limit error
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'NotFoundError', data: { message: 'Session not found: ses_x' } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: loopName },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    // Terminate was NOT called (rolled back instead)
    expect(terminateSpy).not.toHaveBeenCalled()

    // State was rolled back (new state deleted)
    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeNull()
  })

  test('successful phase-changing restart records exactly one restart phase transition row', async () => {
    const loopName = 'success-phase-change-restart'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'auditing',
      iteration: 3,
      totalSections: 0,
    })

    const { service } = await createMockService()

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
    // Exactly one row: pre-prompt restart phase transition (auditing -> coding).
    // The duplicate post-success log at the old line-2170 site is gone.
    expect(rows).toHaveLength(1)
    expect(rows[0].eventType).toBe('restart')
    expect(rows[0].transitionKind).toBe('phase')
    expect(rows[0].fromPhase).toBe('auditing')
    expect(rows[0].toPhase).toBe('coding')
    // The loop is running again, so no terminate notify should have fired.
    expect(notifySpy.mock.calls.find((c: any[]) => c[0] === 'terminate' && c[1] === loopName)).toBeUndefined()
  })

  test('successful same-phase restart (post_action preserved) records no transition rows', async () => {
    const loopName = 'success-same-phase-restart'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'post_action',
      iteration: 3,
      totalSections: 0,
    })

    const { service } = await createMockService({ config: { loop: { enabled: true, postAction: { enabled: true, skill: 'pr-review' } } } })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
    // Persisted phase equals restart phase (post_action), so no phase
    // change to log — zero rows.
    expect(rows).toHaveLength(0)
  })

  test('inactive-loop prompt failure records only a rollback transition row and fires no terminate notify', async () => {
    const loopName = 'inactive-fail-rollback'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'auditing',
      iteration: 2,
      totalSections: 0,
    })

    const { service, client } = await createMockService()
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'NotFoundError', data: { message: 'Session not found: ses_x' } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
    // Two rows for an inactive rollback whose restart changed the phase:
    //   1. previousPhase -> restartPhase (pre-prompt restart phase row)
    //   2. restartPhase -> previousPhase (rollback restoration row)
    // No terminal row — the inactive row is restored unchanged.
    expect(rows).toHaveLength(2)
    expect(rows[0].eventType).toBe('restart')
    expect(rows[0].transitionKind).toBe('phase')
    expect(rows[0].fromPhase).toBe('auditing')
    expect(rows[0].toPhase).toBe('coding')
    expect(rows[1].eventType).toBe('restart_prompt_failed')
    expect(rows[1].transitionKind).toBe('rollback')
    expect(rows[1].fromPhase).toBe('coding')
    expect(rows[1].toPhase).toBe('auditing')
    expect(rows[1].status).toBeNull()
    expect(rows[1].reason).toBeNull()

    // Restore preserved the prior terminal row state — loop stays inactive.
    const restoredState = loopService.getAnyState(loopName)!
    expect(restoredState.active).toBe(false)
    expect(restoredState.status).toBe('stalled')
    expect(restoredState.phase).toBe('auditing')
    expect(restoredState.terminationReason).toBe('stall_timeout')

    // No terminate notify fired (group orchestration must not learn about a
    // no-op rollback on an already-stopped loop).
    expect(notifySpy.mock.calls.find((c: any[]) => c[0] === 'terminate' && c[1] === loopName)).toBeUndefined()
  })

  test('active-loop prompt failure records ordered restart/rollback/terminate rows and fires terminate notify', async () => {
    const loopName = 'active-fail-rollback'
    insertLoop({
      loopName,
      status: 'running',
      terminationReason: null,
      phase: 'auditing',
      iteration: 4,
      totalSections: 0,
      active: true,
    })

    const { service, client } = await createMockService()
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'NotFoundError', data: { message: 'Session not found: ses_x' } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName }, force: true },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
    // Ordered: previousPhase -> restartPhase (restart phase), restartPhase ->
    // previousPhase (rollback), previousPhase -> null (terminate).
    expect(rows).toHaveLength(3)
    expect(rows[0].eventType).toBe('restart')
    expect(rows[0].transitionKind).toBe('phase')
    expect(rows[0].fromPhase).toBe('auditing')
    expect(rows[0].toPhase).toBe('coding')
    expect(rows[1].eventType).toBe('restart_prompt_failed')
    expect(rows[1].transitionKind).toBe('rollback')
    expect(rows[1].fromPhase).toBe('coding')
    expect(rows[1].toPhase).toBe('auditing')
    expect(rows[2].eventType).toBe('restart_prompt_failed')
    expect(rows[2].transitionKind).toBe('terminate')
    expect(rows[2].fromPhase).toBe('auditing')
    expect(rows[2].toPhase).toBeNull()
    expect(rows[2].status).toBe('errored')
    expect(rows[2].reason).toBe('restart_prompt_failed')

    // Active-rollback routed through loopService.terminate so group
    // orchestration is informed via the terminate notify.
    const terminateNotify = notifySpy.mock.calls.find(
      (c: any[]) => c[0] === 'terminate' && c[1] === loopName,
    )
    expect(terminateNotify).toBeDefined()

    const restoredState = loopService.getAnyState(loopName)!
    expect(restoredState.active).toBe(false)
    expect(restoredState.status).toBe('errored')
    expect(restoredState.terminationReason).toBe('restart_prompt_failed')
    expect(restoredState.phase).toBe('auditing')
  })

  test('provider-limit restart records only the terminal transition row and fires terminate notify', async () => {
    const loopName = 'provider-limit-transition-row'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'auditing',
      iteration: 2,
      totalSections: 0,
    })

    // Use the default mock terminate (sets errored + provider_limit reason).
    const { service, client } = await createMockService()
    ;(client.session.promptAsync as any).mockImplementation(async () => {
      throw { name: 'APIError', data: { message: 'You have reached your usage limit', statusCode: 429 } }
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    // Provider-limit branch routes through deps.loop.terminate (the runtime
    // helper) — that path emits the terminate notify via the spy'd mock
    // defaultTerminate. No rollback rows: the limit branch returns before the
    // generic rollback path.
    const terminateNotify = notifySpy.mock.calls.find(
      (c: any[]) => c[0] === 'terminate' && c[1] === loopName,
    )
    expect(terminateNotify).toBeDefined()
  })

  test('provider-limit termination runs outside the runExclusive lock (non-reentrant deadlock regression)', async () => {
    // Regression guard: the buggy implementation called `deps.loop.terminate`
    // inside the runExclusive callback. `deps.loop.terminate` ->
    // `terminateLoopByName` -> `withStateLock` is non-reentrant, so while the
    // runExclusive callback still held the per-loop state lock, the inner
    // lock acquisition would block forever and the restart request would hang.
    // The fix defers termination to AFTER runExclusive releases the lock.
    //
    // We emulate the runtime's per-loop non-reentrant mutex here and route both
    // `runExclusive` and `deps.loop.terminate` through it. With the regression
    // present, the inner terminate's acquire() would never resolve and the
    // Promise.race would reject with the deadlock sentinel. With the fix, the
    // callback returns the provider-limit outcome WITHOUT calling terminate; the
    // outer flow performs the canonical termination after the lock is released.
    const loopName = 'provider-limit-deadlock-regression'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'coding',
      iteration: 2,
      totalSections: 0,
    })

    const mutex = createNonReentrantMutex()
    let terminateAttemptedInsideLock = false
    let terminateCalls = 0
    let lastTerminateArgs: { name: string; reason: any } | null = null
    const terminateSpy = async (name: string, reason: any) => {
      terminateCalls++
      lastTerminateArgs = { name, reason }
      // Emulate runtime.terminate -> terminateLoopByName -> terminateLoop ->
      // withStateLock by attempting to acquire the SAME per-loop mutex. If
      // runExclusive still holds it (regression), this await never resolves.
      if (mutex.isLocked()) terminateAttemptedInsideLock = true
      await mutex.acquire()
      try {
        const state = loopService.getActiveState(name)
        if (!state?.active) return false
        const status = 'errored' as const
        const reasonText = reason.kind === 'provider_limit' ? `provider_limit: ${reason.message}` : reason.kind
        // Mirror runtime.terminateLoop: record the terminal transition row
        // inside the admission guard, then persist the cancellation.
        loopService.recordTransition(name, {
          eventType: reason.kind,
          transitionKind: 'terminate',
          fromPhase: state.phase,
          toPhase: null,
          status,
          reason: reasonText,
          iteration: state.iteration ?? 0,
          sectionIndex: state.totalSections > 0 ? (state.currentSectionIndex ?? 0) : null,
        })
        loopService.terminate(name, {
          status,
          reason: reasonText,
          completedAt: Date.now(),
        })
      } finally {
        mutex.release()
      }
      return true
    }

    const noopFn = () => {}
    const mockLoopService: Partial<LoopService> = {
      buildPlanInitialPrompt: (text) => loopService.buildPlanInitialPrompt(text),
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      terminate: (name, opts) => loopService.terminate(name, opts),
      buildSectionInitialPrompt: () => 'section prompt',
      buildPostActionPrompt: () => 'post action prompt',
      buildContinuationPrompt: () => 'continuation prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      discardPendingHandoff: (name) => loopService.discardPendingHandoff(name),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-restart' }),
        get: async () => ({}),
        promptAsync: async () => {
          throw { name: 'APIError', data: { message: 'You have reached your usage limit', statusCode: 429 } }
        },
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: {
        create: async () => ({ id: 'ws-new', directory: '/tmp', branch: 'main' }),
        list: async () => [],
        remove: async () => {},
        warp: async () => {},
      },
      toast: async () => {},
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        await mutex.acquire()
        try { return await fn() } finally { mutex.release() }
      },
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockPendingTeardownsInline = {
      register: noopFn,
      unregister: noopFn,
      get: () => undefined,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      plansRepo,
      loopsRepo,
      loop: {
        service: mockLoopService,
        listActive: (...args: any[]) => (mockLoopService.listActive as any)(...args),
        listRecent: (...args: any[]) => (mockLoopService.listRecent as any)(...args),
        setPhase: (...args: any[]) => (mockLoopService.setPhase as any)(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        terminate: terminateSpy,
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      pendingTeardowns: mockPendingTeardownsInline as any,
      client,
    })

    // Race the dispatch against a deadlock sentinel. With the regression, the
    // inner terminate await would block forever and the race rejects. With the
    // fix, the dispatch completes well within the timeout.
    const result = await Promise.race([
      service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('provider-limit restart deadlocked')), 2000)),
    ]) as any

    expect(result.ok).toBe(false)

    // Termination ran exactly once — outside the runExclusive lock.
    expect(terminateCalls).toBe(1)
    expect(terminateAttemptedInsideLock).toBe(false)
    expect((lastTerminateArgs as any)?.name).toBe(loopName)
    expect((lastTerminateArgs as any)?.reason).toEqual({ kind: 'provider_limit', message: expect.stringContaining('usage limit') })

    // Persisted state: errored + provider_limit reason.
    const newState = loopService.getAnyState(loopName)
    expect(newState).not.toBeNull()
    expect(newState?.active).toBe(false)
    expect(newState?.status).toBe('errored')
    expect(newState?.terminationReason).toContain('provider_limit')

    // Exactly one terminal transition row (provider_limit), and no rollback
    // rows — the provider-limit branch returns before the generic rollback.
    const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
    expect(rows.filter((r) => r.transitionKind === 'terminate')).toHaveLength(1)
    const termRow = rows.find((r) => r.transitionKind === 'terminate')!
    expect(termRow.eventType).toBe('provider_limit')
    expect(termRow.fromPhase).toBe('coding')
    expect(termRow.toPhase).toBeNull()
    expect(termRow.status).toBe('errored')
    expect(termRow.reason).toContain('provider_limit')
    expect(rows.filter((r) => r.transitionKind === 'rollback')).toHaveLength(0)
  })
})
