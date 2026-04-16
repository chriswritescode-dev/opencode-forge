import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { existsSync, rmSync } from 'fs'
import {
  readExecutionPreferences,
  writeExecutionPreferences,
  resolveExecutionDialogDefaults,
  type ExecutionPreferences,
} from '../src/utils/tui-execution-preferences'
import type { PluginConfig } from '../src/types'

const TEST_DB_PATH = join('/tmp', `test-execution-prefs-${Date.now()}.db`)

function createTestDb(dbPath: string) {
  const db = new Database(dbPath)
  db.run('PRAGMA busy_timeout=5000')
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, key)
    )
  `)
  db.close()
}

describe('Execution Preferences', () => {
  beforeEach(() => {
    // Clean up test DB if it exists
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH)
    }
    // Create fresh test DB
    createTestDb(TEST_DB_PATH)
  })

  afterEach(() => {
    // Clean up test DB
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH)
    }
  })

  test('readExecutionPreferences returns null when no prefs stored', () => {
    const projectId = 'test-project'
    const result = readExecutionPreferences(projectId, TEST_DB_PATH)
    expect(result).toBeNull()
  })

  test('writeExecutionPreferences stores prefs in KV', () => {
    const projectId = 'test-project'
    const prefs: ExecutionPreferences = {
      mode: 'Loop (worktree)',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    }

    const success = writeExecutionPreferences(projectId, prefs, TEST_DB_PATH)
    expect(success).toBe(true)

    const result = readExecutionPreferences(projectId, TEST_DB_PATH)
    expect(result).toEqual(prefs)
  })

  test('writeExecutionPreferences returns false when DB does not exist', () => {
    const projectId = 'test-project'
    const prefs: ExecutionPreferences = {
      mode: 'Loop (worktree)',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    }

    const nonExistentPath = join('/tmp', 'non-existent-' + Date.now() + '.db')
    const success = writeExecutionPreferences(projectId, prefs, nonExistentPath)
    expect(success).toBe(false)
  })

  test('resolveExecutionDialogDefaults uses stored prefs first', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      loop: { model: 'anthropic/claude-3-sonnet' },
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs: ExecutionPreferences = {
      mode: 'New session',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    }

    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.mode).toBe('New session')
    expect(result.executionModel).toBe('anthropic/claude-3-5-sonnet')
    expect(result.auditorModel).toBe('anthropic/claude-3-opus')
  })

  test('resolveExecutionDialogDefaults falls back to config when no stored prefs', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      loop: { model: 'anthropic/claude-3-sonnet' },
      auditorModel: 'anthropic/claude-3-opus',
    }

    const result = resolveExecutionDialogDefaults(config, null)
    expect(result.mode).toBe('Loop (worktree)')
    expect(result.executionModel).toBe('anthropic/claude-3-sonnet')
    expect(result.auditorModel).toBe('anthropic/claude-3-opus')
  })

  test('resolveExecutionDialogDefaults falls back through config hierarchy', () => {
    const config: Partial<PluginConfig> = {
      executionModel: 'anthropic/claude-3-haiku',
      // no loop.model
      // no auditorModel
    }

    const result = resolveExecutionDialogDefaults(config as PluginConfig, null)
    expect(result.executionModel).toBe('anthropic/claude-3-haiku')
    expect(result.auditorModel).toBe('anthropic/claude-3-haiku')
  })

  test('resolveExecutionDialogDefaults handles empty config', () => {
    const config: PluginConfig = {} as PluginConfig

    const result = resolveExecutionDialogDefaults(config, null)
    expect(result.mode).toBe('Loop (worktree)')
    expect(result.executionModel).toBe('')
    expect(result.auditorModel).toBe('')
  })

  test('write then read preserves all fields', () => {
    const projectId = 'test-project'
    const prefs: ExecutionPreferences = {
      mode: 'Execute here',
      executionModel: 'openai/gpt-4-turbo',
      auditorModel: 'openai/gpt-4o',
    }

    writeExecutionPreferences(projectId, prefs, TEST_DB_PATH)
    const result = readExecutionPreferences(projectId, TEST_DB_PATH)

    expect(result).toEqual(prefs)
  })

  test('writeExecutionPreferences does not mutate loop state records', () => {
    const projectId = 'test-project'
    
    // First, write a loop state record
    const loopStateKey = 'loop:test-loop'
    const loopState = {
      active: true,
      sessionId: 'session-123',
      loopName: 'test-loop',
      executionModel: 'original-exec-model',
      auditorModel: 'original-auditor-model',
    }
    
    // Manually write loop state to DB
    const db = new Database(TEST_DB_PATH)
    db.run('PRAGMA busy_timeout=5000')
    const now = Date.now()
    const TTL_MS = 7 * 24 * 60 * 60 * 1000
    db.prepare(
      'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      projectId,
      loopStateKey,
      JSON.stringify(loopState),
      now + TTL_MS,
      now,
      now
    )
    db.close()
    
    // Write execution preferences
    const prefs: ExecutionPreferences = {
      mode: 'New session',
      executionModel: 'pref-exec-model',
      auditorModel: 'pref-auditor-model',
    }
    writeExecutionPreferences(projectId, prefs, TEST_DB_PATH)
    
    // Verify loop state was not modified
    const loopDb = new Database(TEST_DB_PATH, { readonly: true })
    const loopRow = loopDb.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
    ).get(projectId, loopStateKey) as { data: string } | null
    
    expect(loopRow).toBeDefined()
    if (loopRow) {
      const retrievedState = JSON.parse(loopRow.data)
      expect(retrievedState.executionModel).toBe('original-exec-model')
      expect(retrievedState.auditorModel).toBe('original-auditor-model')
      expect(retrievedState.mode).toBeUndefined() // preferences key should not appear in loop state
    }
    loopDb.close()
  })
})
