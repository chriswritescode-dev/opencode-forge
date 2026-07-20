import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
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
  let loopService: LoopService

  const mockWorkspaceStatusRegistry = {
    awaitConnected: async () => ({ connected: true }),
  }

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
    }
    const opts = { ...defaults, ...overrides }
    loopsRepo.insert({
      projectId: PROJECT_ID,
      loopName: opts.loopName,
      status: opts.status as any,
      currentSessionId: 'session-old',
      worktree: opts.worktree,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
      maxIterations: 10,
      iteration: opts.iteration,
      auditCount: 0,
      errorCount: 0,
      phase: opts.phase as any,
      executionModel: null,
      auditorModel: null,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: opts.terminationReason,
      completionSummary: null,
      workspaceId: opts.workspaceId,
      hostSessionId: null,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      finalAuditDone: 0,
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

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()
    const buildFinalAuditPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'stall-loop',
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
      tui: { publish: async () => {}, selectSession: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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
    expect(buildFinalAuditPromptSpy).not.toHaveBeenCalled()
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
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'iter-loop',
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
      tui: { publish: async () => {}, selectSession: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'worktree-loop',
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
        syncList: async () => {},
      },
      tui: { publish: async () => {}, selectSession: async () => {} },
      sync: { start: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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

  test('restart from stall_timeout routes to final_auditing when persisted phase is final_auditing', async () => {
    insertLoop({
      loopName: 'final-audit-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 5,
      iteration: 6,
      totalSections: 5,
      phase: 'final_auditing',
    })

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'final-audit-loop',
      sections: [
        { index: 0, title: 'A', content: 'a' },
        { index: 1, title: 'B', content: 'b' },
        { index: 2, title: 'C', content: 'c' },
        { index: 3, title: 'D', content: 'd' },
        { index: 4, title: 'E', content: 'e' },
      ],
    })
    for (let i = 0; i < 5; i++) {
      sectionPlansRepo.setStatus(PROJECT_ID, 'final-audit-loop', i, 'completed')
    }

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()
    const buildFinalAuditPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'final-audit-loop',
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-sess-789' }),
        get: async () => ({}),
        promptAsync: async () => {},
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      tui: { publish: async () => {}, selectSession: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'final-audit-loop' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const newState = loopService.getActiveState('final-audit-loop')!
    expect(newState.phase).toBe('final_auditing')

    expect(buildFinalAuditPromptSpy).toHaveBeenCalledTimes(1)
    expect(buildSectionInitialPromptSpy).not.toHaveBeenCalled()
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
    })

    const noopFn = () => {}
    const buildPostActionPromptSpy = vi.fn()
    const buildSectionInitialPromptSpy = vi.fn()
    const buildFinalAuditPromptSpy = vi.fn()

    const mockLoopService: Partial<LoopService> = {
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
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'post-action-loop',
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
      tui: { publish: async () => {}, selectSession: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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
    expect(buildFinalAuditPromptSpy).not.toHaveBeenCalled()
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
      tui: { publish: async () => {}, selectSession: async () => {} },
    })

    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'race-loop',
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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
      tui: { publish: async () => {}, selectSession: async () => {} },
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
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'audit-restart-loop',
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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

  test('restart uses phase re-fetched under the lock, not the stale pre-lock snapshot (final_auditing -> final_audit_fix race)', async () => {
    // The pre-lock snapshot (captured via listActive/listRecent before runExclusive
    // acquires the lock) sees phase 'final_auditing'. While we wait for the lock,
    // the loop transitions to final_audit_fix. The authoritative state fetched
    // inside the lock must drive the restart decision so we restart as a coding
    // pass (phase 'coding', 'code' agent), not as an auditor session.
    insertLoop({
      loopName: 'final-audit-race',
      phase: 'final_auditing',
      currentSectionIndex: 5,
      iteration: 6,
      totalSections: 5,
      status: 'running',
      terminationReason: null,
      active: true,
    })

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()
    const buildFinalAuditPromptSpy = vi.fn()
    const buildFinalAuditFixPromptSpy = vi.fn(() => 'fix prompt')

    // Simulate the phase transition happening while the lock is contended:
    // the first under-lock getActiveState call mutates the persisted phase from
    // 'final_auditing' to 'final_audit_fix' and rotates the current session id
    // from 'session-old' to 'fix-session' before returning, so the
    // authoritative state that drives the restart decision includes the session
    // we actually abort (and must report as previousSessionId), not the stale
    // pre-lock audit session.
    let transitioned = false
    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => {
        if (!transitioned) {
          transitioned = true
          loopsRepo.updatePhase(PROJECT_ID, name, 'final_audit_fix')
          loopsRepo.setCurrentSessionId(PROJECT_ID, name, 'fix-session')
        }
        return loopService.getActiveState(name)
      },
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      buildFinalAuditFixPrompt: buildFinalAuditFixPromptSpy,
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'final-audit-race',
    }

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
      tui: { publish: async () => {}, selectSession: async () => {} },
    })

    let capturedPreLockPhase: string | undefined
    let capturedPreLockSessionId: string | undefined
    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => {
        // Capture the pre-lock snapshot's phase and sessionId as observed by
        // the outer dispatch code, before the under-lock transition mutates
        // the DB. This proves the under-lock refresh was necessary.
        const preLock = mockLoopService.listActive!().find((s) => s.loopName === name)
        capturedPreLockPhase = preLock?.phase
        capturedPreLockSessionId = preLock?.sessionId
        return fn()
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'final-audit-race' },
        force: true,
      },
    )

    expect(result.ok).toBe(true)

    // Sanity: the pre-lock snapshot really did observe 'final_auditing' and the
    // stale audit session. Without the under-lock sync, restart would have
    // selected the auditor agent and reported the wrong previous session.
    expect(capturedPreLockPhase).toBe('final_auditing')
    expect(capturedPreLockSessionId).toBe('session-old')

    // The restart response reports the authoritative under-lock session that we
    // actually aborted (the fix-session), not the stale pre-lock audit session.
    if (!result.ok) return
    expect(result.data.previousSessionId).toBe('fix-session')

    // Authoritative under-lock phase was 'final_audit_fix', which restarts as a
    // coding pass (phase 'coding', code agent) that resumes fixing the
    // final-audit findings via the fix prompt — not by re-coding the section.
    const newState = loopService.getActiveState('final-audit-race')!
    expect(newState.phase).toBe('coding')

    expect(buildFinalAuditFixPromptSpy).toHaveBeenCalledTimes(1)
    expect(buildSectionInitialPromptSpy).not.toHaveBeenCalled()
    expect(buildFinalAuditPromptSpy).not.toHaveBeenCalled()

    const promptCall = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptCall.agent).toBe('code')
    expect(promptCall.sessionID).toBe('new-code-session')
  })

  test('failed restart on an active loop terminates it restartable instead of resurrecting the aborted session (final_auditing -> final_audit_fix race with prompt failure)', async () => {
    // The pre-lock snapshot sees phase 'final_auditing' with sessionId
    // 'session-old'. While we wait for the lock, the loop transitions to
    // final_audit_fix and rotates to a new fix session 'fix-session'. The
    // restart observes this authoritative state under the lock, aborts the
    // fix session, and starts a fresh restart pass. When the restart prompt
    // delivery fails, rollback MUST NOT resurrect the aborted fix-session as a
    // live registered session — that would strand the loop active with a dead
    // session and no watchdog. Instead, the loop is terminated as errored
    // (restartable without force), preserving the authoritative under-lock
    // phase so a later restart resumes from final_audit_fix rather than the
    // stale pre-lock phase.
    insertLoop({
      loopName: 'final-audit-failed-restart-race',
      phase: 'final_auditing',
      currentSectionIndex: 5,
      iteration: 6,
      totalSections: 5,
      status: 'running',
      terminationReason: null,
      active: true,
    })

    const noopFn = () => {}
    const buildSectionInitialPromptSpy = vi.fn()
    const buildFinalAuditPromptSpy = vi.fn()

    // Simulate the phase transition AND session rotation happening while the
    // lock is contended: the first under-lock getActiveState call mutates the
    // persisted phase (final_auditing -> final_audit_fix) and current
    // session id (session-old -> fix-session) before returning, so the
    // authoritative under-lock state drives both restart decisions and the
    // rollback target.
    let transitioned = false
    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => {
        if (!transitioned) {
          transitioned = true
          loopsRepo.updatePhase(PROJECT_ID, name, 'final_audit_fix')
          loopsRepo.setCurrentSessionId(PROJECT_ID, name, 'fix-session')
        }
        return loopService.getActiveState(name)
      },
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: (sid: string, name: string) => loopService.registerLoopSession(sid, name),
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: (name, phase) => loopService.setPhase(name, phase),
      terminate: (name, opts) => loopService.terminate(name, opts),
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      buildFinalAuditFixPrompt: () => 'fix prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: () => 'final-audit-failed-restart-race',
    }

    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-code-session' }),
        get: async () => ({}),
        // Restart prompt delivery fails — triggers rollback path.
        promptAsync: async () => { throw new Error('prompt delivery failed') },
        abort: async () => {},
        delete: async () => {},
        messages: async () => [],
        status: async () => ({}),
      },
      workspace: { list: async () => [], remove: async () => {} },
      tui: { publish: async () => {}, selectSession: async () => {} },
    })

    let capturedPreLockPhase: string | undefined
    let capturedPreLockSessionId: string | undefined
    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => {
        // Capture the pre-lock snapshot as observed by the outer dispatch
        // code, before the under-lock transition mutates the DB. This proves
        // the rollback target was stale without the under-lock refresh.
        const preLock = mockLoopService.listActive!().find((s) => s.loopName === name)
        capturedPreLockPhase = preLock?.phase
        capturedPreLockSessionId = preLock?.sessionId
        return fn()
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
      client,
      pendingTeardowns: mockPendingTeardowns as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'final-audit-failed-restart-race' },
        force: true,
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('could not send prompt to new session')

    // Sanity: the pre-lock snapshot really did observe final_auditing + the
    // old audit session. Without the under-lock refresh, rollback would have
    // restored these stale values.
    expect(capturedPreLockPhase).toBe('final_auditing')
    expect(capturedPreLockSessionId).toBe('session-old')

    // The under-lock abort targeted the authoritative fix-session, not the
    // stale audit session — restart aborts the session it actually observed.
    const abortCall = (client.session.abort as any).mock.calls[0][0]
    expect(abortCall.sessionID).toBe('fix-session')

    // Rollback terminated the loop as errored (restartable), preserving the
    // authoritative under-lock phase so a later restart resumes from
    // final_audit_fix rather than the stale pre-lock final_auditing. The
    // aborted fix-session is NOT re-registered as live.
    expect(loopService.getActiveState('final-audit-failed-restart-race')).toBeNull()
    const restoredState = loopService.getAnyState('final-audit-failed-restart-race')!
    expect(restoredState).not.toBeNull()
    expect(restoredState.active).toBe(false)
    expect(restoredState.status).toBe('errored')
    expect(restoredState.terminationReason).toBe('restart_prompt_failed')
    expect(restoredState.phase).toBe('final_audit_fix')

    // Neither the aborted fix-session nor the fresh restart session resolves to
    // this loop — rollback must not resurrect a dead session as live.
    expect(loopService.resolveLoopName('fix-session')).toBeNull()
    expect(loopService.resolveLoopName('new-code-session')).toBeNull()
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
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      buildPostActionPrompt: () => 'should-not-be-called',
      buildSectionInitialPrompt: () => 'should-not-be-called',
      buildFinalAuditPrompt: () => 'should-not-be-called',
      generateUniqueLoopName: () => 'post-action-disabled-loop',
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
      tui: { publish: async () => {}, selectSession: async () => {} },
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
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
    kind: 'plan' | 'goal'
    hostSessionId: string | null
    executorSessionId: string | null
    goal: string | null
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
      kind: 'plan' as 'plan' | 'goal',
      hostSessionId: null as string | null,
      executorSessionId: null as string | null,
      goal: null as string | null,
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
      kind: opts.kind,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: opts.terminationReason,
      completionSummary: null,
      workspaceId: opts.workspaceId,
      hostSessionId: opts.hostSessionId,
      executorSessionId: opts.executorSessionId,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      finalAuditDone: 0,
    }, { lastAuditResult: null, goal: opts.goal })
  }

  async function createMockService(opts?: { sandboxManager?: unknown; terminate?: (name: string, reason: any) => Promise<boolean> }) {
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
      terminate: (name, opts) => loopService.terminate(name, opts),
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      buildContinuationPrompt: () => 'goal restart prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: (name) => name,
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
        syncList: async () => {},
      },
      tui: { publish: async () => {}, selectSession: async () => {} },
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockWorkspaceStatusRegistry = {
      awaitConnected: async () => ({ connected: true }),
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
          generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          terminate: opts?.terminate ?? defaultTerminate,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry as any,
      pendingTeardowns: mockPendingTeardowns as any,
      client,
      sandboxManager: opts?.sandboxManager as any,
    })

    return {
      service,
      client,
    }
  }

  test.each([
    ['cancelled', 'user_aborted'],
    ['errored', 'max_iterations'],
    ['errored', 'error_max_retries'],
    ['stalled', 'stall_timeout'],
    ['errored', 'final_audit_retry_exhausted'],
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

    // TUI was navigated to the recreated workspace+session so it connects/focuses.
    expect(client.tui.selectSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'ws-new' }),
    )

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
      docker: { containerName: () => 'forge-sandbox' },
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
    expect(sandboxStartSpy).toHaveBeenCalledWith(loopName, '/tmp')

    // And only after the worktree workspace was recreated.
    expect(client.workspace.create).toHaveBeenCalled()
    expect(Math.min(...sandboxStartSpy.mock.invocationCallOrder))
      .toBeGreaterThan(Math.min(...(client.workspace.create as any).mock.invocationCallOrder))
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

  test('goal loop restart repoints executorSessionId to the new session while preserving hostSessionId', async () => {
    const loopName = 'goal-restart-binding'
    insertLoop({
      loopName,
      status: 'cancelled',
      terminationReason: 'user_aborted',
      phase: 'auditing',
      kind: 'goal',
      // Pre-restart state: a stale executor binding and a distinct host redirect.
      hostSessionId: 'original-host-session',
      executorSessionId: 'original-executor-session',
      goal: 'Ship the /health endpoint with tests.',
    })

    const { service, client } = await createMockService()
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.restart' as const, selector: { kind: 'exact' as const, name: loopName } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const newState = loopService.getActiveState(loopName)!
    expect(newState).not.toBeNull()
    expect(newState.kind).toBe('goal')
    expect(newState.goal).toBe('Ship the /health endpoint with tests.')
    // The executor binding is repointed at the freshly-created restart session.
    expect(newState.executorSessionId).toBe('new-session-restart')
    expect(newState.sessionId).toBe('new-session-restart')
    // The host redirect target is preserved across restart (not reinterpreted as executor).
    expect(newState.hostSessionId).toBe('original-host-session')

    // The restart prompt went to the new executor session as a code prompt.
    const codePrompt = (client.session.promptAsync as any).mock.calls.find(
      (c: any[]) => c[0]?.agent === 'code' && c[0]?.sessionID === 'new-session-restart',
    )
    expect(codePrompt).toBeDefined()
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

  test('successful same-phase restart (final_auditing preserved) records no transition rows', async () => {
    const loopName = 'success-same-phase-restart'
    insertLoop({
      loopName,
      status: 'stalled',
      terminationReason: 'stall_timeout',
      phase: 'final_auditing',
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
    // Persisted phase equals restart phase (final_auditing), so no phase
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
      buildFinalAuditPrompt: () => 'audit prompt',
      buildContinuationPrompt: () => 'goal restart prompt',
      recordTransition: (name, entry) => loopService.recordTransition(name, entry),
      recordTerminalTransition: (name, entry) => loopService.recordTerminalTransition(name, entry),
      restoreState: (name, state) => loopService.restoreState(name, state),
      getOutstandingFindings: (name, severity) => loopService.getOutstandingFindings(name, severity),
      generateUniqueLoopName: (name) => name,
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
        syncList: async () => {},
      },
      tui: { publish: async () => {}, selectSession: async () => {} },
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        await mutex.acquire()
        try { return await fn() } finally { mutex.release() }
      },
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockWorkspaceStatusRegistryInline = {
      awaitConnected: async () => ({ connected: true }),
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
        generateUniqueLoopName: (...args: any[]) => (mockLoopService.generateUniqueLoopName as any)(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        terminate: terminateSpy,
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      workspaceStatusRegistry: mockWorkspaceStatusRegistryInline as any,
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
