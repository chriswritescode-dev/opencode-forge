import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { waitForSandboxReady } from '../../src/utils/sandbox-ready'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import type { LoopRow } from '../../src/storage'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { insertTestLoopRow } from '../helpers/loop-fixtures'

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
    insertTestLoopRow(db, {
      projectId,
      loopName,
      currentSessionId: 'test-session',
      worktree: true,
      worktreeDir: '/test/dir',
      projectDir: '/test/dir',
      iteration: 1,
      maxIterations: 0,
      sandbox: true,
      ...overrides,
    })
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
        createLoopsRepo(db).setSandboxContainer(projectId, 'test-loop', 'forge-test-loop')
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
