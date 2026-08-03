import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createSessionSandboxPreferencesRepo,
  SESSION_SANDBOX_DESIRED_KEY,
  SESSION_SANDBOX_APPLIED_KEY,
  SESSION_SANDBOX_CONTROLLER_KEY,
} from '../src/storage'
import { setupLoopsTestDb } from './helpers/loops-test-db'

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

function makeDesired(overrides: Partial<import('../src/storage').SessionSandboxDesiredState> = {}): import('../src/storage').SessionSandboxDesiredState {
  return { version: 1, revision: 'rev-1', enabled: true, sessionId: 'sess-1', requestedAt: 1000, ...overrides }
}

function makeApplied(overrides: Partial<import('../src/storage').SessionSandboxAppliedState> = {}): import('../src/storage').SessionSandboxAppliedState {
  return { version: 1, revision: 'rev-1', enabled: true, sessionId: 'sess-1', error: null, appliedAt: 2000, ...overrides }
}

describe('SessionSandboxPreferencesRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createSessionSandboxPreferencesRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-sandbox-preferences-repo-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)
    setupLoopsTestDb(db)
    repo = createSessionSandboxPreferencesRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('desired round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getDesired(PROJECT_A)).toBeNull()
    })

    test('round-trips a full desired state', () => {
      const state = makeDesired({ revision: 'abc', enabled: false, sessionId: 'sess-2', requestedAt: 999 })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('round-trips nullable sessionId', () => {
      const state = makeDesired({ sessionId: null })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('replacement overwrites prior value under the same key', () => {
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v1' }))
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v2', enabled: false }))
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({ revision: 'v2', enabled: false }))
    })
  })

  describe('applied round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('round-trips a full applied state', () => {
      const state = makeApplied({ revision: 'abc', enabled: false, sessionId: null, error: 'boom', appliedAt: 555 })
      repo.setApplied(PROJECT_A, state)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('round-trips null error and nullable sessionId', () => {
      const state = makeApplied({ sessionId: 'sess-x', error: null })
      repo.setApplied(PROJECT_A, state)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('replacement overwrites prior value under the same key', () => {
      repo.setApplied(PROJECT_A, makeApplied({ revision: 'v1', error: 'old' }))
      repo.setApplied(PROJECT_A, makeApplied({ revision: 'v2', error: null }))
      expect(repo.getApplied(PROJECT_A)).toEqual(makeApplied({ revision: 'v2', error: null }))
    })
  })

  describe('controller state round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getControllerState(PROJECT_A)).toBeNull()
    })

    test('round-trips controller readiness', () => {
      const state = { version: 1 as const, phase: 'loading' as const, revision: 'rev-1', sessionId: 'sess-1' }
      repo.setControllerState(PROJECT_A, state)
      expect(repo.getControllerState(PROJECT_A)).toEqual(state)
      expect(repo.getPair(PROJECT_A).controller).toEqual(state)
    })
  })

  describe('key independence', () => {
    test('desired and applied do not overwrite each other', () => {
      const desired = makeDesired({ revision: 'd1' })
      const applied = makeApplied({ revision: 'a1', error: 'err' })
      repo.setDesired(PROJECT_A, desired)
      repo.setApplied(PROJECT_A, applied)

      expect(repo.getDesired(PROJECT_A)).toEqual(desired)
      expect(repo.getApplied(PROJECT_A)).toEqual(applied)

      // Update one, the other stays intact
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'd2' }))
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({ revision: 'd2' }))
      expect(repo.getApplied(PROJECT_A)).toEqual(applied)
    })
  })

  describe('project isolation', () => {
    test('states under different project ids are independent', () => {
      const desiredA = makeDesired({ revision: 'a' })
      const desiredB = makeDesired({ revision: 'b' })
      repo.setDesired(PROJECT_A, desiredA)
      repo.setDesired(PROJECT_B, desiredB)

      expect(repo.getDesired(PROJECT_A)).toEqual(desiredA)
      expect(repo.getDesired(PROJECT_B)).toEqual(desiredB)

      const appliedA = makeApplied({ revision: 'a' })
      repo.setApplied(PROJECT_A, appliedA)
      expect(repo.getApplied(PROJECT_A)).toEqual(appliedA)
      expect(repo.getApplied(PROJECT_B)).toBeNull()
    })
  })

  describe('malformed-row handling', () => {
    function writeRaw(projectId: string, key: string, data: string): void {
      db.run(
        'INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?)',
        projectId,
        key,
        data,
        Date.now(),
      )
    }

    test('treats invalid JSON as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, '{not json')
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, 'nope')
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('rejects malformed controller state', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_CONTROLLER_KEY, JSON.stringify({ version: 1, phase: 'unknown', revision: 'rev-1', sessionId: 'sess-1' }))
      expect(repo.getControllerState(PROJECT_A)).toBeNull()
    })

    test('treats wrong version as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify(makeDesired({ version: 2 as never })))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify(makeApplied({ version: 0 as never })))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats non-boolean enabled as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), enabled: 'yes' }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), enabled: 1 }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats non-finite timestamp as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), requestedAt: Number.NaN }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), appliedAt: Infinity }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats wrong-type nullable fields as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), sessionId: 42 }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), error: 42 }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats empty or whitespace-only revision as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), revision: '' }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), revision: '   ' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats empty or whitespace-only non-null session identifier as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), sessionId: '' }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), sessionId: '  ' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('a malformed desired row does not mask a valid applied row', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, 'bad')
      const applied = makeApplied()
      repo.setApplied(PROJECT_A, applied)
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toEqual(applied)
    })
  })
})
