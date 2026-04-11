import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createKvQuery } from '../src/storage/kv-queries'
import { createKvService } from '../src/services/kv'
import { createReviewTools } from '../src/tools/review'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-review-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
  return db
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('review-write', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    loopService = createLoopService(kvService, 'test-project', mockLogger)
    tools = createReviewTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })
  })

  afterEach(() => {
    db.close()
  })

  test('stores a review finding with automatic branch injection', async () => {
    const result = await tools['review-write'].execute(
      {
        file: 'src/services/auth.ts',
        line: 45,
        severity: 'bug',
        description: 'Missing null check',
        scenario: 'User session expires',
        status: 'open',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Stored review finding')
    expect(result).toContain('src/services/auth.ts:45')
    expect(result).toContain('bug')

    const stored = kvService.get('test-project', 'review-finding:src/services/auth.ts:45')
    expect(stored).toBeDefined()
    expect((stored as any).severity).toBe('bug')
    expect((stored as any).file).toBe('src/services/auth.ts')
    expect((stored as any).line).toBe(45)
    expect((stored as any).description).toBe('Missing null check')
    expect((stored as any).scenario).toBe('User session expires')
    expect((stored as any).status).toBe('open')
    expect((stored as any).date).toBeDefined()
  })
})

describe('review-read', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    loopService = createLoopService(kvService, 'test-project', mockLogger)
    tools = createReviewTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })

    // Seed with test data
    kvService.set('test-project', 'review-finding:src/file1.ts:10', {
      severity: 'bug',
      file: 'src/file1.ts',
      line: 10,
      description: 'Bug in file1',
      scenario: 'Scenario 1',
      status: 'open',
      date: '2026-04-08',
      branch: 'main',
    })
    kvService.set('test-project', 'review-finding:src/file2.ts:20', {
      severity: 'warning',
      file: 'src/file2.ts',
      line: 20,
      description: 'Warning in file2',
      scenario: 'Scenario 2',
      status: 'open',
      date: '2026-04-08',
      branch: 'main',
    })
  })

  afterEach(() => {
    db.close()
  })

  test('lists all findings when no args provided', async () => {
    const result = await tools['review-read'].execute(
      {},
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('2 review findings')
    expect(result).toContain('src/file1.ts:10')
    expect(result).toContain('src/file2.ts:20')
  })

  test('filters by file when file arg provided', async () => {
    const result = await tools['review-read'].execute(
      { file: 'src/file1.ts' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('1 review finding')
    expect(result).toContain('src/file1.ts:10')
    expect(result).not.toContain('src/file2.ts:20')
  })

  test('searches by pattern when pattern arg provided', async () => {
    const result = await tools['review-read'].execute(
      { pattern: 'Bug' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('1 review finding')
    expect(result).toContain('Bug in file1')
  })

  test('returns message when no findings found', async () => {
    const result = await tools['review-read'].execute(
      { file: 'nonexistent.ts' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No review findings found')
  })
})

describe('review-delete', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    loopService = createLoopService(kvService, 'test-project', mockLogger)
    tools = createReviewTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })

    // Seed with test data
    kvService.set('test-project', 'review-finding:src/file.ts:10', {
      severity: 'bug',
      file: 'src/file.ts',
      line: 10,
      description: 'Test bug',
      scenario: 'Test scenario',
      status: 'open',
      date: '2026-04-08',
      branch: 'main',
    })
  })

  afterEach(() => {
    db.close()
  })

  test('deletes a review finding', async () => {
    const result = await tools['review-delete'].execute(
      { file: 'src/file.ts', line: 10 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Deleted review finding')
    expect(result).toContain('src/file.ts:10')

    const deleted = kvService.get('test-project', 'review-finding:src/file.ts:10')
    expect(deleted).toBeNull()
  })
})
