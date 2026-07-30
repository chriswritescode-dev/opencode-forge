import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { Database as Sqlite } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createGoalAuthoringTools } from '../../src/tools/goal-authoring'
import { createGoalBriefsRepo } from '../../src/storage/repos/goal-briefs-repo'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { ToolContext } from '../../src/tools/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function describeGoal() {
  return `## Goal
Ship the goal-brief launch feature.

## Context
Goal briefs are authored before the loop is launched.

## Constraints
No plan structure inside the brief.

## Acceptance Criteria
- goal-write writes a brief.
`
}

describe('goal-write', () => {
  let db: Database
  let tempDir: string
  let tools: ReturnType<typeof createGoalAuthoringTools>
  let goalBriefsRepo: ReturnType<typeof createGoalBriefsRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'goal-authoring-test-'))
    db = new Sqlite(join(tempDir, 'test.db'))

    db.run(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
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
        session_directory    TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections       INTEGER NOT NULL DEFAULT 0,
        final_audit_done     INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        execution_variant    TEXT,
        auditor_variant      TEXT,
        loop_kind            TEXT NOT NULL DEFAULT 'plan',
        executor_session_id  TEXT,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        last_audit_result   TEXT,
        post_action_report  TEXT,
        goal                TEXT,
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
      CREATE TABLE goal_briefs (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, session_id)
      )
    `)

    goalBriefsRepo = createGoalBriefsRepo(db)
    loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)

    const ctx = {
      goalBriefsRepo,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      projectId,
      logger: mockLogger,
      loop: { service: loopService },
      directory: tempDir,
    } as unknown as ToolContext

    tools = createGoalAuthoringTools(ctx)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  function makeToolContext(sessionID: string) {
    return { sessionID } as any
  }

  function insertRunningLoop(loopName: string, sessionId: string) {
    loopsRepo.insert(
      {
        projectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: false,
        worktreeDir: tempDir,
        worktreeBranch: 'feature-branch',
        projectDir: tempDir,
        maxIterations: 10,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: 'test-model',
        auditorModel: 'test-auditor',
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
        executionVariant: null,
        auditorVariant: null,
        kind: 'plan',
      },
      { lastAuditResult: null },
    )
  }

  test('writes a clean brief to goal_briefs, not plans, and returns the stored report', async () => {
    const content = describeGoal()
    const result = await tools['goal-write'].execute({ content }, makeToolContext('sess-1'))

    expect(result).toMatch(/^Goal brief stored: \d+ lines, \d+ chars\./)
    const row = goalBriefsRepo.getForSession(projectId, 'sess-1')
    expect(row).not.toBeNull()
    expect(row!.content).toBe(content)
  })

  test('content with a forge-section marker performs no write and returns a goal-write failed message', async () => {
    const content = `${describeGoal()}\n<!-- forge-section -->\n## Phase 1\n- do one\n`
    const result = await tools['goal-write'].execute({ content }, makeToolContext('sess-1'))

    expect(result).toMatch(/^goal-write failed:/)
    expect(goalBriefsRepo.getForSession(projectId, 'sess-1')).toBeNull()
  })

  test('content with a Phase heading performs no write and returns a goal-write failed message', async () => {
    const content = `${describeGoal()}\n## Phase 1: Build it\n- do one\n`
    const result = await tools['goal-write'].execute({ content }, makeToolContext('sess-1'))

    expect(result).toMatch(/^goal-write failed:/)
    expect(goalBriefsRepo.getForSession(projectId, 'sess-1')).toBeNull()
  })

  test('a brief missing ## Constraints still writes and the report warns about it', async () => {
    const content = `## Goal
Ship the feature.

## Context
Some context.

## Acceptance Criteria
- it works.
`
    const result = await tools['goal-write'].execute({ content }, makeToolContext('sess-1'))

    expect(result).toMatch(/^Goal brief stored:/)
    expect(result).toContain('Warnings:')
    expect(result).toContain('Missing required section: ## Constraints')
    expect(goalBriefsRepo.getForSession(projectId, 'sess-1')!.content).toBe(content)
  })

  test('append: true concatenates onto existing content with exactly two newlines', async () => {
    const existing = `${describeGoal()}`
    goalBriefsRepo.writeForSession(projectId, 'sess-1', existing)

    const fragment = '## Notes\nAdditional context.\n'
    const result = await tools['goal-write'].execute(
      { content: fragment, append: true },
      makeToolContext('sess-1'),
    )

    expect(result).toMatch(/^Goal brief stored:/)
    const row = goalBriefsRepo.getForSession(projectId, 'sess-1')
    expect(row!.content).toBe(`${existing.trimEnd()}\n\n${fragment}`)
  })

  test('append: true on an empty store behaves as a create', async () => {
    const fragment = describeGoal()
    const result = await tools['goal-write'].execute(
      { content: fragment, append: true },
      makeToolContext('sess-1'),
    )

    expect(result).toMatch(/^Goal brief stored:/)
    const row = goalBriefsRepo.getForSession(projectId, 'sess-1')
    expect(row).not.toBeNull()
    expect(row!.content).toBe(fragment)
  })

  test('from a running-loop session performs no write and names the goal brief and active loop session', async () => {
    insertRunningLoop('test-loop', 'sess-1')

    const result = await tools['goal-write'].execute(
      { content: describeGoal() },
      makeToolContext('sess-1'),
    )

    expect(result).toContain('goal brief')
    expect(result).toContain('active loop session')
    expect(result).toContain('test-loop')
    expect(goalBriefsRepo.getForSession(projectId, 'sess-1')).toBeNull()
  })
})
