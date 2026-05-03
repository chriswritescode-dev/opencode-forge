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
import { createTuiPrefsRepo } from '../src/storage/repos/tui-prefs-repo'

const TEST_DB_PATH = join('/tmp', `test-execution-prefs-${Date.now()}.db`)

function createTestDb(dbPath: string) {
  const db = new Database(dbPath)
  db.run('PRAGMA busy_timeout=5000')
  db.run(`
    CREATE TABLE IF NOT EXISTS tui_preferences (
      project_id   TEXT NOT NULL,
      key          TEXT NOT NULL,
      data         TEXT NOT NULL,
      expires_at   INTEGER,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
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
    expect(result.executionModel).toBe('anthropic/claude-3-haiku')
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

  test('writeExecutionPreferences does not mutate other preference keys', () => {
    const projectId = 'test-project'
    
    // First, write another preference key
    const otherKey = 'other:test-key'
    const otherValue = {
      someField: 'original-value',
      anotherField: 'original-auditor-model',
    }
    
    // Manually write other preference to DB
    const db = new Database(TEST_DB_PATH)
    db.run('PRAGMA busy_timeout=5000')
    const repo = createTuiPrefsRepo(db)
    repo.set(projectId, otherKey, otherValue, 7 * 24 * 60 * 60 * 1000)
    db.close()
    
    // Write execution preferences
    const prefs: ExecutionPreferences = {
      mode: 'New session',
      executionModel: 'pref-exec-model',
      auditorModel: 'pref-auditor-model',
    }
    writeExecutionPreferences(projectId, prefs, TEST_DB_PATH)
    
    // Verify other key was not modified
    const loopDb = new Database(TEST_DB_PATH, { readonly: true })
    const otherRepo = createTuiPrefsRepo(loopDb)
    const retrieved = otherRepo.get(projectId, otherKey)
    
    expect(retrieved).toBeDefined()
    if (retrieved) {
      const typedRetrieved = retrieved as { someField: string; anotherField: string; mode?: string }
      expect(typedRetrieved.someField).toBe('original-value')
      expect(typedRetrieved.anotherField).toBe('original-auditor-model')
      expect(typedRetrieved.mode).toBeUndefined() // preferences key should not appear in other key
    }
    loopDb.close()
  })
})
