import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
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
import { createFakeForgeClient } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const noopFn = () => {}

const PROJECT_ID = 'test-project'

describe('attachLoopToSession', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attach-loop-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
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

    const promptAsyncMock = vi.fn(async () => {})
    const tuiSelectSessionMock = vi.fn(async () => undefined)

    const fakeClient = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session' }),
        promptAsync: promptAsyncMock,
      },
      tui: {
        selectSession: tuiSelectSessionMock,
      },
    })

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
      client: fakeClient.client,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loop: {
        service: loopService,
        listActive: (...args: any[]) => loopService.listActive(...args),
        generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
        findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
      } as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(() => {}),
        clearLoopTimers: noopFn,
      },
      sandboxManager: null,
      workspaceStatusRegistry: {
        recordEvent: vi.fn(() => {}),
        getStatus: vi.fn(() => 'connected' as const),
        awaitConnected: vi.fn(async () => ({ connected: true, elapsedMs: 0, source: 'cached' as const })),
        primeFromSnapshot: vi.fn(() => {}),
      },
    }

    return { deps, loopsRepo, plansRepo, sectionPlansRepo, loopService, promptAsyncMock, tuiSelectSessionMock, fakeClient }
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
    const state = (deps.loop.service as any).getActiveState('my-loop')
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

    const onStartedSpy = vi.fn(() => {})

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

    // Make promptAsync throw an error (port contract: throws on failure)
    promptAsyncMock.mockImplementationOnce(async () => { throw new Error('network timeout') })

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
    const state = (deps.loop.service as any).getActiveState('fail-loop')
    expect(state).toBeNull()
  })

  test('attachLoopToSession does NOT call loop.deleteState when setState throws because loop already exists', async () => {
    const { deps } = buildDeps()

    let deleteStateCalled = false
    const originalDeleteState = deps.loop.service.deleteState.bind(deps.loop.service)
    deps.loop.service.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

    ;(deps.loop.service as any).setState = vi.fn((...args: any[]) => {
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
    const originalDeleteState = deps.loop.service.deleteState.bind(deps.loop.service)
    deps.loop.service.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

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
    const originalDeleteState = deps.loop.service.deleteState.bind(deps.loop.service)
    deps.loop.service.deleteState = (...args: any[]) => { deleteStateCalled = true; return originalDeleteState(...args) }

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

    const state = (deps.loop.service as any).getActiveState('sections-loop')
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

    const state = (deps.loop.service as any).getActiveState('phase-loop')
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

    const state = (deps.loop.service as any).getActiveState('raw-loop')
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

    const state = (deps.loop.service as any).getActiveState('nodecomp-loop')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('coding')
  })

  test('attachLoopToSession does NOT call session.update for permission repair on any surface', async () => {
    const surfaces: Array<'tui' | 'tool' | 'approval-hook'> = ['tui', 'tool', 'approval-hook']
    for (const surface of surfaces) {
      const { deps, fakeClient } = buildDeps()
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
      expect(fakeClient.client.session.update).not.toHaveBeenCalled()
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
    const state = (deps.loop.service as any).getActiveState('variant-loop')
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

  function makeResumeSnapshot(): import('../../src/loop/resume-snapshot').LoopResumeSnapshot {
    return {
      version: 1,
      kind: 'plan',
      phase: 'coding',
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
      sections: [
        { sectionIndex: 0, title: 'Setup', content: 'Do setup', status: 'completed', attempts: 1, summaryDone: 'setup done', summaryDeviations: null, summaryFollowUps: null, startedAt: 100, completedAt: 200 },
        { sectionIndex: 1, title: 'Build', content: 'Do build', status: 'in_progress', attempts: 2, summaryDone: null, summaryDeviations: null, summaryFollowUps: null, startedAt: 300, completedAt: null },
        { sectionIndex: 2, title: 'Ship', content: 'Do ship', status: 'pending', attempts: 0, summaryDone: null, summaryDeviations: null, summaryFollowUps: null, startedAt: null, completedAt: null },
      ],
      findings: [
        { file: 'a.ts', line: 10, severity: 'bug', description: 'broken thing', scenario: 'when X', sectionIndex: 1 },
      ],
    }
  }

  test('attaches a migrated loop from a resume snapshot', async () => {
    const { deps, loopsRepo, sectionPlansRepo, promptAsyncMock } = buildDeps()
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    const { attachLoopToSession } = await import('../../src/services/execution')

    const snapshot = makeResumeSnapshot()

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_resume',
        workspaceId: 'ws_resume',
        worktreeDir: '/tmp/wt/resume',
        loopName: 'moved',
        displayName: 'Moved Loop',
        executionName: 'moved',
        hostSessionId: 'host-sess',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        maxIterations: 40,
        sandboxEnabled: false,
        planText: '# Stale plan text',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
        sendInitialPrompt: false,
        resume: snapshot,
      },
    )

    expect(result.ok).toBe(true)

    // Loop row persists the snapshot's phase pointers.
    const row = loopsRepo.get(PROJECT_ID, 'moved')
    expect(row).not.toBeNull()
    expect(row!.phase).toBe('coding')
    expect(row!.currentSectionIndex).toBe(1)
    expect(row!.totalSections).toBe(3)
    expect(row!.finalAuditDone).toBe(0)
    expect(row!.status).toBe('running')

    // Section rows match the snapshot exactly; section 1 stays in_progress
    // (no applyPlanDecomposition reset to index 0).
    const sections = sectionPlansRepo.list(PROJECT_ID, 'moved')
    expect(sections).toHaveLength(3)
    const byIndex = new Map(sections.map((s) => [s.sectionIndex, s]))
    expect(byIndex.get(0)!.status).toBe('completed')
    expect(byIndex.get(1)!.status).toBe('in_progress')
    expect(byIndex.get(1)!.attempts).toBe(2)
    expect(byIndex.get(2)!.status).toBe('pending')
    expect(byIndex.get(1)!.content).toBe('Do build')

    // Findings were restored for the loop.
    const findings = reviewFindingsRepo.listByLoopName(PROJECT_ID, 'moved')
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe('a.ts')
    expect(findings[0].sectionIndex).toBe(1)

    // No initial prompt is sent.
    expect(promptAsyncMock).not.toHaveBeenCalled()

    // In-memory state reflects the snapshot too.
    const state = (deps.loop.service as any).getActiveState('moved')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('coding')
    expect(state!.currentSectionIndex).toBe(1)
    expect(state!.totalSections).toBe(3)
    expect(state!.prompt).toBe('# Stale plan text')
  })

  test('resume attach with sendInitialPrompt sends the resume prompt for the snapshot phase', async () => {
    const { deps, promptAsyncMock } = buildDeps()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const snapshot: import('../../src/loop/resume-snapshot').LoopResumeSnapshot = {
      version: 1,
      kind: 'plan',
      phase: 'final_auditing',
      currentSectionIndex: 2,
      totalSections: 3,
      finalAuditDone: false,
      sections: [
        { sectionIndex: 0, title: 'Setup', content: 'Do setup', status: 'completed', attempts: 1, summaryDone: 'setup done', summaryDeviations: null, summaryFollowUps: null, startedAt: 100, completedAt: 200 },
        { sectionIndex: 1, title: 'Build', content: 'Do build', status: 'completed', attempts: 1, summaryDone: 'build done', summaryDeviations: null, summaryFollowUps: null, startedAt: 300, completedAt: 400 },
        { sectionIndex: 2, title: 'Ship', content: 'Do ship', status: 'completed', attempts: 1, summaryDone: 'ship done', summaryDeviations: null, summaryFollowUps: null, startedAt: 500, completedAt: 600 },
      ],
      findings: [],
    }

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_resume_audit',
        workspaceId: 'ws_resume_audit',
        worktreeDir: '/tmp/wt/resume-audit',
        loopName: 'moved-audit',
        displayName: 'Moved Audit Loop',
        executionName: 'moved-audit',
        hostSessionId: 'host-sess',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        maxIterations: 40,
        sandboxEnabled: false,
        planText: '# Plan text',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
        sendInitialPrompt: true,
        resume: snapshot,
      },
    )

    expect(result.ok).toBe(true)

    const state = (deps.loop.service as any).getActiveState('moved-audit')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('final_auditing')

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const promptCallArgs = promptAsyncMock.mock.calls[0][0]
    expect(promptCallArgs.agent).toBe('auditor-loop')
    const expectedPrompt = deps.loop.service.buildFinalAuditPrompt(state)
    expect(promptCallArgs.parts[0].text).toBe(expectedPrompt)
  })
})
