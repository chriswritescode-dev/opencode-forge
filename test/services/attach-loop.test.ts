import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
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
  execution_variant    TEXT,
  auditor_variant      TEXT,
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

    const promptAsyncMock = mock(async () => ({ error: null }))
    const tuiSelectSessionMock = mock(async () => undefined)

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
          create: mock(async () => ({ data: { id: 'new-session' } })),
          get: mock(async () => ({ data: {} })),
          update: mock(async () => ({ data: {} })),
          promptAsync: promptAsyncMock,
          abort: mock(async () => ({})),
          delete: mock(async () => ({})),
          messages: mock(async () => ({ data: [] })),
          status: mock(async () => ({ data: {} })),
        },
        tui: {
          publish: mock(() => {}),
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
        startWatchdog: mock(() => {}),
        clearLoopTimers: noopFn,
      },
      sandboxManager: null,
      workspaceStatusRegistry: {
        recordEvent: mock(() => {}),
        getStatus: mock(() => 'connected' as const),
        awaitConnected: mock(async () => ({ connected: true, elapsedMs: 0, source: 'cached' as const })),
        primeFromSnapshot: mock(() => {}),
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

    const onStartedSpy = mock(() => {})

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
    promptAsyncMock.mockImplementationOnce(async () => ({ error: new Error('network timeout') }))

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

    let deleteStateCalled = false
    const originalDeleteState = deps.loop.deleteState.bind(deps.loop)
    deps.loop.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

    ;(deps.loop as any).setState = mock((...args: any[]) => {
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

    expect(deleteStateCalled).toBe(false)
  })

  test('attachLoopToSession refuses terminal loop row without deleting state', async () => {
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
      status: 'cancelled' as const,
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

    let deleteStateCalled = false
    const originalDeleteState = deps.loop.deleteState.bind(deps.loop)
    deps.loop.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

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

    expect(deleteStateCalled).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('conflict')
      expect(result.message).toContain('Use loop restart')
    }
    const after = loopsRepo.get(PROJECT_ID, 'reusable-loop')
    expect(after?.currentSessionId).toBe('sess_old')
    expect(after?.status).toBe('cancelled')
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
      status: 'running' as const,
      worktree: true,
      auditCount: 0,
      errorCount: 0,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      sandbox: false,
    } as any)

    let deleteStateCalled = false
    const originalDeleteState = deps.loop.deleteState.bind(deps.loop)
    deps.loop.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

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
    expect(deleteStateCalled).toBe(false)
  })

  test('attach extracts sections via forge-section markers', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = [
      '<!-- forge-section -->',
      '## Setup',
      '### Files',
      '- package.json',
      'Install dependencies.',
      '<!-- forge-section -->',
      '## Build',
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

  test('attach falls back to single-prompt mode when no forge-section markers present', async () => {
    const { deps, loopService, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = [
      '# Plan',
      '## Phase 1: Setup',
      'Install deps.',
      '## Phase 2: Build',
      'Compile.',
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
    expect(state!.totalSections).toBe(0)
    // The prompt sent to the code agent equals the raw plan text (legacy single-prompt mode)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.parts[0].text).toBe(planText)
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

  test('attachLoopToSession does NOT call session.update for permission repair on any surface', async () => {
    const surfaces: Array<'tui' | 'tool' | 'approval-hook'> = ['tui', 'tool', 'approval-hook']
    for (const surface of surfaces) {
      const { deps } = buildDeps()
      const sessionUpdateMock = deps.v2.session.update
      const { attachLoopToSession } = await import('../../src/services/execution')
      await attachLoopToSession(
        deps as any,
        { surface, projectId: PROJECT_ID, directory: '/tmp/test' },
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
          selectSession: surface === 'tui',
          selectSessionTiming: 'after-prompt',
          startWatchdog: true,
        },
      )
      // Assert: session.update was NEVER called (no permission repair)
      expect(sessionUpdateMock).not.toHaveBeenCalled()
    }
  })

  test('attachLoopToSession persists execution and auditor variants', async () => {
    const { deps, loopsRepo } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_variant',
        workspaceId: 'ws_variant',
        worktreeDir: '/tmp/wt/variant',
        loopName: 'variant-loop',
        displayName: 'Variant Loop',
        executionName: 'variant-loop',
        hostSessionId: 'host-variant',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
        maxIterations: 50,
        sandboxEnabled: false,
        planText: '# Variant Plan\n\nDo things.',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    // Verify loop state was persisted with variants
    const state = (deps.loop as any).getActiveState('variant-loop')
    expect(state).not.toBeNull()
    expect(state!.sessionId).toBe('sess_variant')
    expect(state!.executionVariant).toBe('thinking-max')
    expect(state!.auditorVariant).toBe('audit-high')

    // Verify DB row contains variants
    const row = loopsRepo.get(PROJECT_ID, 'variant-loop')
    expect(row).not.toBeNull()
    expect(row!.executionVariant).toBe('thinking-max')
    expect(row!.auditorVariant).toBe('audit-high')
  })

  test('plan with Skills: line prepends skill directive to prompt', async () => {
    const { deps, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = '# Skill Plan\n\nSkills: tdd\n\nDo something with TDD.'

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_skill',
        workspaceId: 'ws_skill',
        worktreeDir: '/tmp/wt/skill',
        loopName: 'skill-loop',
        displayName: 'Skill Loop',
        executionName: 'skill-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText,
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    // The prompt sent to the code agent should include the skill directive
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('code')
    const promptText = promptCallArgs.parts[0].text
    expect(promptText).toContain('## Attached skills')
    expect(promptText).toContain('`tdd`')
    // The original plan text should still be present after the directive
    expect(promptText).toContain('# Skill Plan')
  })

  test('plan without Skills: line does not include skill directive', async () => {
    const { deps, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const planText = '# No Skill Plan\n\nDo something without skills.'

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_noskill',
        workspaceId: 'ws_noskill',
        worktreeDir: '/tmp/wt/noskill',
        loopName: 'noskill-loop',
        displayName: 'No Skill Loop',
        executionName: 'noskill-loop',
        maxIterations: 10,
        sandboxEnabled: false,
        planText,
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    expect(result.ok).toBe(true)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    const promptText = promptCallArgs.parts[0].text
    expect(promptText).not.toContain('## Attached skills')
    // The original plan text should be present unchanged
    expect(promptText).toContain('# No Skill Plan')
  })
})
