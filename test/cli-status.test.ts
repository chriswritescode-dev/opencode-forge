import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function createTestDb(tempDir: string): Database {
  const dbPath = join(tempDir, 'memory.db')
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id TEXT NOT NULL,
      worktree INTEGER NOT NULL,
      worktree_dir TEXT NOT NULL,
      worktree_branch TEXT,
      project_dir TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      audit_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      execution_model TEXT,
      auditor_model TEXT,
      model_failed INTEGER NOT NULL DEFAULT 0,
      sandbox INTEGER NOT NULL DEFAULT 0,
      sandbox_container TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      termination_reason TEXT,
      completion_summary TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
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

  return db
}

function insertLoopState(db: Database, projectId: string, loopName: string, state: {
  sessionId?: string
  worktreeBranch?: string | null
  worktreeDir?: string
  worktree?: boolean
  iteration?: number
  maxIterations?: number
  phase?: 'coding' | 'auditing'
  status?: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  startedAt?: number
  completedAt?: number | null
  terminationReason?: string | null
} = {}): void {
  const now = state.startedAt ?? Date.now()
  db.run(
    `INSERT INTO loops (
      project_id, loop_name, status, current_session_id, worktree, worktree_dir,
      worktree_branch, project_dir, max_iterations, iteration, audit_count,
      error_count, phase, execution_model, auditor_model,
      model_failed, sandbox, sandbox_container, started_at, completed_at,
      termination_reason, completion_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      loopName,
      state.status ?? 'running',
      state.sessionId ?? 'test-session-id',
      state.worktree ? 1 : 0,
      state.worktreeDir ?? '/tmp/test-worktree',
      state.worktreeBranch ?? null,
      state.worktreeDir ?? '/tmp/test-worktree',
      state.maxIterations ?? 10,
      state.iteration ?? 1,
      0,
      0,
      state.phase ?? 'coding',

      null,
      null,
      0,
      0,
      null,
      now,
      state.completedAt ?? null,
      state.terminationReason ?? null,
      null,
    ]
  )
}

describe('CLI Status - list-worktrees', () => {
  let tempDir: string
  let originalLog: typeof console.log

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'temp-status-test-'))
    originalLog = console.log
  })

  afterEach(() => {
    console.log = originalLog
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('lists active worktree names', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'worktree-one', {})
    insertLoopState(db, 'test-project', 'worktree-two', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      listWorktrees: true,
    })

    expect(outputLines).toContain('worktree-one')
    expect(outputLines).toContain('worktree-two')
  })

  test('includes inactive loops in list', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'inactive-worktree', { status: 'cancelled', completedAt: Date.now() })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      listWorktrees: true,
    })

    expect(outputLines).toContain('inactive-worktree')
  })
})

describe('CLI Status - summary', () => {
  let tempDir: string
  let originalLog: typeof console.log
  let originalError: typeof console.error

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'temp-status-summary-'))
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

  test('shows active loops when no name given', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'active-one', { startedAt: Date.now() - 3600000 })
    insertLoopState(db, 'test-project', 'active-two', { startedAt: Date.now() - 1800000 })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Active Loops:')
    expect(output).toContain('active-one')
    expect(output).toContain('active-two')
  })

  test('shows no loops message when empty', async () => {
    const db = createTestDb(tempDir)
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('No loops found')
  })

  test('shows recently completed loops', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'completed-one', {
      status: 'completed',
      completedAt: Date.now(),
      terminationReason: 'success',
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Recently Completed:')
    expect(output).toContain('completed-one')
  })

})

describe('CLI Status - partial matching', () => {
  let tempDir: string
  let originalLog: typeof console.log
  let originalError: typeof console.error

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'temp-status-partial-'))
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

  test('partial name matches single active loop', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {
      startedAt: Date.now() - 3600000,
    })
    insertLoopState(db, 'test-project', 'loop-fix-bug', {
      startedAt: Date.now() - 1800000,
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      name: 'auth',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Loop: loop-feat-auth')
  })

  test('partial name matches single recent loop', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-completed-auth', {
      status: 'completed',
      completedAt: Date.now(),
      terminationReason: 'success',
    })
    insertLoopState(db, 'test-project', 'loop-fix-bug', {
      startedAt: Date.now() - 1800000,
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      name: 'completed',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Loop (Completed): loop-completed-auth')
  })

  test('partial name matches multiple loops lists ambiguous', async () => {
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
      const { run } = await import('../src/cli/commands/status')
      await run({
        dbPath: join(tempDir, 'memory.db'),
        resolvedProjectId: 'test-project',
        server: 'http://localhost:5551',
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

  test('partial name matches via worktreeBranch field', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {
      worktreeBranch: 'feat/auth',
      startedAt: Date.now() - 3600000,
    })
    insertLoopState(db, 'test-project', 'loop-fix-bug', {
      worktreeBranch: 'fix/bug',
      startedAt: Date.now() - 1800000,
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      name: 'feat/auth',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Loop: loop-feat-auth')
    expect(output).toContain('Branch:          feat/auth')
  })

  test('case-insensitive matching works', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {
      startedAt: Date.now() - 3600000,
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      name: 'AUTH',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Loop: loop-feat-auth')
  })

  test('exact match takes priority over partial', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'auth', {
      startedAt: Date.now() - 3600000,
    })
    insertLoopState(db, 'test-project', 'loop-auth', {
      startedAt: Date.now() - 1800000,
    })
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      name: 'auth',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Loop: auth')
    expect(output).not.toContain('Loop: loop-auth')
  })

  test('--list-worktrees with filter returns filtered results', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', { worktreeBranch: 'feat/auth' })
    insertLoopState(db, 'test-project', 'loop-fix-bug', { worktreeBranch: 'fix/bug' })
    insertLoopState(db, 'test-project', 'loop-update-deps', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      listWorktrees: true,
      listWorktreesFilter: 'auth',
    })

    const output = outputLines.join('\n')
    expect(output).toContain('loop-feat-auth')
    expect(output).not.toContain('loop-fix-bug')
    expect(output).not.toContain('loop-update-deps')
  })

  test('--list-worktrees without filter returns all', async () => {
    const db = createTestDb(tempDir)
    insertLoopState(db, 'test-project', 'loop-feat-auth', {})
    insertLoopState(db, 'test-project', 'loop-fix-bug', {})
    db.close()

    const outputLines: string[] = []
    console.log = (msg: string) => outputLines.push(msg)

    const { run } = await import('../src/cli/commands/status')
    await run({
      dbPath: join(tempDir, 'memory.db'),
      resolvedProjectId: 'test-project',
      server: 'http://localhost:5551',
      listWorktrees: true,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('loop-feat-auth')
    expect(output).toContain('loop-fix-bug')
  })
})
