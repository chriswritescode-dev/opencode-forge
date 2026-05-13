import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
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

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-restart-test-'))
    db = new Database(join(tempDir, 'test.db'))

    db.exec(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
        session_directory    TEXT,
        worktree_branch      TEXT,
        project_dir          TEXT NOT NULL,
        max_iterations       INTEGER NOT NULL,
        iteration            INTEGER NOT NULL DEFAULT 0,
        audit_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        phase                TEXT NOT NULL,
        execution_model      TEXT,
        auditor_model        TEXT,
        model_failed         INTEGER NOT NULL DEFAULT 0,
        sandbox              INTEGER NOT NULL DEFAULT 0,
        sandbox_container    TEXT,
        started_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        termination_reason   TEXT,
        completion_summary   TEXT,
        workspace_id         TEXT,
        host_session_id      TEXT,
        audit_session_id     TEXT,
        decomposition_status TEXT NOT NULL DEFAULT 'pending' CHECK (decomposition_status IN ('pending','running','completed','failed','skipped')),
        decomposition_mode TEXT NOT NULL DEFAULT 'agent' CHECK (decomposition_mode IN ('agent','deterministic')),
        decomposition_session_id TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections INTEGER NOT NULL DEFAULT 0,
        final_audit_done INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.exec(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.exec(`
      CREATE TABLE plans (
        project_id   TEXT NOT NULL,
        loop_name    TEXT,
        session_id   TEXT,
        content      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
        CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
        UNIQUE (project_id, loop_name),
        UNIQUE (project_id, session_id)
      )
    `)

    db.exec(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)

    db.exec(`
      CREATE TABLE section_plans (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        summary_done TEXT,
        summary_deviations TEXT,
        summary_follow_ups TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index)
      )
    `)

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
    decompositionStatus: string
    decompositionMode: string
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
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
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
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: opts.terminationReason,
      completionSummary: null,
      workspaceId: opts.workspaceId,
      hostSessionId: null,
      decompositionStatus: opts.decompositionStatus as any,
      decompositionMode: opts.decompositionMode as any,
      decompositionSessionId: null,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      finalAuditDone: 0,
    }, { prompt: 'test plan text', lastAuditResult: null })
  }

  test('restart from stall_timeout resumes at persisted section/iteration with coding phase', async () => {
    insertLoop({
      loopName: 'stall-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 2,
      iteration: 4,
      totalSections: 5,
      decompositionStatus: 'completed',
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
      buildDecomposerInitialPrompt: () => 'decompose prompt',
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      generateUniqueLoopName: () => 'stall-loop',
    }

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: 'new-session-123' } }),
        get: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
    }

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
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
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

    expect(result.data.iteration).toBe(4)
    expect(result.data.loopName).toBe('stall-loop')
    expect(result.data.sessionId).toBe('new-session-123')
    expect(result.data.previousSessionId).toBe('session-old')

    const newState = loopService.getActiveState('stall-loop')!
    expect(newState).not.toBeNull()
    expect(newState.phase).toBe('coding')
    expect(newState.currentSectionIndex).toBe(2)
    expect(newState.iteration).toBe(4)
    expect(newState.totalSections).toBe(5)

    expect(buildSectionInitialPromptSpy).toHaveBeenCalledTimes(1)
    expect(buildFinalAuditPromptSpy).not.toHaveBeenCalled()
  })

  test('restart from stall_timeout does not reset iteration to 0', async () => {
    insertLoop({
      loopName: 'iter-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 1,
      iteration: 7,
      totalSections: 3,
      decompositionStatus: 'completed',
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
      buildDecomposerInitialPrompt: () => 'decompose prompt',
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      generateUniqueLoopName: () => 'iter-loop',
    }

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: 'new-sess-456' } }),
        get: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
    }

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
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
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

    expect(result.data.iteration).toBe(7)

    const newState = loopService.getActiveState('iter-loop')!
    expect(newState.iteration).toBe(7)
    expect(newState.currentSectionIndex).toBe(1)
    expect(newState.phase).toBe('coding')
  })

  test('restart from stall_timeout routes to final_auditing when persisted phase is final_auditing', async () => {
    insertLoop({
      loopName: 'final-audit-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      currentSectionIndex: 5,
      iteration: 6,
      totalSections: 5,
      decompositionStatus: 'completed',
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
      buildDecomposerInitialPrompt: () => 'decompose prompt',
      buildSectionInitialPrompt: buildSectionInitialPromptSpy,
      buildFinalAuditPrompt: buildFinalAuditPromptSpy,
      generateUniqueLoopName: () => 'final-audit-loop',
    }

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: 'new-sess-789' } }),
        get: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
    }

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
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
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

  test('restart worktree agent decomposer warps new session to workspace', async () => {
    insertLoop({
      loopName: 'wt-agent-loop',
      status: 'stalled',
      terminationReason: 'stall_timeout',
      decompositionStatus: 'running',
      decompositionMode: 'agent',
      worktree: true,
      workspaceId: 'wrk_1',
    })

    const noopFn = () => {}

    const warpCalls: Array<Record<string, unknown>> = []
    const promptAsyncCalls: Array<Record<string, unknown>> = []

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: 'new-sess-wt' } }),
        get: async () => ({ data: {} }),
        promptAsync: async (args: Record<string, unknown>) => {
          promptAsyncCalls.push(args)
          return {}
        },
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          list: async () => ({ data: [] }),
          remove: async () => ({}),
          warp: async (args: Record<string, unknown>) => {
            warpCalls.push(args)
            return { data: {} }
          },
        },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
    }

    const mockLoopService: Partial<LoopService> = {
      listActive: () => loopService.listActive(),
      listRecent: () => loopService.listRecent(),
      getActiveState: (name) => loopService.getActiveState(name),
      getAnyState: (name) => loopService.getAnyState(name),
      registerLoopSession: noopFn,
      setState: (name, state) => loopService.setState(name, state),
      deleteState: (name) => loopService.deleteState(name),
      setPhase: noopFn,
      buildDecomposerInitialPrompt: () => 'decompose prompt',
      buildSectionInitialPrompt: () => 'section prompt',
      buildFinalAuditPrompt: () => 'audit prompt',
      generateUniqueLoopName: () => 'wt-agent-loop',
    }

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
        decomposer: { enabled: true, mode: 'agent' },
      },
      logger: mockLogger,
      dataDir: '/tmp',
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.restart' as const,
        selector: { kind: 'exact' as const, name: 'wt-agent-loop' },
      },
    )

    expect(result.ok).toBe(true)

    expect(warpCalls.length).toBe(1)
    expect(warpCalls[0]).toEqual({ id: 'wrk_1', sessionID: 'new-sess-wt' })

    expect(promptAsyncCalls.length).toBeGreaterThan(0)
    expect(promptAsyncCalls[0].agent).toBe('decomposer')
  })

  test('restart commits new current_session_id BEFORE runExclusive releases (no stale-event race)', async () => {
    insertLoop({
      loopName: 'race-loop',
      phase: 'auditing',
      decompositionStatus: 'completed',
      totalSections: 0,
      iteration: 1,
      status: 'stalled',
      terminationReason: 'stall_timeout',
    })

    const noopFn = () => {}

    const mockV2Client = {
      session: {
        create: async () => ({ data: { id: 'race-new-session' } }),
        get: async () => ({ data: {} }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
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
      buildDecomposerInitialPrompt: () => 'decompose prompt',
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
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
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
      decompositionStatus: 'completed',
      totalSections: 0,
      iteration: 2,
      status: 'running',
      terminationReason: null,
      active: true,
    })

    const noopFn = () => {}

    const createCalls: Array<Record<string, unknown>> = []
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const abortCalls: Array<Record<string, unknown>> = []

    const mockV2Client = {
      session: {
        create: async (args: Record<string, unknown>) => {
          createCalls.push(args)
          return { data: { id: 'new-code-session' } }
        },
        get: async () => ({ data: {} }),
        promptAsync: async (args: Record<string, unknown>) => {
          promptAsyncCalls.push(args)
          return {}
        },
        abort: async (args: Record<string, unknown>) => {
          abortCalls.push(args)
          return {}
        },
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
      tui: { publish: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
    }

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
      buildDecomposerInitialPrompt: () => 'decompose prompt',
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
      v2: mockV2Client as any,
      plansRepo,
      loopsRepo,
      loop: mockLoopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
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
    expect(createCalls.length).toBe(1)
    expect(promptAsyncCalls.length).toBe(1)

    // Prompt sent with code agent to new session
    expect(promptAsyncCalls[0].agent).toBe('code')
    expect(promptAsyncCalls[0].sessionID).toBe('new-code-session')

    // At the moment runExclusive released, new session is registered and old is gone
    expect(capturedResolvedNew).toBe('audit-restart-loop')
    expect(capturedResolvedOld).toBeNull()
    expect(capturedPhase).toBe('coding')

    // Exactly one abort for the old session
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0].sessionID).toBe('session-old')
  })
})
