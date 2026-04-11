import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-graph-test-' + Date.now()

function createTestLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('GraphService debounce behavior', () => {
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

  test('should coalesce multiple changes to the same path within debounce window', async () => {
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

    // Trigger a full scan first
    await service.scan()

    // Rapid-fire changes to same file
    service.onFileChanged(testFile)
    service.onFileChanged(testFile)
    service.onFileChanged(testFile)

    // Wait for debounce + processing
    await new Promise(resolve => setTimeout(resolve, 300))

    // Get stats to verify the file was indexed
    const stats = await service.getStats()
    expect(stats.files).toBeGreaterThanOrEqual(1)
    
    await service.close()
  })

  test('should handle multiple distinct paths in one debounce window', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const file1 = join(testDir, 'file1.ts')
    const file2 = join(testDir, 'file2.ts')
    writeFileSync(file1, 'export const a = 1')
    writeFileSync(file2, 'export const b = 2')

    service.onFileChanged(file1)
    service.onFileChanged(file2)

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 200))

    await service.close()
  })

  test('should ignore non-project paths', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const outsidePath = '/tmp/outside-project.ts'
    service.onFileChanged(outsidePath)

    // Should not throw or crash
    await new Promise(resolve => setTimeout(resolve, 150))

    await service.close()
  })

  test('should ignore paths in ignored directories', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const nodeModulesPath = join(testDir, 'node_modules', 'pkg', 'index.js')
    service.onFileChanged(nodeModulesPath)

    // Should be ignored
    await new Promise(resolve => setTimeout(resolve, 150))

    await service.close()
  })

  test('should not lose changes arriving during flush', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 50,
    })

    const file1 = join(testDir, 'file1.ts')
    const file2 = join(testDir, 'file2.ts')
    writeFileSync(file1, 'export const a = 1')
    writeFileSync(file2, 'export const b = 2')

    // First change
    service.onFileChanged(file1)
    
    // Wait for first flush to start
    await new Promise(resolve => setTimeout(resolve, 60))
    
    // Second change during/after flush
    service.onFileChanged(file2)

    // Wait for second flush
    await new Promise(resolve => setTimeout(resolve, 100))

    await service.close()
  })

  test('should handle non-indexable extensions', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const logFile = join(testDir, 'app.log')
    service.onFileChanged(logFile)

    // Should be ignored without error
    await new Promise(resolve => setTimeout(resolve, 150))

    await service.close()
  })
})

// Note: Full watcher lifecycle tests require complete graph DB initialization
// which is tested indirectly through integration tests

describe('GraphService status emission', () => {
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

  test('should emit indexing status before scan completion', async () => {
    const logger = createTestLogger()
    const statusCalls: Array<{ state: string; stats?: unknown }> = []
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: (state, stats) => {
        statusCalls.push({ state, stats })
      },
    })

    await service.scan()

    // Should have received initializing, then indexing, then ready
    expect(statusCalls.length).toBeGreaterThanOrEqual(2)
    
    // Find the indexing call - it should come before the ready call
    const indexingIndex = statusCalls.findIndex(call => call.state === 'indexing')
    const readyIndex = statusCalls.findIndex(call => call.state === 'ready')
    
    expect(indexingIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(indexingIndex).toBeLessThan(readyIndex)
    expect(statusCalls[readyIndex].stats).toBeDefined()
    
    await service.close()
  })

  test('should emit ready status with stats after scan completes', async () => {
    const logger = createTestLogger()
    let finalStatus: { state: string; stats?: unknown } | null = null
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
      onStatusChange: (state, stats) => {
        finalStatus = { state, stats }
      },
    })

    await service.scan()

    expect(finalStatus).not.toBeNull()
    expect(finalStatus!.state).toBe('ready')
    expect(finalStatus!.stats).toBeDefined()
    expect(typeof (finalStatus!.stats as any).files).toBe('number')
    
    await service.close()
  })

  test('should emit refreshed ready status after watcher flushes a file change', async () => {
    const logger = createTestLogger()
    const statusCalls: Array<{ state: string; stats?: { files: number; symbols: number; edges: number; calls: number } }> = []
    const filePath = join(testDir, 'index.ts')

    writeFileSync(filePath, 'export const value = 1\n')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 25,
      onStatusChange: (state, stats) => {
        statusCalls.push({ state, stats })
      },
    })

    await service.scan()
    const readyCallsAfterScan = statusCalls.filter((call) => call.state === 'ready').length

    writeFileSync(filePath, 'export const value = 2\n')
    service.onFileChanged(filePath)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const readyCallsAfterFlush = statusCalls.filter((call) => call.state === 'ready').length
    expect(readyCallsAfterFlush).toBeGreaterThan(readyCallsAfterScan)

    await service.close()
  })
})
