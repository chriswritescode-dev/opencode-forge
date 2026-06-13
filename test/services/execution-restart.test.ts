import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
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

describe('handleLoopRestart from stall_timeout', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
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
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
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
      loop: mockLoopService as any,
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
      loop: mockLoopService as any,
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
      loop: mockLoopService as any,
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
      loop: mockLoopService as any,
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
      loop: mockLoopService as any,
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
      loop: mockLoopService as any,
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
})

describe('handleLoopRestart restartability rules', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopService: LoopService

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-restart-rules-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
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

  async function createMockService(opts?: { sandboxManager?: unknown }) {
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
      loop: mockLoopService as any,
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
})
