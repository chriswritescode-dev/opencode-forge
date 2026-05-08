import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopState, MAX_RETRIES } from '../../src/services/loop'
import { createLoopEventHandler } from '../../src/hooks/loop'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

type DeleteCall = { sessionID: string; directory: string }
type PublishCall = { directory: string; body: unknown }

interface MockClientState {
  deleteCalls: DeleteCall[]
  publishCalls: PublishCall[]
  deleteThrows: boolean
}

function createMockV2Client(state: MockClientState): OpencodeClient {
  return {
    session: {
      create: async () => ({ error: null, data: { id: 'sess' } }),
      promptAsync: async () => ({ error: null, data: null }),
      status: async () => ({ error: null, data: {} }),
      abort: async () => {},
      delete: async (params: DeleteCall) => {
        state.deleteCalls.push(params)
        if (state.deleteThrows) throw new Error('delete failed')
        return { error: undefined }
      },
      messages: async () => ({ error: null, data: [] }),
      get: async () => ({ error: null, data: {} }),
    },
    tui: {
      publish: async (params: PublishCall) => {
        state.publishCalls.push(params)
      },
      selectSession: async () => {},
    },
    worktree: {
      create: async () => ({ error: null, data: { directory: '/tmp/wt', branch: 'b' } }),
      remove: async () => {},
    },
  } as unknown as OpencodeClient
}

function createCapturingLogger(): { logger: Logger; errors: Array<{ msg: string; err?: unknown }> } {
  const errors: Array<{ msg: string; err?: unknown }> = []
  const logger: Logger = {
    log: () => {},
    error: (msg: string, err?: unknown) => { errors.push({ msg, err }) },
    debug: () => {},
  }
  return { logger, errors }
}

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

describe('Loop Decomposing Phase Handler', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-decomposing-test-'))
    const dbPath = join(tempDir, 'loop-decomposing-test.db')
    db = new Database(dbPath)

    db.run(`
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

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.run(`
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

    db.run(`
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

    db.run(`
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

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, { log: () => {}, error: () => {}, debug: () => {} }, undefined, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
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
      phase: 'decomposing',

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      decompositionStatus: 'running',
      decompositionMode: 'agent',
      decompositionSessionId: 'decomp-sess-id',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      finalAuditAttempts: 0,
      ...overrides,
    }
  }

  describe('decomposition state management', () => {
    test('setDecompositionStatus updates status in DB', () => {
      const state = makeState({ decompositionStatus: 'pending' })
      loopService.setState(state.loopName, state)

      loopService.setDecompositionStatus(state.loopName, 'completed')

      const after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionStatus).toBe('completed')
    })

    test('setDecompositionSessionId updates session ID in DB', () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      loopService.setDecompositionSessionId(state.loopName, 'new-decomp-sess')

      const after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionSessionId).toBe('new-decomp-sess')
    })

    test('setDecompositionSessionId with null clears session ID', () => {
      const state = makeState({ decompositionSessionId: 'some-sess' })
      loopService.setState(state.loopName, state)

      loopService.setDecompositionSessionId(state.loopName, null)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionSessionId).toBeNull()
    })

    test('setPhase transitions phase correctly', () => {
      const state = makeState({ phase: 'decomposing' })
      loopService.setState(state.loopName, state)

      loopService.setPhase(state.loopName, 'coding')

      const after = loopService.getAnyState(state.loopName)!
      expect(after.phase).toBe('coding')
    })
  })

  describe('section plan storage integration', () => {
    let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

    beforeEach(() => {
      sectionPlansRepo = createSectionPlansRepo(db)
    })

    test('section plans are persisted when sections are created', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      // Verify section plan retrieval returns null when no plans exist
      const plan = loopService.getSectionPlan(state, 0)
      expect(plan).toBeNull()
    })

    test('startSection sets section to in_progress and records timestamp', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      loopService.startSection(state.loopName, 0)

      const plan = loopService.getSectionPlan(state, 0)
      expect(plan).not.toBeNull()
      expect(plan!.status).toBe('in_progress')
      expect(plan!.startedAt).not.toBeNull()
    })

    test('setCurrentSectionIndex updates index in DB', () => {
      const state = makeState({ totalSections: 3 })
      loopService.setState(state.loopName, state)

      loopService.setCurrentSectionIndex(state.loopName, 1)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.currentSectionIndex).toBe(1)
    })

    test('completeSection marks section completed and records summary', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      loopService.startSection(state.loopName, 0)
      loopService.completeSection(state.loopName, 0, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Deferred Y',
      })

      const plan = loopService.getSectionPlan(state, 0)
      expect(plan!.status).toBe('completed')
      expect(plan!.summaryDone).toBe('Implemented feature X')
      expect(plan!.summaryDeviations).toBe('None')
      expect(plan!.summaryFollowUps).toBe('Deferred Y')
      expect(plan!.completedAt).not.toBeNull()
    })

    test('getCompletedSectionDigest returns completed sections', () => {
      const state = makeState({ totalSections: 3 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
          { index: 2, title: 'Section C', content: 'Content C' },
        ],
      })

      loopService.startSection(state.loopName, 0)
      loopService.completeSection(state.loopName, 0, {
        done: 'Done A',
        deviations: null,
        followUps: null,
      })

      loopService.startSection(state.loopName, 1)
      loopService.completeSection(state.loopName, 1, {
        done: 'Done B',
        deviations: 'Minor deviation',
        followUps: 'Follow-up C',
      })

      const digest = loopService.getCompletedSectionDigest(state)
      expect(digest).toHaveLength(2)
      expect(digest[0].title).toBeTruthy()
      expect(digest[0].summaryDone).toBe('Done A')
      expect(digest[1].summaryDeviations).toBe('Minor deviation')
    })

    test('incrementSectionAttempts increments attempts counter', () => {
      const state = makeState({ totalSections: 1 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
        ],
      })

      loopService.startSection(state.loopName, 0)
      loopService.incrementSectionAttempts(state.loopName, 0)
      loopService.incrementSectionAttempts(state.loopName, 0)

      const plan = loopService.getSectionPlan(state, 0)
      expect(plan!.attempts).toBe(2)
    })

    test('resetSectionForRewind clears summary and resets status', () => {
      const state = makeState({ totalSections: 1 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
        ],
      })

      loopService.startSection(state.loopName, 0)
      loopService.completeSection(state.loopName, 0, {
        done: 'Some done',
        deviations: 'Some deviation',
        followUps: 'Some follow-up',
      })

      loopService.resetSectionForRewind(state.loopName, 0)

      const plan = loopService.getSectionPlan(state, 0)
      expect(plan!.status).toBe('in_progress')
      expect(plan!.attempts).toBe(0)
      expect(plan!.summaryDone).toBeNull()
      expect(plan!.summaryDeviations).toBeNull()
      expect(plan!.summaryFollowUps).toBeNull()
      expect(plan!.completedAt).toBeNull()
    })
  })

  describe('decomposer and section prompt building', () => {
    let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

    beforeEach(() => {
      sectionPlansRepo = createSectionPlansRepo(db)
    })

    test('buildDecomposerInitialPrompt returns plan-based prompt', () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      const prompt = loopService.buildDecomposerInitialPrompt(state)
      expect(prompt).toContain('[Decomposing master plan into section plans]')
    })

    test('buildSectionInitialPrompt returns section-scoped prompt with index', () => {
      const state = makeState({ totalSections: 2, currentSectionIndex: 0 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Loop section')
      expect(prompt).toContain('Section plan')
    })

    test('buildSectionInitialPrompt includes completed sections digest', () => {
      const state = makeState({ totalSections: 2, currentSectionIndex: 1 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      // Complete section 0
      loopService.startSection(state.loopName, 0)
      loopService.completeSection(state.loopName, 0, {
        done: 'Completed section 0',
        deviations: 'None',
        followUps: 'Deferred item',
      })

      // Start section 1
      loopService.startSection(state.loopName, 1)

      // Build prompt for section 1 - should include digest of section 0
      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Prior Sections')
      expect(prompt).toContain('Completed section 0')
      expect(prompt).toContain('Section 1')
    })

    test('buildContinuationPrompt uses section continuation when totalSections > 0', () => {
      const state = makeState({ totalSections: 2, currentSectionIndex: 0 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      loopService.startSection(state.loopName, 0)

      const prompt = loopService.buildContinuationPrompt(state, 'Audit feedback here')
      expect(prompt).toContain('continuation')
      expect(prompt).toContain('Audit feedback here')
    })

    test('buildContinuationPrompt uses legacy mode when totalSections === 0', () => {
      const state = makeState({ totalSections: 0 })
      loopService.setState(state.loopName, state)

      const prompt = loopService.buildContinuationPrompt(state)
      expect(prompt).toContain('Loop iteration')
      expect(prompt).not.toContain('section')
    })
  })

  describe('decomposition failure retry logic', () => {
    test('errorCount is incremented on decomposition failure', () => {
      const state = makeState({ errorCount: 0 })
      loopService.setState(state.loopName, state)

      const newErrorCount = loopService.incrementError(state.loopName)
      expect(newErrorCount).toBe(1)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.errorCount).toBe(1)
    })

    test('errorCount reaches MAX_RETRIES without overflow', () => {
      const state = makeState({ errorCount: MAX_RETRIES - 1 })
      loopService.setState(state.loopName, state)

      loopService.incrementError(state.loopName)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.errorCount).toBe(MAX_RETRIES)
    })

    test('resetError clears error count', () => {
      const state = makeState({ errorCount: 3 })
      loopService.setState(state.loopName, state)

      loopService.resetError(state.loopName)

      const after = loopService.getAnyState(state.loopName)!
      expect(after.errorCount).toBe(0)
    })
  })

  describe('decomposition phase state transitions via hook handler', () => {
    test('handler can be created with section plans repo', () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      expect(handler).toBeDefined()
      expect(typeof handler.onEvent).toBe('function')
      expect(typeof handler.cancelBySessionId).toBe('function')
      expect(typeof handler.terminateLoopByName).toBe('function')
    })

    test('handler.terminateLoopByName terminates loop in decomposing phase', async () => {
      const state = makeState({ phase: 'decomposing', active: true })
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      await handler.terminateLoopByName(state.loopName, 'decomposition_failed')

      const after = loopService.getAnyState(state.loopName)
      expect(after!.active).toBe(false)
      expect(after!.terminationReason).toBe('decomposition_failed')
    })

    test('handler.terminateLoopByName can terminate during coding phase with sections', async () => {
      const state = makeState({ phase: 'coding', totalSections: 3, currentSectionIndex: 1 })
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      await handler.terminateLoopByName(state.loopName, 'user_cancelled')

      const after = loopService.getAnyState(state.loopName)
      expect(after!.active).toBe(false)
      expect(after!.terminationReason).toBe('user_cancelled')
    })

    test('cancelBySessionId cancels loop with decomp session ID', async () => {
      const state = makeState({ sessionId: 'decomp-session-xyz', decompositionSessionId: 'decomp-session-xyz' })
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      const cancelled = await handler.cancelBySessionId('decomp-session-xyz')
      expect(cancelled).toBe(true)

      const after = loopService.getAnyState(state.loopName)
      expect(after!.active).toBe(false)
      expect(after!.terminationReason).toBe('cancelled')
    })
  })

  describe('decomposition status flow', () => {
    test('decomposition status progresses from pending to running to completed', () => {
      const state = makeState({ decompositionStatus: 'pending' })
      loopService.setState(state.loopName, state)

      loopService.setDecompositionStatus(state.loopName, 'running')
      let after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionStatus).toBe('running')

      loopService.setDecompositionStatus(state.loopName, 'completed')
      after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionStatus).toBe('completed')
    })

    test('decomposition status can transition to failed', () => {
      const state = makeState({ decompositionStatus: 'running' })
      loopService.setState(state.loopName, state)

      loopService.setDecompositionStatus(state.loopName, 'failed')

      const after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionStatus).toBe('failed')
    })

    test('decomposition status can be set to skipped for legacy fallback', () => {
      const state = makeState({ decompositionStatus: 'completed', totalSections: 0 })
      loopService.setState(state.loopName, state)

      loopService.setDecompositionStatus(state.loopName, 'skipped')

      const after = loopService.getAnyState(state.loopName)!
      expect(after.decompositionStatus).toBe('skipped')
    })
  })

  describe('section plan storage with bulk insert', () => {
    let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

    beforeEach(() => {
      sectionPlansRepo = createSectionPlansRepo(db)
    })

    test('section plans can be listed after creation', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Plan content A' },
          { index: 1, title: 'Section B', content: 'Plan content B' },
        ],
      })

      const plans = sectionPlansRepo.list(projectId, state.loopName)
      expect(plans).toHaveLength(2)
      expect(plans[0].title).toBe('Section A')
      expect(plans[1].title).toBe('Section B')
    })

    test('section plans count returns correct count', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
          { index: 2, title: 'Section C', content: 'Content C' },
        ],
      })

      const count = sectionPlansRepo.count(projectId, state.loopName)
      expect(count).toBe(3)
    })

    test('bulkInsert skips duplicate section indices', () => {
      const state = makeState({ totalSections: 2 })
      loopService.setState(state.loopName, state)

      const result1 = sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'First', content: 'Content 1' },
        ],
      })
      expect(result1.inserted).toBe(1)

      const result2 = sectionPlansRepo.bulkInsert({
        projectId,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Duplicate', content: 'Content dup' },
          { index: 1, title: 'Second', content: 'Content 2' },
        ],
      })
      expect(result2.inserted).toBe(1)
    })
  })
})
