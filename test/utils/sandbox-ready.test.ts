import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { waitForSandboxReady } from '../../src/utils/sandbox-ready'
import type { LoopRow } from '../../src/storage'
import { createTestDb, type TestDb } from '../helpers/test-db'

describe('waitForSandboxReady', () => {
  let testDir: string
  let dbPath: string
  let db: Database | null = null
  let testDb: TestDb | null = null
  let projectId: string

  beforeEach(() => {
    testDir = join(tmpdir(), `sandbox-ready-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    dbPath = join(testDir, 'test.db')
    projectId = `test-project-${Date.now()}`
  })

  afterEach(() => {
    try {
      testDb?.cleanup()
      testDb = null
      db = null
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  function openTestDb(): void {
    testDb = createTestDb({ path: dbPath })
    db = testDb.db
  }

  function insertLoopRow(loopName: string, overrides?: Partial<LoopRow>): void {
    if (!db) return
    const row: LoopRow = {
      projectId,
      loopName,
      status: 'running',
      currentSessionId: 'test-session',
      worktreeDir: '/test/dir',
      projectDir: '/test/dir',
      iteration: 1,
      maxIterations: 0,
      startedAt: Date.now(),
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      sandbox: true,
      worktree: true,
      worktreeBranch: null,

      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      executionVariant: null,
      auditorVariant: null,
      baseCommit: null,
      standbySessionId: null,
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandboxContainer: null,
      completedAt: null,
      terminationReason: null,
      ...overrides,
    }
    db.prepare(
      `INSERT OR REPLACE INTO loops (
        project_id, loop_name, status, current_session_id, worktree, worktree_dir,
        worktree_branch, project_dir, max_iterations, iteration, audit_count,
        error_count, phase, execution_model, auditor_model,
        model_failed, sandbox, sandbox_container, started_at, completed_at,
        termination_reason, completion_summary, workspace_id, host_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.projectId,
      row.loopName,
      row.status,
      row.currentSessionId,
      row.worktree ? 1 : 0,
      row.worktreeDir,
      row.worktreeBranch,
      row.projectDir,
      row.maxIterations,
      row.iteration,
      row.auditCount,
      row.errorCount,
      row.phase,
      row.executionModel,
      row.auditorModel,
      row.modelFailed ? 1 : 0,
      row.sandbox ? 1 : 0,
      row.sandboxContainer,
      row.startedAt,
      row.completedAt,
      row.terminationReason,
      row.completionSummary,
      row.workspaceId,
      row.hostSessionId
    )
  }

  it('db_missing - returns immediately when database does not exist', async () => {
    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath: join(testDir, 'nonexistent.db'),
    })

    expect(result).toEqual({ ready: false, reason: 'db_missing' })
  })

  it('not_sandbox_enabled - returns immediately when sandbox is false', async () => {
    openTestDb()
    insertLoopRow('test-loop', {
      sandbox: false,
      worktree: true,
    })

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 500,
    })

    expect(result).toEqual({ ready: false, reason: 'not_sandbox_enabled' })
  })

  it('state_missing - polls until timeout when state does not exist', async () => {
    openTestDb()
    // Don't set any loop state

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'nonexistent-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 200,
    })

    expect(result).toEqual({ ready: false, reason: 'timeout' })
  })

  it('ready - returns immediately when container name is set', async () => {
    openTestDb()
    insertLoopRow('test-loop', {
      sandbox: true,
      worktree: true,
      sandboxContainer: 'forge-test-loop',
    })

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 500,
    })

    expect(result).toEqual({ ready: true, containerName: 'forge-test-loop' })
  })

  it('eventual ready - returns when container name is set after delay', async () => {
    openTestDb()
    insertLoopRow('test-loop', {
      sandbox: true,
      worktree: true,
      sandboxContainer: null,
    })

    // Simulate container being started after 100ms
    setTimeout(() => {
      if (db) {
        insertLoopRow('test-loop', {
          sandbox: true,
          worktree: true,
          sandboxContainer: 'forge-test-loop',
        })
      }
    }, 100)

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 2000,
    })

    expect(result).toEqual({ ready: true, containerName: 'forge-test-loop' })
  })

  it('error - reports a read failure as error, not as a timeout', async () => {
    writeFileSync(dbPath, 'not a sqlite database')

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 200,
    })

    expect(result.ready).toBe(false)
    expect(result).toMatchObject({ reason: 'error' })
  })

  it('timeout - returns timeout when container name never appears', async () => {
    openTestDb()
    insertLoopRow('test-loop', {
      sandbox: true,
      worktree: true,
      sandboxContainer: null,
    })

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 200,
    })

    expect(result).toEqual({ ready: false, reason: 'timeout' })
  })
})
