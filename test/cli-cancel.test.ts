import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, resolve } from 'path'
import { resolveGraphCacheDir } from '../src/storage/graph-projects'

function createTestDb(tempDir: string): Database {
  const dbPath = join(tempDir, 'memory.db')
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
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
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`CREATE UNIQUE INDEX idx_loops_session ON loops(project_id, current_session_id)`)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)

  return db
}

interface InsertLoopOptions {
  sessionId?: string
  active?: boolean
  status?: string
  phase?: 'coding' | 'auditing'
  iteration?: number
  maxIterations?: number
  worktreeBranch?: string
  worktreeDir?: string
  worktree?: boolean
  errorCount?: number
  auditCount?: number
  completedAt?: number | null
  terminationReason?: string | null
}

function insertLoopState(db: Database, projectId: string, loopName: string, opts: InsertLoopOptions): void {
  const now = Date.now()
  const sessionId = opts.sessionId ?? `session-${loopName}`
  const status = opts.status ?? (opts.active === false ? 'cancelled' : 'running')
  const phase = opts.phase ?? 'coding'
  const iteration = opts.iteration ?? 1
  const maxIterations = opts.maxIterations ?? 10
  const worktreeBranch = opts.worktreeBranch ?? 'main'
  const worktreeDir = opts.worktreeDir ?? '/tmp/test-worktree'
  const worktree = opts.worktree !== undefined ? (opts.worktree ? 1 : 0) : 1
  const errorCount = opts.errorCount ?? 0
  const auditCount = opts.auditCount ?? 0
  const completedAt = opts.completedAt ?? null
  const terminationReason = opts.terminationReason ?? null

  db.run(
    'INSERT OR REPLACE INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [projectId, loopName, status, sessionId, worktree, worktreeDir, worktreeBranch, worktreeDir, maxIterations, iteration, auditCount, errorCount, phase, null, null, 0, 0, null, now, completedAt, terminationReason, null]
  )
}

function createWorktreeRepo(baseDir: string, worktreeName: string): { repoDir: string; worktreeDir: string } {
  const repoDir = resolve(baseDir, 'repo')
  const worktreeDir = resolve(baseDir, worktreeName)
  mkdirSync(repoDir, { recursive: true })
  execSync('git init', { cwd: repoDir })
  execSync('git config user.email "test@test.com"', { cwd: repoDir })
  execSync('git config user.name "Test"', { cwd: repoDir })
  writeFileSync(join(repoDir, 'README.md'), '# test\n')
  execSync('git add README.md', { cwd: repoDir })
  execSync('git commit -m "init"', { cwd: repoDir })
  execSync(`git worktree add "${worktreeDir}" -b ${worktreeName}`, { cwd: repoDir })
  return { repoDir, worktreeDir }
}

describe('CLI Cancel', () => {
  let tempDir: string
  let originalLog: typeof console.log
  let originalError: typeof console.error

  beforeEach(() => {
    tempDir = mkdtempSync(join('.', 'temp-cancel-test-'))
    originalLog = console.log
    originalError = console.error
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('shows no active loops when KV is empty', async () => {
    const db = createTestDb(tempDir)
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      force: true,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('No active loops')
  })

  test('shows no active loops when all are inactive', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'inactive-worktree', {
      active: false,
      completedAt: Date.now(),
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      force: true,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('No active loops')
  })

  test('auto-selects single active loop with force', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'single-loop', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      force: true,
    })

    const db2 = new Database(join(tempDir, 'memory.db'))
    const row = db2.prepare('SELECT status, termination_reason, completed_at FROM loops WHERE loop_name = ?').get('single-loop') as { status: string; termination_reason: string; completed_at: number | null }
    db2.close()

    expect(row.status).not.toBe('running')
    expect(row.termination_reason).toBe('cancelled')
    expect(row.completed_at).toBeDefined()
  })

  test('cancellation sets correct state fields', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'test-loop', {})
    db.close()

    const beforeCancel = Date.now()
    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      force: true,
    })

    const db2 = new Database(join(tempDir, 'memory.db'))
    const row = db2.prepare('SELECT status, termination_reason, completed_at FROM loops WHERE loop_name = ?').get('test-loop') as { status: string; termination_reason: string; completed_at: number | null }
    db2.close()

    expect(row.status).not.toBe('running')
    expect(row.termination_reason).toBe('cancelled')
    expect(row.completed_at).toBeDefined()
    expect(row.completed_at!).toBeGreaterThanOrEqual(beforeCancel)
  })

  test('lists active loops when multiple exist and no name given', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-one', {})
    insertLoopState(db, 'test-project', 'loop-two', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)
    console.error = (msg: string) => outputLines.push(msg)

    let exited = false
    const originalExit = process.exit
    process.exit = (() => { exited = true; throw new Error('process.exit called') }) as any

    try {
      const { run } = await import('../src/cli/commands/cancel')
      await run({
        dbPath: join(tempDir, 'memory.db'),
        resolvedProjectId: 'test-project',
      })
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('process.exit')) {
        throw e
      }
    } finally {
      process.exit = originalExit
    }

    expect(exited).toBe(true)
    const output = outputLines.join('\n')
    expect(output).toContain('Multiple active loops')
    expect(output).toContain('loop-one')
    expect(output).toContain('loop-two')
  })

  test('finds loop by name when multiple active', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-alpha', {})
    insertLoopState(db, 'test-project', 'loop-beta', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      name: 'loop-beta',
      force: true,
    })

    const db2 = new Database(join(tempDir, 'memory.db'))
    const alphaRow = db2.prepare('SELECT status FROM loops WHERE loop_name = ?').get('loop-alpha') as { status: string }
    const betaRow = db2.prepare('SELECT status, termination_reason FROM loops WHERE loop_name = ?').get('loop-beta') as { status: string; termination_reason: string }
    db2.close()

    expect(alphaRow.status).toBe('running')
    expect(betaRow.status).not.toBe('running')
    expect(betaRow.termination_reason).toBe('cancelled')
  })

  test('partial name matches single loop proceeds with cancel', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {})
    insertLoopState(db, 'test-project', 'loop-fix-bug', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      name: 'auth',
      force: true,
    })

    const db2 = new Database(join(tempDir, 'memory.db'))
    const authRow = db2.prepare('SELECT status, termination_reason FROM loops WHERE loop_name = ?').get('loop-feat-auth') as { status: string; termination_reason: string }
    db2.close()

    expect(authRow.status).not.toBe('running')
    expect(authRow.termination_reason).toBe('cancelled')
  })

  test('partial name matches multiple loops lists ambiguous and exits', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {})
    insertLoopState(db, 'test-project', 'loop-auth-fix', {})
    db.close()

    const outputLines: string[] = []
    console.error = (msg: string) => outputLines.push(msg)

    let exited = false
    const originalExit = process.exit
    process.exit = (() => { exited = true; throw new Error('process.exit called') }) as any

    try {
      const { run } = await import('../src/cli/commands/cancel')
      await run({
        dbPath: join(tempDir, 'memory.db'),
        resolvedProjectId: 'test-project',
        name: 'auth',
      })
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('process.exit')) {
        throw e
      }
    } finally {
      process.exit = originalExit
    }

    expect(exited).toBe(true)
    const output = outputLines.join('\n')
    expect(output).toContain("Multiple loops match 'auth':")
    expect(output).toContain('loop-feat-auth')
    expect(output).toContain('loop-auth-fix')
  })

  test('loop cancel --cleanup deletes graph cache scope and terminates via LoopsRepo', async () => {
    const db = createTestDb(tempDir)
    const projectId = 'test-project'
    const loopName = 'cleanup-loop'
    const { worktreeDir } = createWorktreeRepo(tempDir, 'cleanup-worktree')
    const graphCacheDir = resolveGraphCacheDir(projectId, worktreeDir, tempDir)
    mkdirSync(graphCacheDir, { recursive: true })
    writeFileSync(join(graphCacheDir, 'graph.db'), 'cache')

    insertLoopState(db, projectId, loopName, { worktreeDir })
    db.close()

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: projectId,
      name: loopName,
      cleanup: true,
      force: true,
    })

    const db2 = new Database(join(tempDir, 'memory.db'))
    const row = db2.prepare('SELECT status, termination_reason, completed_at FROM loops WHERE loop_name = ?').get(loopName) as { status: string; termination_reason: string; completed_at: number | null }
    db2.close()

    expect(row.status).toBe('cancelled')
    expect(row.termination_reason).toBe('cancelled')
    expect(row.completed_at).toBeTruthy()
    expect(existsSync(worktreeDir)).toBe(false)
    expect(existsSync(graphCacheDir)).toBe(false)
  })

  test('loop cancel without --cleanup preserves graph cache scope and worktree dir', async () => {
    const db = createTestDb(tempDir)
    const projectId = 'test-project'
    const loopName = 'no-cleanup-loop'
    const { worktreeDir } = createWorktreeRepo(tempDir, 'no-cleanup-worktree')
    const graphCacheDir = resolveGraphCacheDir(projectId, worktreeDir, tempDir)
    mkdirSync(graphCacheDir, { recursive: true })
    writeFileSync(join(graphCacheDir, 'graph.db'), 'cache')

    insertLoopState(db, projectId, loopName, { worktreeDir })
    db.close()

    const { run } = await import('../src/cli/commands/cancel')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: projectId,
      name: loopName,
      force: true,
    })

    expect(existsSync(worktreeDir)).toBe(true)
    expect(existsSync(graphCacheDir)).toBe(true)
  })
})
