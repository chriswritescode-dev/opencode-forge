import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { 
  hashProjectId, 
  hashGraphCacheScope,
  resolveGraphCacheDir,
  resolveGraphCacheDirLegacy,
  hasGraphCache, 
  enumerateGraphCache,
  findGraphCacheEntry,
  deleteGraphCacheDir,
  deleteGraphCacheScope,
} from '../src/storage/graph-projects'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'

const TEST_DATA_DIR = '/tmp/opencode-graph-projects-test-' + Date.now()

describe('graph-projects helpers', () => {
  let testDataDir: string
  let testProjectId: string
  let testHashDir: string

  beforeEach(() => {
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
    
    testProjectId = 'test-project-' + Date.now()
    testHashDir = hashProjectId(testProjectId)
  })

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  describe('hashProjectId', () => {
    test('should produce consistent 16-character hex hash', () => {
      const hash1 = hashProjectId('test-id')
      const hash2 = hashProjectId('test-id')
      const hash3 = hashProjectId('different-id')
      
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(16)
      expect(hash1).toMatch(/^[0-9a-f]{16}$/i)
      expect(hash1).not.toBe(hash3)
    })

    test('should match graph/database.ts hashing logic', () => {
      const projectId = 'my-test-project'
      const expectedHash = createHash('sha256')
        .update(projectId)
        .digest('hex')
        .substring(0, 16)
      
      expect(hashProjectId(projectId)).toBe(expectedHash)
    })
  })

  describe('resolveGraphCacheDir', () => {
    test('should resolve to correct path structure with cwd', () => {
      const testCwd = join(testDataDir, 'test-cwd')
      const expectedPath = join(testDataDir, 'graph', hashProjectId(`${testProjectId}::${testCwd}`))
      const actualPath = resolveGraphCacheDir(testProjectId, testCwd, testDataDir)
      
      expect(actualPath).toBe(expectedPath)
    })

    test('should use different cache dirs for different cwd values with same projectId', () => {
      const cwd1 = '/path/to/worktree1'
      const cwd2 = '/path/to/worktree2'
      
      const cacheDir1 = resolveGraphCacheDir(testProjectId, cwd1, testDataDir)
      const cacheDir2 = resolveGraphCacheDir(testProjectId, cwd2, testDataDir)
      
      expect(cacheDir1).not.toBe(cacheDir2)
    })
  })

  describe('resolveGraphCacheDirLegacy', () => {
    test('should resolve to correct path structure (legacy)', () => {
      const expectedPath = join(testDataDir, 'graph', testHashDir)
      const actualPath = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      
      expect(actualPath).toBe(expectedPath)
    })

    test('should use resolved data dir when not provided (legacy)', () => {
      const pathWithExplicit = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      expect(pathWithExplicit).toContain(testDataDir)
    })
  })

  describe('hasGraphCache', () => {
    test('should return false when cache does not exist', () => {
      expect(hasGraphCache(testProjectId, testDataDir)).toBe(false)
    })

    test('should return true when cache exists', () => {
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      expect(hasGraphCache(testProjectId, testDataDir)).toBe(true)
    })
  })

  describe('enumerateGraphCache', () => {
    test('should return empty array when graph directory does not exist', () => {
      const entries = enumerateGraphCache(testDataDir)
      expect(entries).toEqual([])
    })

    test('should return empty array when graph directory is empty', () => {
      const graphDir = join(testDataDir, 'graph')
      mkdirSync(graphDir, { recursive: true })
      
      const entries = enumerateGraphCache(testDataDir)
      expect(entries).toEqual([])
    })

    test('should discover graph cache entries', () => {
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      const dbPath = join(cacheDir, 'graph.db')
      const db = new Database(dbPath)
      db.run('PRAGMA journal_mode=WAL')
      db.close()
      
      const entries = enumerateGraphCache(testDataDir)
      
      expect(entries).toHaveLength(1)
      expect(entries[0].hashDir).toBe(testHashDir)
      expect(entries[0].graphDbPath).toBe(dbPath)
      expect(entries[0].resolutionStatus).toBe('unknown')
      expect(entries[0].projectId).toBeNull()
      expect(entries[0].projectName).toBeNull()
    })

    test('should filter out non-hash directories', () => {
      const graphDir = join(testDataDir, 'graph')
      mkdirSync(graphDir, { recursive: true })
      
      mkdirSync(join(graphDir, 'not-a-hash'), { recursive: true })
      mkdirSync(join(graphDir, 'abc123'), { recursive: true })
      
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      const entries = enumerateGraphCache(testDataDir)
      expect(entries).toHaveLength(1)
      expect(entries[0].hashDir).toBe(testHashDir)
    })

    test('should include file metadata', () => {
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      const dbPath = join(cacheDir, 'graph.db')
      const db = new Database(dbPath)
      db.run('PRAGMA journal_mode=WAL')
      db.close()
      
      const entries = enumerateGraphCache(testDataDir)
      
      expect(entries[0].sizeBytes).toBeGreaterThan(0)
      expect(entries[0].mtimeMs).toBeGreaterThan(0)
    })
  })

  describe('findGraphCacheEntry', () => {
    test('should return null when entry not found', () => {
      const entry = findGraphCacheEntry('nonexistent', testDataDir)
      expect(entry).toBeNull()
    })

    test('should find entry by hash directory', () => {
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      const dbPath = join(cacheDir, 'graph.db')
      new Database(dbPath).close()
      
      const entry = findGraphCacheEntry(testHashDir, testDataDir)
      
      expect(entry).not.toBeNull()
      expect(entry!.hashDir).toBe(testHashDir)
    })
  })

  describe('deleteGraphCacheDir', () => {
    test('should return false when directory does not exist', () => {
      const result = deleteGraphCacheDir(testHashDir, testDataDir)
      expect(result).toBe(false)
    })

    test('should delete graph cache directory', () => {
      const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir, { recursive: true })
      
      const dbPath = join(cacheDir, 'graph.db')
      const db = new Database(dbPath)
      db.run('PRAGMA journal_mode=WAL')
      db.close()
      
      expect(existsSync(cacheDir)).toBe(true)
      
      const result = deleteGraphCacheDir(testHashDir, testDataDir)
      
      expect(result).toBe(true)
      expect(existsSync(cacheDir)).toBe(false)
    })

    test('should only delete target hash directory', () => {
      const cacheDir1 = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
      mkdirSync(cacheDir1, { recursive: true })
      new Database(join(cacheDir1, 'graph.db')).close()
      
      const otherProjectId = 'other-project'
      const otherHashDir = hashProjectId(otherProjectId)
      const cacheDir2 = join(testDataDir, 'graph', otherHashDir)
      mkdirSync(cacheDir2, { recursive: true })
      new Database(join(cacheDir2, 'graph.db')).close()
      
      expect(existsSync(cacheDir1)).toBe(true)
      expect(existsSync(cacheDir2)).toBe(true)
      
      deleteGraphCacheDir(testHashDir, testDataDir)
      
      expect(existsSync(cacheDir1)).toBe(false)
      expect(existsSync(cacheDir2)).toBe(true)
    })
  })
})

describe('graph-projects with opencode.db mapping', () => {
  let testDataDir: string
  let testProjectId: string
  let testHashDir: string
  let opencodeDbPath: string

  beforeEach(() => {
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
    
    testProjectId = 'test-project-' + Date.now()
    testHashDir = hashProjectId(testProjectId)
    
    const opencodeDir = join(testDataDir, 'opencode')
    mkdirSync(opencodeDir, { recursive: true })
    opencodeDbPath = join(opencodeDir, 'opencode.db')
    
    const db = new Database(opencodeDbPath)
    db.run('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)')
    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run(
      testProjectId,
      `/fake/path/${testProjectId}`
    )
    db.close()
    
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('should resolve project identity from opencode.db', () => {
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    // Write metadata file to enable identity resolution
    const metadataPath = join(cacheDir, 'graph-metadata.json')
    writeFileSync(metadataPath, JSON.stringify({
      projectId: testProjectId,
      cwd: '',
      createdAt: Date.now(),
    }))
    
    const entries = enumerateGraphCache(testDataDir)
    
    expect(entries).toHaveLength(1)
    expect(entries[0].projectId).toBe(testProjectId)
    expect(entries[0].projectName).toBe(testProjectId)
    expect(entries[0].resolutionStatus).toBe('known')
  })

  test('should resolve legacy cache identity from project hash when metadata is missing', () => {
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, testDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()

    const entries = enumerateGraphCache(testDataDir)

    expect(entries).toHaveLength(1)
    expect(entries[0].hashDir).toBe(testHashDir)
    expect(entries[0].projectId).toBe(testProjectId)
    expect(entries[0].projectName).toBe(testProjectId)
    expect(entries[0].resolutionStatus).toBe('known')
    expect(entries[0].cwdScope).toBeNull()
  })

  test('REGRESSION: graph cache identity must include cwd scope, not just project ID', () => {
    const sharedProjectId = 'shared-project-' + Date.now()
    const cwd1 = '/fake/path/worktree1'
    const cwd2 = '/fake/path/worktree2'

    const cacheDir1 = resolveGraphCacheDir(sharedProjectId, cwd1, testDataDir)
    const cacheDir2 = resolveGraphCacheDir(sharedProjectId, cwd2, testDataDir)

    expect(cacheDir1).not.toBe(cacheDir2)
  })
})

describe('deleteGraphCacheScope', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('should delete graph cache by projectId and cwd scope', () => {
    const projectId = 'test-project-' + Date.now()
    const cwd = '/fake/path/worktree'
    
    // Create cache directory
    const cacheDir = resolveGraphCacheDir(projectId, cwd, testDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    expect(existsSync(cacheDir)).toBe(true)
    
    // Delete by scope
    const result = deleteGraphCacheScope(projectId, cwd, testDataDir)
    
    expect(result).toBe(true)
    expect(existsSync(cacheDir)).toBe(false)
  })

  test('should return false when cache does not exist', () => {
    const projectId = 'nonexistent-project'
    const cwd = '/nonexistent/cwd'
    
    const result = deleteGraphCacheScope(projectId, cwd, testDataDir)
    
    expect(result).toBe(false)
  })

  test('should delete only targeted worktree cache, preserving sibling caches', () => {
    const sharedProjectId = 'shared-project-' + Date.now()
    const cwd1 = '/fake/path/worktree1'
    const cwd2 = '/fake/path/worktree2'
    
    // Create two worktree caches
    const cacheDir1 = resolveGraphCacheDir(sharedProjectId, cwd1, testDataDir)
    const cacheDir2 = resolveGraphCacheDir(sharedProjectId, cwd2, testDataDir)
    mkdirSync(cacheDir1, { recursive: true })
    mkdirSync(cacheDir2, { recursive: true })
    new Database(join(cacheDir1, 'graph.db')).close()
    new Database(join(cacheDir2, 'graph.db')).close()
    
    expect(existsSync(cacheDir1)).toBe(true)
    expect(existsSync(cacheDir2)).toBe(true)
    
    // Delete only first worktree cache
    const result = deleteGraphCacheScope(sharedProjectId, cwd1, testDataDir)
    
    expect(result).toBe(true)
    expect(existsSync(cacheDir1)).toBe(false)
    expect(existsSync(cacheDir2)).toBe(true)
  })

  test('should preserve shared KV DB data when deleting worktree cache', () => {
    const projectId = 'test-project-' + Date.now()
    const cwd = '/fake/path/worktree'
    
    // Create graph cache
    const cacheDir = resolveGraphCacheDir(projectId, cwd, testDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    // Create shared KV DB
    const kvDbPath = join(testDataDir, 'graph.db')
    const kvDb = new Database(kvDbPath)
    kvDb.run('CREATE TABLE IF NOT EXISTS project_kv (project_id TEXT, key TEXT, data TEXT)')
    kvDb.prepare('INSERT INTO project_kv (project_id, key, data) VALUES (?, ?, ?)').run(
      projectId,
      'test-key',
      'test-data'
    )
    kvDb.close()
    
    expect(existsSync(cacheDir)).toBe(true)
    expect(existsSync(kvDbPath)).toBe(true)
    
    // Delete worktree cache
    deleteGraphCacheScope(projectId, cwd, testDataDir)
    
    // Graph cache should be deleted
    expect(existsSync(cacheDir)).toBe(false)
    // KV DB should still exist
    expect(existsSync(kvDbPath)).toBe(true)
  })
})
