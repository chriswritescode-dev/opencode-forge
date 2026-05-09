import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { decomposerAgent } from '../../src/agents/decomposer'
import { resolveDecomposerModel } from '../../src/utils/model-fallback'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/services/loop'
import { decomposeDeterministically } from '../../src/services/deterministic-decomposer'
import type { Logger } from '../../src/types'
import type { LoopState } from '../../src/services/loop'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopService } from '../../src/services/loop'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

describe('Execution decomposer integration', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopService: LoopService

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-decomp-test-'))
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
  }> = {}) {
    const defaults = {
      loopName: 'test-loop',
      phase: 'coding',
      decompositionStatus: 'pending',
      decompositionMode: 'deterministic',
      currentSectionIndex: 0,
      totalSections: 0,
      iteration: 1,
    }
    const opts = { ...defaults, ...overrides }
    loopsRepo.insert({
      projectId: PROJECT_ID,
      loopName: opts.loopName,
      status: 'running',
      currentSessionId: 'session-1',
      worktree: false,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
      maxIterations: 5,
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
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      decompositionStatus: opts.decompositionStatus as any,
      decompositionMode: opts.decompositionMode as any,
      decompositionSessionId: null,
      currentSectionIndex: opts.currentSectionIndex,
      totalSections: opts.totalSections,
      finalAuditDone: 0,
    }, { prompt: 'plan text', lastAuditResult: null })
  }

  function buildPlanWithPhases(count: number): string {
    return Array.from({ length: count }, (_, i) =>
      `## Phase ${i + 1}: Section ${i + 1}\n- Step ${i + 1}\n- Another step`
    ).join('\n')
  }

  describe('Deterministic decomposition with sections', () => {
    test('decomposes plan with Phase headings into sections stored in section_plans', () => {
      insertLoop({ loopName: 'decomp-loop' })
      const planText = buildPlanWithPhases(3)

      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(3)

      sectionPlansRepo.bulkInsert({ projectId: PROJECT_ID, loopName: 'decomp-loop', sections })
      loopsRepo.setTotalSections(PROJECT_ID, 'decomp-loop', sections.length)
      loopsRepo.setCurrentSectionIndex(PROJECT_ID, 'decomp-loop', 0)
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'decomp-loop', 'completed')
      sectionPlansRepo.setStatus(PROJECT_ID, 'decomp-loop', 0, 'in_progress')
      sectionPlansRepo.setStartedAt(PROJECT_ID, 'decomp-loop', 0, Date.now())

      const row = loopsRepo.get(PROJECT_ID, 'decomp-loop')!
      expect(row.decompositionStatus).toBe('completed')
      expect(row.totalSections).toBe(3)
      expect(row.currentSectionIndex).toBe(0)

      const storedSections = sectionPlansRepo.list(PROJECT_ID, 'decomp-loop')
      expect(storedSections).toHaveLength(3)
      expect(storedSections[0].title).toBe('Section 1')
      expect(storedSections[0].status).toBe('in_progress')
      expect(storedSections[1].title).toBe('Section 2')
      expect(storedSections[1].status).toBe('pending')
      expect(storedSections[2].title).toBe('Section 3')
      expect(storedSections[2].status).toBe('pending')
    })

    test('builds section initial prompt using loop service after decomposition', () => {
      insertLoop({
        loopName: 'prompt-loop',
        totalSections: 2,
        currentSectionIndex: 0,
        decompositionStatus: 'completed',
      })
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'prompt-loop',
        sections: [
          { index: 0, title: 'Setup', content: 'Install deps' },
          { index: 1, title: 'Implement', content: 'Write code' },
        ],
      })

      const state = loopService.getActiveState('prompt-loop')!
      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Install deps')
      expect(prompt).toContain('1/2')
    })

    test('loop state is consistent between DB row and in-memory state after decomposition', () => {
      insertLoop({
        loopName: 'consistent-loop',
        totalSections: 2,
        currentSectionIndex: 0,
        decompositionStatus: 'completed',
        decompositionMode: 'deterministic',
      })
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'consistent-loop',
        sections: [
          { index: 0, title: 'First', content: 'Content A' },
          { index: 1, title: 'Second', content: 'Content B' },
        ],
      })

      const activeState = loopService.getActiveState('consistent-loop')!
      const anyState = loopService.getAnyState('consistent-loop')!

      expect(activeState.decompositionStatus).toBe('completed')
      expect(activeState.totalSections).toBe(2)
      expect(activeState.currentSectionIndex).toBe(0)
      expect(anyState.decompositionMode).toBe('deterministic')

      const dbRow = loopsRepo.get(PROJECT_ID, 'consistent-loop')!
      expect(dbRow.decompositionStatus).toBe('completed')
      expect(dbRow.totalSections).toBe(2)
      expect(dbRow.currentSectionIndex).toBe(0)
      expect(dbRow.decompositionMode).toBe('deterministic')
    })
  })

  describe('Deterministic decomposition without sections', () => {
    test('no Phase headings results in empty sections array', () => {
      const planText = 'Just a plain plan without phases\nSome other text'
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toEqual([])
    })

    test('legacy fallback sets decomposition status to skipped and totalSections to 0', () => {
      insertLoop({ loopName: 'legacy-fallback', decompositionStatus: 'running' })

      const planText = 'Plain plan without Phase headings'

      // Simulate legacy fallback path from handleStartLoop
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      loopsRepo.setDecompositionStatus(PROJECT_ID, 'legacy-fallback', 'skipped')
      loopsRepo.setTotalSections(PROJECT_ID, 'legacy-fallback', 0)

      const row = loopsRepo.get(PROJECT_ID, 'legacy-fallback')!
      expect(row.decompositionStatus).toBe('skipped')
      expect(row.totalSections).toBe(0)

      const state = loopService.getActiveState('legacy-fallback')!
      expect(state.decompositionStatus).toBe('skipped')
      expect(state.totalSections).toBe(0)
    })

    test('agent fallback sets decomposition status to running and creates decomposer session', () => {
      insertLoop({ loopName: 'agent-fallback', decompositionStatus: 'running' })

      const planText = 'Plain plan without Phase headings'

      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      // Simulate agent fallback path
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'agent-fallback', 'running')
      const decomposerSessionId = 'decomposer-session-id'
      loopsRepo.setDecompositionSessionId(PROJECT_ID, 'agent-fallback', decomposerSessionId)
      loopsRepo.setCurrentSessionId(PROJECT_ID, 'agent-fallback', decomposerSessionId)
      loopService.registerLoopSession(decomposerSessionId, 'agent-fallback')
      loopService.setPhase('agent-fallback', 'decomposing')

      const row = loopsRepo.get(PROJECT_ID, 'agent-fallback')!
      expect(row.decompositionStatus).toBe('running')
      expect(row.decompositionSessionId).toBe(decomposerSessionId)
      expect(row.currentSessionId).toBe(decomposerSessionId)

      const state = loopService.getActiveState('agent-fallback')!
      expect(state.decompositionStatus).toBe('running')
      expect(state.decompositionSessionId).toBe(decomposerSessionId)
      expect(state.phase).toBe('decomposing')
    })
  })

  describe('Deterministic decomposition with maxSections', () => {
    test('maxSections is respected when decomposing and storing sections', () => {
      insertLoop({ loopName: 'max-sect', decompositionStatus: 'running' })
      const planText = buildPlanWithPhases(10)

      const sections = decomposeDeterministically(planText, { maxSections: 3 })
      expect(sections).toHaveLength(3)
      expect(sections[0].title).toBe('Section 1')
      expect(sections[1].title).toBe('Section 2')
      expect(sections[2].title).toBe('Section 3')

      sectionPlansRepo.bulkInsert({ projectId: PROJECT_ID, loopName: 'max-sect', sections })
      loopsRepo.setTotalSections(PROJECT_ID, 'max-sect', sections.length)

      const storedCount = sectionPlansRepo.count(PROJECT_ID, 'max-sect')
      expect(storedCount).toBe(3)

      const row = loopsRepo.get(PROJECT_ID, 'max-sect')!
      expect(row.totalSections).toBe(3)
    })

    test('defaults maxSections to 12 when not specified', () => {
      const planText = buildPlanWithPhases(15)
      const sections = decomposeDeterministically(planText)
      expect(sections).toHaveLength(12)
    })

    test('only stores sections within maxSections limit in section_plans table', () => {
      insertLoop({ loopName: 'limit-store' })
      const planText = buildPlanWithPhases(6)

      const sections = decomposeDeterministically(planText, { maxSections: 2 })
      expect(sections).toHaveLength(2)

      sectionPlansRepo.bulkInsert({ projectId: PROJECT_ID, loopName: 'limit-store', sections })

      const allSections = sectionPlansRepo.list(PROJECT_ID, 'limit-store')
      expect(allSections).toHaveLength(2)
      expect(allSections[0].title).toBe('Section 1')
      expect(allSections[1].title).toBe('Section 2')
    })
  })

  describe('Section plan storage via bulkInsert', () => {
    test('bulkInsert correctly populates section_plans table', () => {
      insertLoop({ loopName: 'bulk-loop' })
      const sections = [
        { index: 0, title: 'Setup', content: 'Install dependencies' },
        { index: 1, title: 'Build', content: 'Compile source code' },
        { index: 2, title: 'Test', content: 'Run test suite' },
      ]

      const result = sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'bulk-loop',
        sections,
      })
      expect(result.inserted).toBe(3)

      const rows = sectionPlansRepo.list(PROJECT_ID, 'bulk-loop')
      expect(rows).toHaveLength(3)
      expect(rows[0].title).toBe('Setup')
      expect(rows[0].content).toBe('Install dependencies')
      expect(rows[0].status).toBe('pending')
      expect(rows[0].attempts).toBe(0)
      expect(rows[1].title).toBe('Build')
      expect(rows[2].title).toBe('Test')
    })

    test('bulkInsert with duplicate section indexes ignores duplicates', () => {
      insertLoop({ loopName: 'dup-loop' })
      const sections = [
        { index: 0, title: 'First', content: 'Content A' },
        { index: 0, title: 'Duplicate', content: 'Content B' },
        { index: 1, title: 'Second', content: 'Content C' },
      ]

      const result = sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'dup-loop',
        sections,
      })
      expect(result.inserted).toBe(2)

      const rows = sectionPlansRepo.list(PROJECT_ID, 'dup-loop')
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toBe('First')
    })

    test('section plans are isolated per loop name', () => {
      insertLoop({ loopName: 'loop-a' })
      insertLoop({ loopName: 'loop-b' })
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'loop-a',
        sections: [{ index: 0, title: 'A Section', content: 'A content' }],
      })
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'loop-b',
        sections: [{ index: 0, title: 'B Section', content: 'B content' }],
      })

      const aSections = sectionPlansRepo.list(PROJECT_ID, 'loop-a')
      const bSections = sectionPlansRepo.list(PROJECT_ID, 'loop-b')
      expect(aSections).toHaveLength(1)
      expect(aSections[0].title).toBe('A Section')
      expect(bSections).toHaveLength(1)
      expect(bSections[0].title).toBe('B Section')
    })
  })

  describe('Legacy fallback state consistency', () => {
    test('onParseFailure=legacy: DB and in-memory state are consistent (status=skipped, totalSections=0)', () => {
      insertLoop({ loopName: 'legacy-consistency', decompositionStatus: 'running' })

      const planText = 'No phases here, just plain text.'
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      // Simulate onParseFailure='legacy' fallback from handleStartLoop
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'legacy-consistency', 'skipped')
      loopsRepo.setTotalSections(PROJECT_ID, 'legacy-consistency', 0)

      // Verify DB state
      const dbRow = loopsRepo.get(PROJECT_ID, 'legacy-consistency')!
      expect(dbRow.decompositionStatus).toBe('skipped')
      expect(dbRow.totalSections).toBe(0)
      expect(dbRow.currentSectionIndex).toBe(0)

      // Verify in-memory state matches DB
      const state = loopService.getActiveState('legacy-consistency')!
      expect(state.decompositionStatus).toBe('skipped')
      expect(state.totalSections).toBe(0)
      expect(state.currentSectionIndex).toBe(0)
    })

    test('onParseFailure=legacy: state remains consistent after multiple reads', () => {
      insertLoop({ loopName: 'multi-read-legacy', decompositionStatus: 'running' })

      loopsRepo.setDecompositionStatus(PROJECT_ID, 'multi-read-legacy', 'skipped')
      loopsRepo.setTotalSections(PROJECT_ID, 'multi-read-legacy', 0)

      for (let i = 0; i < 5; i++) {
        const state = loopService.getActiveState('multi-read-legacy')!
        expect(state.decompositionStatus).toBe('skipped')
        expect(state.totalSections).toBe(0)
      }

      const dbRow = loopsRepo.get(PROJECT_ID, 'multi-read-legacy')!
      expect(dbRow.decompositionStatus).toBe('skipped')
      expect(dbRow.totalSections).toBe(0)
    })

    test('legacy fallback does not create any section plan rows', () => {
      insertLoop({ loopName: 'no-sections-legacy' })

      const planText = 'Plain text, no phases'
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      loopsRepo.setDecompositionStatus(PROJECT_ID, 'no-sections-legacy', 'skipped')
      loopsRepo.setTotalSections(PROJECT_ID, 'no-sections-legacy', 0)

      const count = sectionPlansRepo.count(PROJECT_ID, 'no-sections-legacy')
      expect(count).toBe(0)
    })
  })

  describe('Full deterministic flow simulation', () => {
    test('end-to-end: decompose, store, update loop, verify section prompt', () => {
      insertLoop({
        loopName: 'e2e-loop',
        decompositionStatus: 'pending',
        decompositionMode: 'deterministic',
      })

      const planText = buildPlanWithPhases(2)

      // Step 1: Decompose
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(2)

      // Step 2: Store sections
      const insertResult = sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'e2e-loop',
        sections,
      })
      expect(insertResult.inserted).toBe(2)

      // Step 3: Update loop state
      loopsRepo.setTotalSections(PROJECT_ID, 'e2e-loop', sections.length)
      loopsRepo.setCurrentSectionIndex(PROJECT_ID, 'e2e-loop', 0)
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'e2e-loop', 'completed')

      // Step 4: Mark first section as in_progress
      sectionPlansRepo.setStatus(PROJECT_ID, 'e2e-loop', 0, 'in_progress')
      sectionPlansRepo.setStartedAt(PROJECT_ID, 'e2e-loop', 0, Date.now())

      // Step 5: Build section prompt
      const state = loopService.getActiveState('e2e-loop')!
      expect(state.decompositionStatus).toBe('completed')
      expect(state.totalSections).toBe(2)
      expect(state.currentSectionIndex).toBe(0)

      const prompt = loopService.buildSectionInitialPrompt(state)
      expect(prompt).toContain('Section 1')
      expect(prompt).toContain('1/2')

      // Step 6: Verify section plan in DB
      const section = sectionPlansRepo.get(PROJECT_ID, 'e2e-loop', 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('in_progress')
      expect(section!.startedAt).not.toBeNull()

      const secondSection = sectionPlansRepo.get(PROJECT_ID, 'e2e-loop', 1)
      expect(secondSection).not.toBeNull()
      expect(secondSection!.status).toBe('pending')
    })

    test('end-to-end: decompose with no phases triggers legacy fallback', () => {
      insertLoop({
        loopName: 'e2e-no-phases',
        decompositionStatus: 'running',
        decompositionMode: 'deterministic',
      })

      const planText = 'A plan without any Phase headings.'

      // Step 1: Decompose
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      // Step 2: No sections - apply legacy fallback
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'e2e-no-phases', 'skipped')
      loopsRepo.setTotalSections(PROJECT_ID, 'e2e-no-phases', 0)

      // Step 3: Verify state consistency
      const state = loopService.getActiveState('e2e-no-phases')!
      expect(state.decompositionStatus).toBe('skipped')
      expect(state.totalSections).toBe(0)
      expect(state.currentSectionIndex).toBe(0)

      // Step 4: No section plans should exist
      expect(sectionPlansRepo.count(PROJECT_ID, 'e2e-no-phases')).toBe(0)

      // Step 5: Legacy prompt should use full plan text (not section-based)
      const dbRow = loopsRepo.get(PROJECT_ID, 'e2e-no-phases')!
      expect(dbRow.decompositionStatus).toBe('skipped')
      expect(dbRow.totalSections).toBe(0)
    })

    test('end-to-end: decompose with no phases triggers agent fallback', () => {
      insertLoop({
        loopName: 'e2e-agent-fallback',
        decompositionStatus: 'running',
        decompositionMode: 'deterministic',
      })

      const planText = 'A plan without any Phase headings.'

      // Step 1: Decompose
      const sections = decomposeDeterministically(planText, { maxSections: 12 })
      expect(sections).toHaveLength(0)

      // Step 2: No sections - apply agent fallback
      loopsRepo.setDecompositionStatus(PROJECT_ID, 'e2e-agent-fallback', 'running')
      const decomposerSessionId = 'decomposer-sess-123'
      loopsRepo.setDecompositionSessionId(PROJECT_ID, 'e2e-agent-fallback', decomposerSessionId)
      loopsRepo.setCurrentSessionId(PROJECT_ID, 'e2e-agent-fallback', decomposerSessionId)
      loopService.registerLoopSession(decomposerSessionId, 'e2e-agent-fallback')
      loopService.setPhase('e2e-agent-fallback', 'decomposing')

      // Step 3: Verify state
      const state = loopService.getActiveState('e2e-agent-fallback')!
      expect(state.decompositionStatus).toBe('running')
      expect(state.decompositionSessionId).toBe(decomposerSessionId)
      expect(state.phase).toBe('decomposing')
      expect(state.sessionId).toBe(decomposerSessionId)

      // Step 4: No section plans should exist
      expect(sectionPlansRepo.count(PROJECT_ID, 'e2e-agent-fallback')).toBe(0)
    })
  })

  describe('Edge cases', () => {
    test('decomposeDeterministically returns empty for empty plan text', () => {
      const sections = decomposeDeterministically('', { maxSections: 12 })
      expect(sections).toEqual([])
    })

    test('decomposeDeterministically handles plan with only Phase headings and no body', () => {
      const plan = '## Phase 1: Empty Phase\n## Phase 2: Also Empty'
      const sections = decomposeDeterministically(plan, { maxSections: 12 })
      expect(sections).toHaveLength(2)
      expect(sections[0].title).toBe('Empty Phase')
      expect(sections[1].title).toBe('Also Empty')
    })

    test('decomposeDeterministically strips forge-plan markers before parsing', () => {
      const plan = '<!-- forge-plan:start -->\n## Phase 1: Setup\nContent\n<!-- forge-plan:end -->'
      const sections = decomposeDeterministically(plan, { maxSections: 12 })
      expect(sections).toHaveLength(1)
      expect(sections[0].title).toBe('Setup')
    })

    test('large maxSections value produces correct number of sections', () => {
      const planText = buildPlanWithPhases(20)
      const sections = decomposeDeterministically(planText, { maxSections: 20 })
      expect(sections).toHaveLength(20)
    })

    test('maxSections=1 limits to single section', () => {
      const planText = buildPlanWithPhases(5)
      const sections = decomposeDeterministically(planText, { maxSections: 1 })
      expect(sections).toHaveLength(1)
      expect(sections[0].index).toBe(0)
    })
  })

  describe('Integration smoke: decomposer model wired through promptAsync', () => {
    test('initial launch passes auditor model to promptAsync when only auditor and execution are configured', async () => {
      const { createForgeExecutionService } = await import('../../src/services/execution')

      const promptAsyncCalls: Array<Record<string, unknown>> = []

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'session-1' } }),
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
          abort: async () => ({}),
          delete: async () => ({}),
          get: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const noopFn = () => {}
      const mockLoopsRepo = new Proxy({}, { get: () => noopFn }) as any
      mockLoopsRepo.listByStatus = () => []
      mockLoopsRepo.get = () => null

      const mockPlansRepo = new Proxy({}, { get: () => noopFn }) as any
      mockPlansRepo.getForSession = () => null

      const mockLoopService = {
        generateUniqueLoopName: () => 'test-loop',
        setState: noopFn,
        registerLoopSession: noopFn,
        setPhase: noopFn,
        buildDecomposerInitialPrompt: () => 'Decompose this plan',
        deleteState: noopFn,
        getActiveState: () => null,
        getAnyState: () => null,
      }

      const service = createForgeExecutionService({
        projectId: 'test-project',
        directory: '/tmp/test',
        config: {
          executionModel: 'prov/exec',
          auditorModel: 'prov/aud',
          decomposer: { enabled: true, mode: 'agent' },
          loop: { enabled: true },
        },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo: mockPlansRepo,
        loopsRepo: mockLoopsRepo,
        loopService: mockLoopService as any,
        sectionPlansRepo: {
          bulkInsert: noopFn,
          count: () => 0,
          list: () => [],
          setStatus: noopFn,
          setStartedAt: noopFn,
        } as any,
      })

      await service.dispatch(
        { surface: 'api', projectId: 'test-project', directory: '/tmp/test' },
        {
          type: 'loop.start',
          source: { kind: 'inline', planText: '## Phase 1: Setup\nDo something' },
          mode: 'in-place',
          maxIterations: 3,
        },
      )

      expect(promptAsyncCalls.length).toBeGreaterThan(0)

      const firstCall = promptAsyncCalls[0]
      expect(firstCall.model).toEqual({ providerID: 'prov', modelID: 'aud' })
      expect(firstCall.agent).toBe('decomposer')
    })

    test('initial launch passes decomposer model when decomposer.model is explicitly set', async () => {
      const { createForgeExecutionService } = await import('../../src/services/execution')

      const promptAsyncCalls: Array<Record<string, unknown>> = []

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'session-2' } }),
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
          abort: async () => ({}),
          delete: async () => ({}),
          get: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const noopFn = () => {}
      const mockLoopsRepo = new Proxy({}, { get: () => noopFn }) as any
      mockLoopsRepo.listByStatus = () => []
      mockLoopsRepo.get = () => null

      const mockPlansRepo = new Proxy({}, { get: () => noopFn }) as any
      mockPlansRepo.getForSession = () => null

      const mockLoopService = {
        generateUniqueLoopName: () => 'test-loop-2',
        setState: noopFn,
        registerLoopSession: noopFn,
        setPhase: noopFn,
        buildDecomposerInitialPrompt: () => 'Decompose this plan',
        deleteState: noopFn,
        getActiveState: () => null,
        getAnyState: () => null,
      }

      const service = createForgeExecutionService({
        projectId: 'test-project',
        directory: '/tmp/test',
        config: {
          executionModel: 'prov/exec',
          auditorModel: 'prov/aud',
          decomposer: { enabled: true, mode: 'agent', model: 'prov/decomp' },
          loop: { enabled: true },
        },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo: mockPlansRepo,
        loopsRepo: mockLoopsRepo,
        loopService: mockLoopService as any,
        sectionPlansRepo: {
          bulkInsert: noopFn,
          count: () => 0,
          list: () => [],
          setStatus: noopFn,
          setStartedAt: noopFn,
        } as any,
      })

      await service.dispatch(
        { surface: 'api', projectId: 'test-project', directory: '/tmp/test' },
        {
          type: 'loop.start',
          source: { kind: 'inline', planText: '## Phase 1: Setup\nDo something' },
          mode: 'in-place',
          maxIterations: 3,
        },
      )

      expect(promptAsyncCalls.length).toBeGreaterThan(0)
      const firstCall = promptAsyncCalls[0]
      expect(firstCall.model).toEqual({ providerID: 'prov', modelID: 'decomp' })
    })

    test('no model arg passed to promptAsync when no model source is configured', async () => {
      const { createForgeExecutionService } = await import('../../src/services/execution')

      const promptAsyncCalls: Array<Record<string, unknown>> = []

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'session-3' } }),
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
          abort: async () => ({}),
          delete: async () => ({}),
          get: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const noopFn = () => {}
      const mockLoopsRepo = new Proxy({}, { get: () => noopFn }) as any
      mockLoopsRepo.listByStatus = () => []
      mockLoopsRepo.get = () => null

      const mockPlansRepo = new Proxy({}, { get: () => noopFn }) as any
      mockPlansRepo.getForSession = () => null

      const mockLoopService = {
        generateUniqueLoopName: () => 'test-loop-3',
        setState: noopFn,
        registerLoopSession: noopFn,
        setPhase: noopFn,
        buildDecomposerInitialPrompt: () => 'Decompose this plan',
        deleteState: noopFn,
        getActiveState: () => null,
        getAnyState: () => null,
      }

      const service = createForgeExecutionService({
        projectId: 'test-project',
        directory: '/tmp/test',
        config: {
          loop: { enabled: true },
        },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo: mockPlansRepo,
        loopsRepo: mockLoopsRepo,
        loopService: mockLoopService as any,
        sectionPlansRepo: {
          bulkInsert: noopFn,
          count: () => 0,
          list: () => [],
          setStatus: noopFn,
          setStartedAt: noopFn,
        } as any,
      })

      await service.dispatch(
        { surface: 'api', projectId: 'test-project', directory: '/tmp/test' },
        {
          type: 'loop.start',
          source: { kind: 'inline', planText: '## Phase 1: Setup\nDo something' },
          mode: 'in-place',
          maxIterations: 3,
        },
      )

      expect(promptAsyncCalls.length).toBeGreaterThan(0)
      const firstCall = promptAsyncCalls[0]
      expect(firstCall).not.toHaveProperty('model')
    })
  })

  describe('Decomposer system prompt markers', () => {
    test('decomposer system prompt contains attribute-free section start marker', () => {
      expect(decomposerAgent.systemPrompt).toContain('<!-- forge-section:start -->')
    })

    test('decomposer system prompt contains attribute-free section end marker', () => {
      expect(decomposerAgent.systemPrompt).toContain('<!-- forge-section:end -->')
    })

    test('decomposer system prompt does not contain old index attribute format', () => {
      expect(decomposerAgent.systemPrompt).not.toMatch(/index=\d+\s+title="/)
    })

    test('decomposer system prompt does not contain old index= attribute at all', () => {
      expect(decomposerAgent.systemPrompt).not.toContain('index=')
    })

    test('decomposer system prompt requires verification for every section part', () => {
      expect(decomposerAgent.systemPrompt).toContain('Every section/part MUST include a non-empty ## Verification block')
    })

    test('decomposer system prompt requires section-specific verification', () => {
      expect(decomposerAgent.systemPrompt).toContain('specific to that section')
    })
  })

  describe('Worktree decomposer warp behavior', () => {
    test('worktree+agent start warps the decomposer session', async () => {
      const { createForgeExecutionService } = await import('../../src/services/execution')

      const sessionCreateCalls: Array<Record<string, unknown>> = []
      const warpCalls: Array<Record<string, unknown>> = []
      const promptAsyncCalls: Array<Record<string, unknown>> = []

      const mockV2Client = {
        session: {
          create: async (params: Record<string, unknown>) => {
            sessionCreateCalls.push(params)
            return { data: { id: 'ses_decomposer_1' } }
          },
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
          abort: async () => ({}),
          delete: async () => ({}),
          get: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: {
            list: async () => ({ data: [] }),
            remove: async () => ({}),
            create: async () => ({ data: { id: 'wrk_1' } }),
            warp: async (args: Record<string, unknown>) => {
              warpCalls.push(args)
              return { data: {} }
            },
          },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/wt/x', branch: 'forge/x' } }) },
      }

      const noopFn = () => {}
      const mockLoopsRepo = new Proxy({}, { get: () => noopFn }) as any
      mockLoopsRepo.listByStatus = () => []
      mockLoopsRepo.get = () => null

      const mockPlansRepo = new Proxy({}, { get: () => noopFn }) as any
      mockPlansRepo.getForSession = () => null

      const mockLoopService = {
        generateUniqueLoopName: () => 'test-wt-loop',
        setState: noopFn,
        registerLoopSession: noopFn,
        setPhase: noopFn,
        buildDecomposerInitialPrompt: () => 'Decompose this plan',
        deleteState: noopFn,
        getActiveState: () => null,
        getAnyState: () => null,
      }

      const service = createForgeExecutionService({
        projectId: 'test-project',
        directory: '/tmp/test',
        config: {
          executionModel: 'prov/exec',
          auditorModel: 'prov/aud',
          decomposer: { enabled: true, mode: 'agent' },
          loop: { enabled: true },
        },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo: mockPlansRepo,
        loopsRepo: mockLoopsRepo,
        loopService: mockLoopService as any,
        sectionPlansRepo: {
          bulkInsert: noopFn,
          count: () => 0,
          list: () => [],
          setStatus: noopFn,
          setStartedAt: noopFn,
        } as any,
      })

      await service.dispatch(
        { surface: 'api', projectId: 'test-project', directory: '/tmp/test' },
        {
          type: 'loop.start',
          source: { kind: 'inline', planText: '## Phase 1: Setup\nDo something' },
          mode: 'worktree',
          maxIterations: 3,
        },
      )

      expect(sessionCreateCalls.length).toBeGreaterThan(0)
      expect(sessionCreateCalls[0]).toHaveProperty('workspaceID', 'wrk_1')

      expect(warpCalls.length).toBe(1)
      expect(warpCalls[0]).toEqual({ id: 'wrk_1', sessionID: 'ses_decomposer_1' })

      expect(promptAsyncCalls.length).toBeGreaterThan(0)
      expect(promptAsyncCalls[0].agent).toBe('decomposer')
      expect(promptAsyncCalls[0].sessionID).toBe('ses_decomposer_1')
    })

    test('in-place agent decomposer does not warp', async () => {
      const { createForgeExecutionService } = await import('../../src/services/execution')

      const sessionCreateCalls: Array<Record<string, unknown>> = []
      const warpCalls: Array<Record<string, unknown>> = []
      const promptAsyncCalls: Array<Record<string, unknown>> = []

      const mockV2Client = {
        session: {
          create: async (params: Record<string, unknown>) => {
            sessionCreateCalls.push(params)
            return { data: { id: 'ses_decomposer_ip' } }
          },
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
          abort: async () => ({}),
          delete: async () => ({}),
          get: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: {
            list: async () => ({ data: [] }),
            remove: async () => ({}),
            create: async () => ({ data: { id: 'wrk_1' } }),
            warp: async (args: Record<string, unknown>) => {
              warpCalls.push(args)
              return { data: {} }
            },
          },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const noopFn = () => {}
      const mockLoopsRepo = new Proxy({}, { get: () => noopFn }) as any
      mockLoopsRepo.listByStatus = () => []
      mockLoopsRepo.get = () => null

      const mockPlansRepo = new Proxy({}, { get: () => noopFn }) as any
      mockPlansRepo.getForSession = () => null

      const mockLoopService = {
        generateUniqueLoopName: () => 'test-ip-loop',
        setState: noopFn,
        registerLoopSession: noopFn,
        setPhase: noopFn,
        buildDecomposerInitialPrompt: () => 'Decompose this plan',
        deleteState: noopFn,
        getActiveState: () => null,
        getAnyState: () => null,
      }

      const service = createForgeExecutionService({
        projectId: 'test-project',
        directory: '/tmp/test',
        config: {
          executionModel: 'prov/exec',
          auditorModel: 'prov/aud',
          decomposer: { enabled: true, mode: 'agent' },
          loop: { enabled: true },
        },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo: mockPlansRepo,
        loopsRepo: mockLoopsRepo,
        loopService: mockLoopService as any,
        sectionPlansRepo: {
          bulkInsert: noopFn,
          count: () => 0,
          list: () => [],
          setStatus: noopFn,
          setStartedAt: noopFn,
        } as any,
      })

      await service.dispatch(
        { surface: 'api', projectId: 'test-project', directory: '/tmp/test' },
        {
          type: 'loop.start',
          source: { kind: 'inline', planText: '## Phase 1: Setup\nDo something' },
          mode: 'in-place',
          maxIterations: 3,
        },
      )

      expect(sessionCreateCalls.length).toBeGreaterThan(0)
      expect(sessionCreateCalls[0]).not.toHaveProperty('workspaceID')

      expect(warpCalls.length).toBe(0)

      expect(promptAsyncCalls.length).toBeGreaterThan(0)
      expect(promptAsyncCalls[0].agent).toBe('decomposer')
    })
  })
})
