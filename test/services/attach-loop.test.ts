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

const noopFn = () => {}

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

const PROJECT_ID = 'test-project'

describe('attachLoopToSession', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attach-loop-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.exec(DB_SCHEMA)
    db.exec(LOOP_LARGE_FIELDS_SCHEMA)
    db.exec(PLANS_SCHEMA)
    db.exec(REVIEW_FINDINGS_SCHEMA)
    db.exec(SECTION_PLANS_SCHEMA)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  function buildDeps() {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )

    const promptAsyncMock = vi.fn().mockResolvedValue({ error: null })
    const tuiSelectSessionMock = vi.fn().mockResolvedValue(undefined)

    const deps = {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      dataDir: '/tmp',
      v2: {
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'new-session' } }),
          get: vi.fn().mockResolvedValue({ data: {} }),
          promptAsync: promptAsyncMock,
          abort: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          status: vi.fn().mockResolvedValue({ data: {} }),
        },
        tui: {
          publish: vi.fn(),
          selectSession: tuiSelectSessionMock,
        },
      },
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loop: loopService as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(),
        clearLoopTimers: noopFn,
      },
      sandboxManager: null,
      workspaceStatusRegistry: {
        recordEvent: vi.fn(),
        getStatus: vi.fn().mockReturnValue('connected' as const),
        awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
        primeFromSnapshot: vi.fn(),
      },
    }

    return { deps, loopsRepo, plansRepo, sectionPlansRepo, loopService, promptAsyncMock, tuiSelectSessionMock }
  }

  test('disabled mode persists state and sends code-agent prompt', async () => {
    const { deps, loopsRepo, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_abc',
        workspaceId: 'ws_test',
        worktreeDir: '/tmp/wt/abc',
        loopName: 'my-loop',
        displayName: 'My Loop',
        executionName: 'my-loop',
        hostSessionId: 'host-sess',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        maxIterations: 50,
        sandboxEnabled: false,
        planText: '# Test Plan\n\nDo something.',
        selectSession: true,
        selectSessionTiming: 'after-prompt',
        startWatchdog: true,
      },
    )

    expect(result.ok).toBe(true)

    // Verify loop state was persisted
    const state = (deps.loop as any).getActiveState('my-loop')
    expect(state).not.toBeNull()
    expect(state!.sessionId).toBe('sess_abc')
    expect(state!.worktreeDir).toBe('/tmp/wt/abc')
    expect(state!.active).toBe(true)
    expect(state!.phase).toBe('coding')
    expect(state!.maxIterations).toBe(50)

    // Verify code-agent prompt was sent
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
    expect(promptCallArgs.sessionID).toBe('sess_abc')

    // Verify watchdog was started
    expect(deps.loopHandler!.startWatchdog).toHaveBeenCalledWith('my-loop')
  })

  test('onStarted callback is invoked after state persistence', async () => {
    const { deps } = buildDeps()

    const onStartedSpy = vi.fn()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_cb',
        workspaceId: 'ws_cb',
        worktreeDir: '/tmp/wt/cb',
        loopName: 'cb-loop',
        displayName: 'CB Loop',
        executionName: 'cb-loop',
        maxIterations: 25,
        sandboxEnabled: false,
        planText: '# CB Plan\n\nDo things.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
        onStarted: onStartedSpy,
      },
    )

    expect(result.ok).toBe(true)
    expect(onStartedSpy).toHaveBeenCalledTimes(1)
    expect(onStartedSpy).toHaveBeenCalledWith({
      sessionId: 'sess_cb',
      loopName: 'cb-loop',
      displayName: 'CB Loop',
      worktreeDir: '/tmp/wt/cb',
      workspaceId: 'ws_cb',
    })
  })

  test('prompt failure returns ok:false and cleans up state', async () => {
    const { deps, loopsRepo, promptAsyncMock } = buildDeps()

    // Make promptAsync return an error
    promptAsyncMock.mockResolvedValueOnce({ error: new Error('network timeout') })

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_fail',
        workspaceId: 'ws_fail',
        worktreeDir: '/tmp/wt/fail',
        loopName: 'fail-loop',
        displayName: 'Fail Loop',
        executionName: 'fail-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText: '# Fail Plan\n\nWill fail.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('prompt_failed')
    }

    // State should be cleaned up on failure
    const state = (deps.loop as any).getActiveState('fail-loop')
    expect(state).toBeNull()
  })

  test('attachLoopToSession does NOT call loop.deleteState when setState throws because loop already exists', async () => {
    const { deps } = buildDeps()

    const deleteStateSpy = vi.spyOn(deps.loop, 'deleteState')
    ;(deps.loop as any).setState = vi.fn().mockImplementation(() => {
      throw new Error('setState: loop "my-feature" already exists')
    })

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_dup',
        workspaceId: 'ws_dup',
        worktreeDir: '/tmp/wt/dup',
        loopName: 'my-feature',
        displayName: 'My Feature',
        executionName: 'my-feature',
        maxIterations: 50,
        sandboxEnabled: false,
        planText: '# Plan\n\nAlready exists.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('already_attached')
    }

    expect(deleteStateSpy).not.toHaveBeenCalled()
  })

  test('attachLoopToSession clears terminal loop row before re-attaching (cancelled)', async () => {
    const { deps, loopsRepo, loopService } = buildDeps()

    // Pre-seed a terminal loop row.
    const baseState = {
      active: false,
      sessionId: 'sess_old',
      loopName: 'reusable-loop',
      worktreeDir: '/tmp/wt/old',
      projectDir: '/tmp/test',
      iteration: 5,
      maxIterations: 50,
      startedAt: new Date(Date.now() - 100000).toISOString(),
      phase: 'coding' as const,
      worktree: true,
      auditCount: 0,
      errorCount: 0,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      sandbox: false,
    }
    loopService.setState('reusable-loop', baseState as any)
    loopService.setStatus('reusable-loop', 'cancelled')

    const existingBefore = loopsRepo.get(PROJECT_ID, 'reusable-loop')
    expect(existingBefore?.status).toBe('cancelled')

    const deleteStateSpy = vi.spyOn(deps.loop, 'deleteState')

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_new',
        workspaceId: 'ws_new',
        worktreeDir: '/tmp/wt/new',
        loopName: 'reusable-loop',
        displayName: 'Reusable Loop',
        executionName: 'reusable-loop',
        maxIterations: 50,
        sandboxEnabled: false,
        planText: '# Plan\n\nRevive me.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(deleteStateSpy).toHaveBeenCalledWith('reusable-loop')
    expect(result.ok).toBe(true)
    // Re-inserted with the new session.
    const after = loopsRepo.get(PROJECT_ID, 'reusable-loop')
    expect(after?.currentSessionId).toBe('sess_new')
    expect(after?.status).toBe('running')
  })

  test('attachLoopToSession returns already_attached when existing row is running', async () => {
    const { deps, loopService } = buildDeps()

    loopService.setState('live-loop', {
      active: true,
      sessionId: 'sess_existing',
      loopName: 'live-loop',
      worktreeDir: '/tmp/wt/live',
      projectDir: '/tmp/test',
      iteration: 1,
      maxIterations: 50,
      startedAt: new Date().toISOString(),
      phase: 'coding',
      worktree: true,
      auditCount: 0,
      errorCount: 0,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      sandbox: false,
    } as any)

    const deleteStateSpy = vi.spyOn(deps.loop, 'deleteState')

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_duplicate',
        workspaceId: 'ws_x',
        worktreeDir: '/tmp/wt/live',
        loopName: 'live-loop',
        displayName: 'Live Loop',
        executionName: 'live-loop',
        maxIterations: 50,
        sandboxEnabled: false,
        planText: '# Plan',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('already_attached')
    }
    expect(deleteStateSpy).not.toHaveBeenCalled()
  })

  test('attach extracts sections via phase headings', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = [
      '## Phase 1: Setup',
      '### Files',
      '- package.json',
      'Install dependencies.',
      '## Phase 2: Build',
      '### Files',
      '- src/index.ts',
      'Compile project.',
    ].join('\n')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_sections',
        workspaceId: 'ws_sections',
        worktreeDir: '/tmp/wt/sections',
        loopName: 'sections-loop',
        displayName: 'Sections Loop',
        executionName: 'sections-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText,
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    const state = (deps.loop as any).getActiveState('sections-loop')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('coding')
    expect(state!.currentSectionIndex).toBe(0)
    expect(state!.totalSections).toBe(2)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
  })

  test('attach ignores legacy section markers around phase headings', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = [
      '# Plan',
      '<!-- forge-section:start -->',
      '## Phase 1: Setup',
      'Install deps.',
      '<!-- forge-section:end -->',
      '<!-- forge-section:start -->',
      '## Phase 2: Build',
      'Compile.',
      '<!-- forge-section:end -->',
    ].join('\n')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_phase',
        workspaceId: 'ws_phase',
        worktreeDir: '/tmp/wt/phase',
        loopName: 'phase-loop',
        displayName: 'Phase Loop',
        executionName: 'phase-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText,
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    const state = (deps.loop as any).getActiveState('phase-loop')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('coding')
    expect(state!.currentSectionIndex).toBe(0)
    expect(state!.totalSections).toBe(2)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
  })

  test('attach falls back to single raw-plan dispatch when no markers and no phase headings', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = '# Simple Plan\n\nDo some stuff without phases.'

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_raw',
        workspaceId: 'ws_raw',
        worktreeDir: '/tmp/wt/raw',
        loopName: 'raw-loop',
        displayName: 'Raw Loop',
        executionName: 'raw-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText,
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    const state = (deps.loop as any).getActiveState('raw-loop')
    expect(state).not.toBeNull()
    expect(state!.totalSections).toBe(0)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
    expect(promptCallArgs.parts[0].text).toContain(planText)
  })

  test('attach no longer creates a decomposer session', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_nodecomp',
        workspaceId: 'ws_nodecomp',
        worktreeDir: '/tmp/wt/nodecomp',
        loopName: 'nodecomp-loop',
        displayName: 'No Decomposer Loop',
        executionName: 'nodecomp-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText: '# Plan\n\nSimple plan.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: true,
      },
    )

    expect(result.ok).toBe(true)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
    expect(promptCallArgs.sessionID).toBe('sess_nodecomp')

    const state = (deps.loop as any).getActiveState('nodecomp-loop')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('coding')
  })
})
