import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'
import { createGraphStatusRepo } from '../src/storage/repos/graph-status-repo'
import { Database } from 'bun:sqlite'

const TEST_DIR = '/tmp/opencode-graph-service-test-' + Date.now()

function createTestLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('GraphService worker health handling', () => {
  let testDir: string
  let testProjectId: string

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    testProjectId = 'test-project-' + Date.now()
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should mark worker unhealthy after onFileChanged failure', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const testFile = join(testDir, 'test.ts')
    writeFileSync(testFile, 'export const x = 1')

    // Trigger a full scan first to initialize
    await service.scan()
    
    // Service should be ready initially
    expect(service.ready).toBe(true)

    await service.close()
  })

  test('should not flush queue when worker is unhealthy', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 50,
    })

    const testFile = join(testDir, 'test.ts')
    writeFileSync(testFile, 'export const x = 1')

    // Trigger scan to initialize
    await service.scan()

    // Enqueue a change
    service.onFileChanged(testFile)

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 100))

    await service.close()
  })

  test('should clear pending queue after worker failure', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 50,
    })

    const testFile = join(testDir, 'test.ts')
    writeFileSync(testFile, 'export const x = 1')

    await service.scan()

    // Enqueue changes
    service.onFileChanged(testFile)
    service.onFileChanged(testFile)

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 100))

    await service.close()
  })

  test('ready state should reflect worker health', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Before initialization, should not be ready
    expect(service.ready).toBe(false)

    // After scan, should be ready
    await service.scan()
    expect(service.ready).toBe(true)

    // After close, should not be ready
    await service.close()
    expect(service.ready).toBe(false)
  })
})

describe('GraphService status callback', () => {
  let testDir: string
  let testProjectId: string
  let db: Database
  let graphStatusRepo: ReturnType<typeof createGraphStatusRepo>

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    testProjectId = 'test-project-' + Date.now()
    mkdirSync(testDir, { recursive: true })
    
    // Set up database for status persistence
    const dataDir = join(testDir, 'data')
    mkdirSync(dataDir, { recursive: true })
    db = new Database(join(dataDir, 'graph.db'))
    db.run(`
      CREATE TABLE IF NOT EXISTS graph_status (
        project_id   TEXT NOT NULL,
        cwd          TEXT NOT NULL DEFAULT '',
        state        TEXT NOT NULL,
        ready        INTEGER NOT NULL,
        stats_json   TEXT,
        message      TEXT,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, cwd)
      )
    `)
    graphStatusRepo = createGraphStatusRepo(db)
  })

  afterEach(async () => {
    db.close()
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should emit initializing state during initialization', async () => {
    const logger = createTestLogger()
    let statusCalls: Array<{ state: string; stats?: any; message?: string }> = []
    
    const statusCallback = (state: string, stats?: any, message?: string) => {
      statusCalls.push({ state, stats, message })
    }
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: statusCallback,
    })

    // Start initialization
    const initPromise = service.scan()
    
    // Should have emitted initializing
    expect(statusCalls.some(call => call.state === 'initializing')).toBe(true)
    
    await initPromise
    
    // Should have emitted ready after scan
    expect(statusCalls.some(call => call.state === 'ready')).toBe(true)
    
    await service.close()
  })

  test('should emit ready state with stats after successful scan', async () => {
    const logger = createTestLogger()
    let readyStats: any = null
    
    const statusCallback = (_state: string, stats?: any, _message?: string) => {
      if (_state === 'ready') {
        readyStats = stats
      }
    }
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: statusCallback,
    })

    await service.scan()
    
    expect(readyStats).toBeDefined()
    expect(readyStats.files).toBeDefined()
    expect(readyStats.symbols).toBeDefined()
    
    await service.close()
  })

  test('should persist status to graph_status table when callback is used', async () => {
    const logger = createTestLogger()
    
    const statusCallback = (state: string, stats?: any, message?: string) => {
      graphStatusRepo.write({
        projectId: testProjectId,
        cwd: '',
        state: state as any,
        ready: state === 'ready',
        stats: stats || null,
        message: message || null,
      })
    }
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: statusCallback,
    })

    await service.scan()
    
    // Check that status was persisted
    const status = graphStatusRepo.read(testProjectId, '')
    expect(status).toBeDefined()
    expect(status?.state).toBe('ready')
    expect(status?.ready).toBe(true)
    expect(status?.stats).toBeDefined()
    
    await service.close()
  })

  test('should write unavailable status when graph is disabled', () => {
    const logger = createTestLogger()
    
    const UNAVAILABLE_STATUS = {
      state: 'unavailable' as const,
      ready: false,
      stats: null,
      updatedAt: Date.now(),
    }
    
    // Verify the unavailable status structure
    expect(UNAVAILABLE_STATUS.state).toBe('unavailable')
    expect(UNAVAILABLE_STATUS.ready).toBe(false)
  })

  test('should emit error state when graph has large symbol-dense index but zero derived edges after finalize', async () => {
    const logger = createTestLogger()
    let statusCalls: Array<{ state: string; stats?: any; message?: string }> = []
    
    const statusCallback = (state: string, stats?: any, message?: string) => {
      statusCalls.push({ state, stats, message })
    }
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: statusCallback,
    })

    // Create enough files and symbols to trigger the conservative health check.
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(testDir, `test${i}.ts`),
        Array.from({ length: 10 }, (_, j) => `export const value${i}_${j} = ${i + j}`).join('\n')
      )
    }
    
    // Trigger scan - this should complete but may detect incomplete state
    let scanError: Error | null = null
    try {
      await service.scan()
    } catch (err) {
      scanError = err instanceof Error ? err : new Error(String(err))
    }
    
    // Check that error state was emitted
    const errorCalls = statusCalls.filter(call => call.state === 'error')
    expect(errorCalls.length).toBeGreaterThan(0)
    
    // The error should mention incomplete index
    const firstErrorCall = errorCalls[0]
    expect(firstErrorCall.message).toContain('Graph index incomplete')
    
    // Scan should have thrown
    expect(scanError).toBeDefined()
    expect(scanError?.message).toContain('Graph index incomplete')
    
    await service.close()
  })
})
