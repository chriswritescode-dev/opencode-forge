import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { waitForSandboxReady, type WaitForSandboxOptions } from '../../src/utils/sandbox-ready'
import type { LoopRow } from '../../src/storage'

describe('waitForSandboxReady', () => {
  let testDir: string
  let dbPath: string
  let db: Database | null = null
  let projectId: string

  beforeEach(() => {
    testDir = join(tmpdir(), `sandbox-ready-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    dbPath = join(testDir, 'test.db')
    projectId = `test-project-${Date.now()}`
  })

  afterEach(() => {
    try {
      db?.close()
      db = null
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  function createTestDb(): void {
    db = new Database(dbPath)
    // Create the loops table (not project_kv)
    db.run(`
      CREATE TABLE IF NOT EXISTS loops (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        status TEXT NOT NULL,
        current_session_id TEXT NOT NULL,
        worktree INTEGER NOT NULL,
        worktree_dir TEXT NOT NULL,
        worktree_branch TEXT,
        project_dir TEXT NOT NULL,
        max_iterations INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        audit_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        phase TEXT NOT NULL,
        execution_model TEXT,
        auditor_model TEXT,
        model_failed INTEGER NOT NULL,
        sandbox INTEGER NOT NULL,
        sandbox_container TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        termination_reason TEXT,
        completion_summary TEXT,
        workspace_id         TEXT,
        host_session_id      TEXT,
        audit_session_id     TEXT,
        session_directory    TEXT,
        PRIMARY KEY (project_id, loop_name)
      )
    `)
    // Also need loop_large_fields for FK
    db.run(`
      CREATE TABLE IF NOT EXISTS loop_large_fields (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        prompt TEXT,
        last_audit_result TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)
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
    createTestDb()
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
    createTestDb()
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
    createTestDb()
    insertLoopRow('test-loop', {
      sandbox: true,
      worktree: true,
      sandboxContainer: 'oc-forge-sandbox-test-loop',
    })

    const result = await waitForSandboxReady({
      projectId,
      loopName: 'test-loop',
      dbPath,
      pollMs: 50,
      timeoutMs: 500,
    })

    expect(result).toEqual({ ready: true, containerName: 'oc-forge-sandbox-test-loop' })
  })

  it('eventual ready - returns when container name is set after delay', async () => {
    createTestDb()
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
          sandboxContainer: 'oc-forge-sandbox-test-loop',
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

    expect(result).toEqual({ ready: true, containerName: 'oc-forge-sandbox-test-loop' })
  })

  it('timeout - returns timeout when container name never appears', async () => {
    createTestDb()
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
