import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-graph-startup-test-' + Date.now()

function createTestLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('GraphService startup index decision', () => {
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

  test('should scan when metadata file is missing', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize the service (creates db path)
    await service.getStats()

    const decision = await service.shouldScanOnStartup()
    
    // First getStats creates the metadata, so it won't be missing
    // But since the graph DB is new, it will have 0 files
    expect(decision.shouldScan).toBe(true)
    expect(decision.reason).toMatch(/empty|metadata/)
    
    await service.close()
  })

  test('should scan when graph database is empty but repo has files', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache
    await service.scan()
    await service.close()

    // Manually corrupt the metadata to simulate missing indexed files
    const { readGraphCacheMetadata, writeGraphCacheMetadata } = await import('../src/graph/database')
    const graphDir = join(testDir, 'graph')
    const cacheDirs = existsSync(graphDir) 
      ? require('fs').readdirSync(graphDir)
      : []
    
    if (cacheDirs.length > 0) {
      const cachePath = join(graphDir, cacheDirs[0])
      const metadata = readGraphCacheMetadata(cachePath)
      if (metadata) {
        writeGraphCacheMetadata(cachePath, {
          indexedFileCount: 0,
          indexedMaxMtimeMs: 0,
        })
      }
    }

    // Create a new service instance
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path
    await service2.getStats()
    
    const decision = await service2.shouldScanOnStartup()
    
    // After corrupting metadata, indexedFileCount is 0 but current files > 0
    expect(decision.shouldScan).toBe(true)
    expect(decision.reason).toMatch(/File count changed|empty/)
    
    await service2.close()
  })

  test('should skip scan when fingerprint matches last successful scan', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache and persist metadata
    await service.scan()
    await service.close()

    // Create a new service instance - should reuse cache
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path and check decision
    await service2.getStats()
    const decision = await service2.shouldScanOnStartup()
    
    // Should skip scan since files haven't changed and metadata has fingerprint
    expect(decision.shouldScan).toBe(false)
    expect(decision.reason).toContain('fresh')
    
    await service2.close()
  })

  test('should scan when file count changes', async () => {
    const logger = createTestLogger()
    
    // Create initial test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache
    await service.scan()
    await service.close()

    // Add a new file
    const newFile = join(testDir, 'new-file.ts')
    writeFileSync(newFile, 'export const newValue = 2')

    // Create a new service instance - should detect file count change
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path
    await service2.getStats()
    
    const decision = await service2.shouldScanOnStartup()
    
    expect(decision.shouldScan).toBe(true)
    expect(decision.reason).toContain('File count changed')
    
    await service2.close()
  })

  test('should scan when max mtime increases (file modified)', async () => {
    const logger = createTestLogger()
    
    // Create initial test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache
    await service.scan()
    await service.close()

    // Wait a bit to ensure mtime difference
    await new Promise(resolve => setTimeout(resolve, 10))

    // Modify the existing file
    writeFileSync(testFile, 'export const value = 2')

    // Create a new service instance - should detect mtime change
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path
    await service2.getStats()
    
    const decision = await service2.shouldScanOnStartup()
    
    expect(decision.shouldScan).toBe(true)
    expect(decision.reason).toContain('mtime')
    
    await service2.close()
  })

  test('should skip scan when repo is empty', async () => {
    const logger = createTestLogger()
    
    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path
    await service.getStats()
    
    const decision = await service.shouldScanOnStartup()
    
    // Empty repo with no files - no scan needed (cache metadata exists but is empty)
    expect(decision.shouldScan).toBe(false)
    expect(decision.reason).toContain('empty')
    
    await service.close()
  })

  test('should scan when metadata is missing fingerprint fields (old format)', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache
    await service.scan()
    await service.close()

    // Manually remove fingerprint fields to simulate old metadata format
    const { readGraphCacheMetadata, writeGraphCacheMetadata } = await import('../src/graph/database')
    const graphDir = join(testDir, 'graph')
    const cacheDirs = existsSync(graphDir) 
      ? require('fs').readdirSync(graphDir)
      : []
    
    if (cacheDirs.length > 0) {
      const cachePath = join(graphDir, cacheDirs[0])
      const metadata = readGraphCacheMetadata(cachePath)
      if (metadata) {
        // Write back metadata without fingerprint fields
        writeGraphCacheMetadata(cachePath, {
          lastIndexedAt: metadata.lastIndexedAt,
          indexedFileCount: undefined,
          indexedMaxMtimeMs: undefined,
        })
      }
    }

    // Create a new service instance - should detect missing fingerprint fields
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // Initialize to get db path
    await service2.getStats()
    
    const decision = await service2.shouldScanOnStartup()
    
    // Should scan because fingerprint fields are missing
    expect(decision.shouldScan).toBe(true)
    expect(decision.reason).toContain('missing fingerprint')
    
    await service2.close()
  })

  test('ensureStartupIndex returns scanned when scan is performed', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    const result = await service.ensureStartupIndex()
    
    expect(result).toBe('scanned')
    
    await service.close()
  })

  test('ensureStartupIndex returns skipped when cache is fresh', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // First scan to build the cache
    await service.scan()
    await service.close()

    // Create a new service instance - should skip scan
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    // ensureStartupIndex handles initialization internally
    const result = await service2.ensureStartupIndex()
    
    // Should skip since cache is fresh and no files changed
    expect(result).toBe('skipped')
    
    await service2.close()
  })
})

describe('GraphService metadata persistence', () => {
  let testDir: string
  let testProjectId: string

  beforeEach(() => {
    testDir = TEST_DIR + '-metadata-' + Math.random().toString(36).slice(2)
    testProjectId = 'test-project-' + Date.now()
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should persist fingerprint metadata after successful scan', async () => {
    const logger = createTestLogger()
    
    // Create a test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    await service.scan()
    await service.close()

    // Check metadata file exists and contains fingerprint data
    const { readGraphCacheMetadata } = await import('../src/graph/database')
    const graphDir = join(testDir, 'graph')
    const cacheDirs = existsSync(graphDir) 
      ? require('fs').readdirSync(graphDir)
      : []
    
    expect(cacheDirs.length).toBeGreaterThan(0)
    
    const cachePath = join(graphDir, cacheDirs[0])
    const metadata = readGraphCacheMetadata(cachePath)
    
    expect(metadata).not.toBeNull()
    expect(metadata?.lastIndexedAt).toBeDefined()
    expect(metadata?.indexedFileCount).toBeGreaterThan(0)
    expect(metadata?.indexedMaxMtimeMs).toBeGreaterThan(0)
  })

  test('should update metadata on subsequent scans', async () => {
    const logger = createTestLogger()
    
    // Create initial test file
    const testFile = join(testDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const service = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    await service.scan()
    await service.close()

    // Get initial metadata
    const { readGraphCacheMetadata } = await import('../src/graph/database')
    const graphDir = join(testDir, 'graph')
    const cacheDirs = existsSync(graphDir) 
      ? require('fs').readdirSync(graphDir)
      : []
    
    const cachePath = join(graphDir, cacheDirs[0])
    const initialMetadata = readGraphCacheMetadata(cachePath)
    const initialIndexedAt = initialMetadata?.lastIndexedAt

    // Wait to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 10))

    // Add a new file
    const newFile = join(testDir, 'new-file.ts')
    writeFileSync(newFile, 'export const newValue = 2')

    // Create new service and scan again
    const service2 = createGraphService({
      projectId: testProjectId,
      dataDir: testDir,
      cwd: testDir,
      logger,
      watch: false,
      debounceMs: 100,
    })

    await service2.scan()
    await service2.close()

    // Check metadata was updated
    const updatedMetadata = readGraphCacheMetadata(cachePath)
    
    expect(updatedMetadata?.lastIndexedAt).toBeGreaterThan(initialIndexedAt || 0)
    // File count should be at least 2 (original + new file), may be more if test dir has other files
    expect(updatedMetadata?.indexedFileCount).toBeGreaterThanOrEqual(2)
  })
})
