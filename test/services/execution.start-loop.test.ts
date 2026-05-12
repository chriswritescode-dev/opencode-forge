import { describe, test, expect, beforeEach, vi } from 'vitest'
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

const DB_SCHEMA = `
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
  decomposition_mode   TEXT NOT NULL DEFAULT 'agent' CHECK (decomposition_mode IN ('agent','deterministic')),
  decomposition_session_id TEXT,
  current_section_index INTEGER NOT NULL DEFAULT 0,
  total_sections       INTEGER NOT NULL DEFAULT 0,
  final_audit_done     INTEGER NOT NULL DEFAULT 0,
  final_audit_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, loop_name)
)
`

const LOOP_LARGE_FIELDS_SCHEMA = `
CREATE TABLE loop_large_fields (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  prompt              TEXT,
  last_audit_result   TEXT,
  PRIMARY KEY (project_id, loop_name),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
)
`

const PLANS_SCHEMA = `
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
`

const REVIEW_FINDINGS_SCHEMA = `
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
`

const SECTION_PLANS_SCHEMA = `
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
`

describe('handleStartLoop builtin worktree workspace', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopService: LoopService

  const noopFn = () => {}

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-start-loop-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS_SCHEMA)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)

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

  test('creates builtin worktree workspace and session bound to it for mode=worktree', async () => {
    const experimentalWorkspaceCreateMock = vi.fn().mockResolvedValue({
      data: {
        id: 'ws_test',
        directory: '/tmp/wt/abc',
        branch: 'opencode/abc',
        type: 'worktree',
        name: 'opencode/abc',
        extra: null,
        projectID: PROJECT_ID,
        timeUsed: Date.now(),
      },
    })
    const experimentalWorkspaceWarpMock = vi.fn().mockResolvedValue({})
    const sessionCreateMock = vi.fn().mockResolvedValue({
      data: { id: 'session_test' },
    })
    const sessionGetMock = vi.fn().mockResolvedValue({ data: {} })
    const tuiSelectSessionMock = vi.fn().mockResolvedValue({})
    const worktreeCreateMock = vi.fn().mockResolvedValue({
      data: { directory: '/tmp/wt/abc', branch: 'opencode/abc' },
    })

    const mockV2Client = {
      session: {
        create: sessionCreateMock,
        get: sessionGetMock,
        promptAsync: async () => ({ error: null }),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          create: experimentalWorkspaceCreateMock,
          warp: experimentalWorkspaceWarpMock,
          remove: vi.fn().mockResolvedValue({}),
          list: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      tui: {
        publish: async () => {},
        selectSession: tuiSelectSessionMock,
      },
      worktree: {
        create: worktreeCreateMock,
        remove: async () => {},
      },
    }

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      isLiveByName: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        mode: 'worktree' as const,
        lifecycle: { selectSession: true },
      },
    )

    expect(result.ok).toBe(true)

    // Assert: experimental.workspace.create was called (builtin worktree path)
    expect(experimentalWorkspaceCreateMock).toHaveBeenCalledTimes(1)
    expect(experimentalWorkspaceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'forge', branch: null, extra: { loopName: 'test-plan', projectDirectory: expect.any(String) } }),
    )

    // Assert: old v2.worktree.create was NOT called
    expect(worktreeCreateMock).not.toHaveBeenCalled()

    // Assert: session was created with correct directory and workspaceId
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)
    const sessionCallArgs = sessionCreateMock.mock.calls[0][0]
    expect(sessionCallArgs.directory).toBe('/tmp/wt/abc')
    expect(sessionCallArgs.workspaceID).toBe('ws_test')

    // Assert: warp was called
    expect(experimentalWorkspaceWarpMock).toHaveBeenCalledTimes(1)
    expect(tuiSelectSessionMock).toHaveBeenCalledWith({ sessionID: 'session_test' })
    expect(experimentalWorkspaceWarpMock.mock.invocationCallOrder[0]).toBeLessThan(
      tuiSelectSessionMock.mock.invocationCallOrder[0],
    )

    // Assert: loops state has workspace info
    if (!result.ok) return
    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    expect(state!.workspaceId).toBe('ws_test')
    expect(state!.worktreeDir).toBe('/tmp/wt/abc')
    expect(state!.worktreeBranch).toBe('opencode/abc')
  })

  test('hard-fails when sandbox manager is missing', async () => {
    const experimentalWorkspaceCreateMock = vi.fn().mockResolvedValue({
      data: {
        id: 'ws_test',
        directory: '/tmp/wt/abc',
        branch: 'opencode/abc',
        type: 'worktree',
        name: 'opencode/abc',
        extra: null,
        projectID: PROJECT_ID,
        timeUsed: Date.now(),
      },
    })

    const mockV2Client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session_test' } }),
        get: vi.fn().mockResolvedValue({ data: {} }),
        promptAsync: async () => ({ error: null }),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          create: experimentalWorkspaceCreateMock,
          warp: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
          list: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      tui: {
        publish: async () => {},
        selectSession: vi.fn().mockResolvedValue({}),
      },
      worktree: {
        create: vi.fn().mockResolvedValue({ data: { directory: '/tmp/wt/abc', branch: 'opencode/abc' } }),
        remove: async () => {},
      },
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      // No sandboxManager passed — simulates Docker not available
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        mode: 'worktree' as const,
        lifecycle: { selectSession: true },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Sandbox required')
  })

  test('hard-fails when sandbox start throws docker-unavailable', async () => {
    const experimentalWorkspaceCreateMock = vi.fn().mockResolvedValue({
      data: {
        id: 'ws_test',
        directory: '/tmp/wt/abc',
        branch: 'opencode/abc',
        type: 'worktree',
        name: 'opencode/abc',
        extra: null,
        projectID: PROJECT_ID,
        timeUsed: Date.now(),
      },
    })

    const mockV2Client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session_test' } }),
        get: vi.fn().mockResolvedValue({ data: {} }),
        promptAsync: async () => ({ error: null }),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          create: experimentalWorkspaceCreateMock,
          warp: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
          list: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      tui: {
        publish: async () => {},
        selectSession: vi.fn().mockResolvedValue({}),
      },
      worktree: {
        create: vi.fn().mockResolvedValue({ data: { directory: '/tmp/wt/abc', branch: 'opencode/abc' } }),
        remove: async () => {},
      },
    }

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockRejectedValue(new Error('Docker is not available. Please ensure Docker is running.')),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      isLiveByName: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        mode: 'worktree' as const,
        lifecycle: { selectSession: true },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Failed to start sandbox')
  })
})

describe('handleStartLoop concurrent-start dedupe', () => {
  const noopFn = () => {}

  function buildDedupeMocks() {
    const experimentalWorkspaceCreateMock = vi.fn().mockResolvedValue({
      data: {
        id: 'ws_test',
        directory: '/tmp/wt/abc',
        branch: 'opencode/abc',
        type: 'worktree',
        name: 'opencode/abc',
        extra: null,
        projectID: PROJECT_ID,
        timeUsed: Date.now(),
      },
    })
    const experimentalWorkspaceWarpMock = vi.fn().mockResolvedValue({})
    const sessionCreateMock = vi.fn().mockResolvedValue({
      data: { id: 'session_test' },
    })
    const sessionGetMock = vi.fn().mockResolvedValue({ data: {} })
    const tuiSelectSessionMock = vi.fn().mockResolvedValue({})
    const worktreeCreateMock = vi.fn().mockResolvedValue({
      data: { directory: '/tmp/wt/abc', branch: 'opencode/abc' },
    })

    const mockV2Client = {
      session: {
        create: sessionCreateMock,
        get: sessionGetMock,
        promptAsync: async () => ({ error: null }),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          create: experimentalWorkspaceCreateMock,
          warp: experimentalWorkspaceWarpMock,
          remove: vi.fn().mockResolvedValue({}),
          list: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      tui: {
        publish: async () => {},
        selectSession: tuiSelectSessionMock,
      },
      worktree: {
        create: worktreeCreateMock,
        remove: async () => {},
      },
    }

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      isLiveByName: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    return {
      mockV2Client,
      mockLoopHandler,
      mockSandboxManager,
      experimentalWorkspaceCreateMock,
      experimentalWorkspaceWarpMock,
      sessionCreateMock,
      tuiSelectSessionMock,
    }
  }

  test('two concurrent calls with same source produce only one workspace + session', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-concurrent-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Dedupe Plan\n\nTest plan for dedupe.' },
      mode: 'worktree' as const,
      lifecycle: { selectSession: true },
      hostSessionId: 'host-1',
    }

    const [r1, r2] = await Promise.all([
      service.dispatch(ctx, command),
      service.dispatch(ctx, command),
    ])

    // With dedupe implemented: exactly 1 workspace/session/warp creation per concurrent batch
    expect(mocks.experimentalWorkspaceCreateMock).toHaveBeenCalledTimes(1)
    expect(mocks.sessionCreateMock).toHaveBeenCalledTimes(1)
    expect(mocks.experimentalWorkspaceWarpMock).toHaveBeenCalledTimes(1)

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    if (!r1.ok || !r2.ok) return

    // At least one result should be flagged as deduped; both share the same sessionId/loopName
    const dedupedResults = [r1, r2].filter(r => (r.data as any).deduped === true)
    const realResult = [r1, r2].find(r => !(r.data as any).deduped)
    expect(dedupedResults.length).toBe(1)
    expect(realResult).toBeDefined()

    db.close()
  })

  test('different source sessions do not dedupe each other', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-diffsource-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd1 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Alpha\n\nDifferent plan A.' },
      mode: 'worktree' as const,
      lifecycle: { selectSession: true },
      hostSessionId: 'host-A',
    }
    const cmd2 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Beta\n\nDifferent plan B.' },
      mode: 'worktree' as const,
      lifecycle: { selectSession: true },
      hostSessionId: 'host-B',
    }

    const [r1, r2] = await Promise.all([
      service.dispatch(ctx, cmd1),
      service.dispatch(ctx, cmd2),
    ])

    // Different sources: no dedupe; both proceed independently
    expect(mocks.experimentalWorkspaceCreateMock).toHaveBeenCalledTimes(2)
    expect(mocks.sessionCreateMock).toHaveBeenCalledTimes(2)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    if (!r1.ok || !r2.ok) return
    expect(r1.data.loopName).not.toBe(r2.data.loopName)

    db.close()
  })

  test('sequential second call after first completes is not deduped', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-seq-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Sequential Plan\n\nSequential test.' },
      mode: 'worktree' as const,
      lifecycle: { selectSession: true },
      hostSessionId: 'host-seq',
    }

    await service.dispatch(ctx, cmd)
    const second = await service.dispatch(ctx, cmd)

    // Sequential: first completed, in-flight entry cleared, so no dedupe
    expect(mocks.experimentalWorkspaceCreateMock).toHaveBeenCalledTimes(2)
    expect(mocks.sessionCreateMock).toHaveBeenCalledTimes(2)
    expect(second.ok).toBe(true)

    db.close()
  })
})

describe('handleStartLoop select-session ordering', () => {
  const noopFn = () => {}

  function buildOrderingMocks() {
    const experimentalWorkspaceCreateMock = vi.fn().mockResolvedValue({
      data: {
        id: 'ws_test', directory: '/tmp/wt/abc', branch: 'opencode/abc',
        type: 'worktree', name: 'opencode/abc', extra: null,
        projectID: PROJECT_ID, timeUsed: Date.now(),
      },
    })
    const experimentalWorkspaceWarpMock = vi.fn().mockResolvedValue({})
    const sessionCreateMock = vi.fn().mockResolvedValue({ data: { id: 'session_test' } })
    const sessionGetMock = vi.fn().mockResolvedValue({ data: {} })

    // Deferred pattern: control when selectSession resolves or rejects
    let resolveSelect!: (value?: unknown) => void
    let rejectSelect!: (reason?: unknown) => void
    const selectPromise = new Promise<void>((resolve, reject) => {
      resolveSelect = () => { resolve(); }
      rejectSelect = (reason) => { reject(reason); }
    })
    const tuiSelectSessionMock = vi.fn().mockImplementation(() => selectPromise)

    const worktreeCreateMock = vi.fn().mockResolvedValue({
      data: { directory: '/tmp/wt/abc', branch: 'opencode/abc' },
    })

    const mockV2Client = {
      session: {
        create: sessionCreateMock, get: sessionGetMock,
        promptAsync: async () => ({ error: null }),
        abort: async () => ({}), delete: async () => ({}),
        messages: async () => ({ data: [] }), status: async () => ({ data: {} }),
      },
      experimental: {
        workspace: {
          create: experimentalWorkspaceCreateMock, warp: experimentalWorkspaceWarpMock,
          remove: vi.fn().mockResolvedValue({}), list: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      tui: { publish: async () => {}, selectSession: tuiSelectSessionMock },
      worktree: { create: worktreeCreateMock, remove: async () => {} },
    }

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn, clearLoopTimers: noopFn,
    }

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null), isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false), isLiveByName: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0), restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    return { mockV2Client, mockLoopHandler, mockSandboxManager, tuiSelectSessionMock, resolveSelect, rejectSelect, selectPromise }
  }

  test('onStarted fires only after selectSessionWithFallback resolves', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-resolve-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    let onStartedTs: number | null = null
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Order Plan\n\nTest ordering.' },
        mode: 'worktree' as const,
        lifecycle: {
          selectSession: true,
          onStarted: (info) => { onStartedTs = Date.now() },
        },
      },
    )

    // Allow session creation to proceed but don't resolve selectSession yet
    await new Promise(r => setTimeout(r, 100))

    // At this point, with the fix in place, onStarted should NOT have fired yet
    // because selectSession hasn't resolved
    const beforeResolveTs = Date.now()

    // Now resolve the deferred selectSession
    mocks.resolveSelect!()
    const selectResolvedTs = Date.now()

    await resultPromise

    expect(onStartedTs).not.toBeNull()
    expect(onStartedTs!).toBeGreaterThanOrEqual(selectResolvedTs - 5)

    db.close()
  })

  test('onStarted still fires if selectSession rejects', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-reject-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    let onStartedCalled = false
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Reject Plan\n\nTest rejection.' },
        mode: 'worktree' as const,
        lifecycle: {
          selectSession: true,
          onStarted: () => { onStartedCalled = true },
        },
      },
    )

    // Wait a bit then reject the selectSession promise
    await new Promise(r => setTimeout(r, 50))
    mocks.rejectSelect!(new Error('TUI connection lost'))
    
    const result = await resultPromise

    expect(result.ok).toBe(true)
    expect(onStartedCalled).toBe(true)

    db.close()
  })

  test('onStarted fires after a bounded timeout if selectSession hangs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-timeout-'))
    const db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA); db.exec(LOOP_LARGE_FIELDS_SCHEMA); db.exec(PLANS_SCHEMA); db.exec(REVIEW_FINDINGS_SCHEMA); db.exec(SECTION_PLANS_SCHEMA)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp', v2: mocks.mockV2Client as any,
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
    })

    let onStartedCalled = false
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Timeout Plan\n\nTest timeout.' },
        mode: 'worktree' as const,
        lifecycle: {
          selectSession: true,
          onStarted: () => { onStartedCalled = true },
        },
      },
    )

    // The selectSession mock never resolves — it hangs forever.
    // After the fix, a bounded timeout will kick in (SELECT_TIMEOUT_MS).
    // We wait long enough to see if onStarted fires within that window.
    const elapsed = Date.now()
    const result = await resultPromise
    const totalElapsed = Date.now() - elapsed

    expect(result.ok).toBe(true)
    expect(onStartedCalled).toBe(true)

    // Should have completed reasonably quickly (within timeout budget + some margin)
    expect(totalElapsed).toBeLessThan(5000)

    db.close()
  })
})
