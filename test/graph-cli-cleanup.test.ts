import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { hashProjectId, resolveGraphCacheDir, resolveGraphCacheDirLegacy } from '../src/storage/graph-projects'
import { resolveDataDir } from '../src/storage/database'

const TEST_DATA_DIR = '/tmp/opencode-graph-cli-test-' + Date.now()

describe('graph CLI cleanup commands', () => {
  let testDataDir: string
  let testProjectId: string
  let testHashDir: string
  let originalEnv: string | undefined
  let resolvedDataDir: string

  beforeEach(() => {
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
    
    testProjectId = 'test-project-' + Date.now()
    testHashDir = hashProjectId(testProjectId)
    
    originalEnv = process.env['XDG_DATA_HOME']
    process.env['XDG_DATA_HOME'] = testDataDir
    
    const forgeDir = join(testDataDir, 'opencode', 'forge')
    mkdirSync(forgeDir, { recursive: true })
    
    resolvedDataDir = resolveDataDir()
  })

  afterEach(() => {
    if (originalEnv) {
      process.env['XDG_DATA_HOME'] = originalEnv
    } else {
      delete process.env['XDG_DATA_HOME']
    }
    
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('graph list should show empty when no cache exists', () => {
    const { spawnSync } = require('child_process')
    
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'list',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })
    
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No graph cache entries found')
  })

  test('graph list should display cache entries', () => {
    const { spawnSync } = require('child_process')
    
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, resolvedDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'list',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })
    
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(testHashDir)
    expect(result.stdout).toContain('graph.db')
  })

  test('graph list should display worktree scope for scoped caches', () => {
    const { spawnSync } = require('child_process')

    const cwdScope = '/fake/path/worktree-a'
    const cacheDir = resolveGraphCacheDir(testProjectId, cwdScope, resolvedDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    writeFileSync(join(cacheDir, 'graph-metadata.json'), JSON.stringify({
      projectId: testProjectId,
      cwd: cwdScope,
      createdAt: Date.now(),
    }))

    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'list',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Scope: ' + cwdScope)
  })

  test('graph remove should delete cache directory', () => {
    const { spawnSync } = require('child_process')
    
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, resolvedDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    expect(existsSync(cacheDir)).toBe(true)
    
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'remove',
      testHashDir,
      '--yes',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })
    
    expect(result.status).toBe(0)
    expect(existsSync(cacheDir)).toBe(false)
  })

  test('graph remove should fail for non-existent entry', () => {
    const { spawnSync } = require('child_process')
    
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'remove',
      'nonexistent-hash',
      '--yes',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })
    
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not found')
  })

  test('graph remove with --yes should skip confirmation', () => {
    const { spawnSync } = require('child_process')
    
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, resolvedDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const dbPath = join(cacheDir, 'graph.db')
    new Database(dbPath).close()
    
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'remove',
      testHashDir,
      '--yes',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
      input: '',
    })
    
    expect(result.status).toBe(0)
    expect(existsSync(cacheDir)).toBe(false)
  })

  test('graph remove should reject ambiguous project IDs across worktrees', () => {
    const { spawnSync } = require('child_process')

    const cwdScopeA = '/fake/path/worktree-a'
    const cwdScopeB = '/fake/path/worktree-b'
    const cacheDirA = resolveGraphCacheDir(testProjectId, cwdScopeA, resolvedDataDir)
    const cacheDirB = resolveGraphCacheDir(testProjectId, cwdScopeB, resolvedDataDir)

    mkdirSync(cacheDirA, { recursive: true })
    mkdirSync(cacheDirB, { recursive: true })
    new Database(join(cacheDirA, 'graph.db')).close()
    new Database(join(cacheDirB, 'graph.db')).close()

    writeFileSync(join(cacheDirA, 'graph-metadata.json'), JSON.stringify({
      projectId: testProjectId,
      cwd: cwdScopeA,
      createdAt: Date.now(),
    }))
    writeFileSync(join(cacheDirB, 'graph-metadata.json'), JSON.stringify({
      projectId: testProjectId,
      cwd: cwdScopeB,
      createdAt: Date.now(),
    }))

    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'remove',
      testProjectId,
      '--yes',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Multiple graph cache entries found for project ID')
    expect(result.stderr).toContain('worktree-a')
    expect(result.stderr).toContain('worktree-b')
    expect(existsSync(cacheDirA)).toBe(true)
    expect(existsSync(cacheDirB)).toBe(true)
  })

  test('graph remove should preserve shared TUI preferences data', () => {
    const { spawnSync } = require('child_process')
    
    const sharedDbPath = join(resolvedDataDir, 'graph.db')
    const sharedDb = new Database(sharedDbPath)
    
    sharedDb.run(`
      CREATE TABLE IF NOT EXISTS tui_preferences (
        project_id   TEXT NOT NULL,
        key          TEXT NOT NULL,
        data         TEXT NOT NULL,
        expires_at   INTEGER,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, key)
      )
    `)
    
    const kvData = JSON.stringify({ test: 'value' })
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    sharedDb.prepare(
      'INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(testProjectId, 'test:key', kvData, expiresAt, now)
    
    const cacheDir = resolveGraphCacheDirLegacy(testProjectId, resolvedDataDir)
    mkdirSync(cacheDir, { recursive: true })
    const graphDbPath = join(cacheDir, 'graph.db')
    new Database(graphDbPath).close()
    
    expect(existsSync(cacheDir)).toBe(true)
    
    const beforeCount = sharedDb.prepare('SELECT COUNT(*) as count FROM tui_preferences').get() as { count: number }
    expect(beforeCount.count).toBe(1)
    
    const removeResult = spawnSync('bun', [
      'src/cli/index.ts',
      'graph',
      'remove',
      testHashDir,
      '--yes',
    ], {
      env: { ...process.env, XDG_DATA_HOME: testDataDir },
      encoding: 'utf-8',
    })
    
    expect(removeResult.status).toBe(0)
    expect(existsSync(cacheDir)).toBe(false)
    
    const afterCount = sharedDb.prepare('SELECT COUNT(*) as count FROM tui_preferences').get() as { count: number }
    expect(afterCount.count).toBe(1)
    
    const kvEntry = sharedDb.prepare(
      'SELECT data FROM tui_preferences WHERE project_id = ? AND key = ?'
    ).get(testProjectId, 'test:key') as { data: string } | undefined
    expect(kvEntry).toBeDefined()
    expect(JSON.parse(kvEntry!.data)).toEqual({ test: 'value' })
    
    sharedDb.close()
  })
})
