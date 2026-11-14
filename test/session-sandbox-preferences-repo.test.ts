import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import {
  createSessionSandboxPreferencesRepo,
  SESSION_SANDBOX_DESIRED_KEY,
  SESSION_SANDBOX_APPLIED_KEY,
  SESSION_SANDBOX_CONTROLLER_KEY,
} from '../src/storage'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState } from '../src/storage'
import { withoutSandboxSession } from '../src/storage/session-sandbox-state'
import { createTestDb } from './helpers/test-db'

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

function makeDesired(overrides: Partial<SessionSandboxDesiredState> = {}): SessionSandboxDesiredState {
  return { version: 2, revision: 'rev-1', sessions: { 'sess-1': true }, requestedAt: 1000, ...overrides }
}

function makeApplied(overrides: Partial<SessionSandboxAppliedState> = {}): SessionSandboxAppliedState {
  return { version: 2, revision: 'rev-1', running: true, error: null, appliedAt: 2000, ...overrides }
}

describe('withoutSandboxSession', () => {
  test('returns null unchanged when no desired state exists', () => {
    expect(withoutSandboxSession(null, 'sess-1', 'rev-2')).toBeNull()
  })

  test('returns the same object when the session has no own entry', () => {
    const desired = makeDesired({ sessions: { 'sess-1': true } })
    expect(withoutSandboxSession(desired, 'sess-2', 'rev-2')).toBe(desired)
    expect(withoutSandboxSession(desired, 'toString', 'rev-2')).toBe(desired)
  })

  test('drops the entry with a new revision and preserves overrides without mutating the input', () => {
    const desired = makeDesired({ sessions: { 'sess-1': true, 'sess-2': false }, overrides: { allowLan: true } })
    const before = Date.now()
    const next = withoutSandboxSession(desired, 'sess-1', 'rev-2')

    expect(next).toEqual({
      version: 2,
      revision: 'rev-2',
      sessions: { 'sess-2': false },
      requestedAt: expect.any(Number),
      overrides: { allowLan: true },
    })
    expect(next?.requestedAt).toBeGreaterThanOrEqual(before)
    expect(desired.sessions).toEqual({ 'sess-1': true, 'sess-2': false })
  })
})

describe('SessionSandboxPreferencesRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createSessionSandboxPreferencesRepo>
  let testDb: ReturnType<typeof createTestDb>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    repo = createSessionSandboxPreferencesRepo(db)
  })

  afterEach(() => {
    testDb.cleanup()
  })

  describe('desired round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getDesired(PROJECT_A)).toBeNull()
    })

    test('round-trips a full desired state', () => {
      const state = makeDesired({ revision: 'abc', sessions: { 'sess-2': false, 'sess-3': true }, requestedAt: 999 })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('round-trips an empty session map', () => {
      const state = makeDesired({ sessions: {} })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('round-trips validated overrides on desired and applied rows and drops invalid fields', () => {
      repo.setDesired(PROJECT_A, makeDesired({ overrides: { resources: { cpus: '6', memory: 'lots' }, allowLan: true } }))
      repo.setApplied(PROJECT_A, makeApplied({ overrides: { allowLan: false } }))

      expect(repo.getDesired(PROJECT_A)?.overrides).toEqual({ resources: { cpus: '6' }, allowLan: true })
      expect(repo.getApplied(PROJECT_A)?.overrides).toEqual({ allowLan: false })
    })

    test('a row written before overrides existed reads back without them', () => {
      repo.setDesired(PROJECT_A, makeDesired())
      expect(repo.getDesired(PROJECT_A)).not.toHaveProperty('overrides')
    })

    test('updateDesired builds the new row from the current one', () => {
      repo.setDesired(PROJECT_A, makeDesired({ overrides: { allowLan: true } }))

      const next = repo.updateDesired(PROJECT_A, (current) => makeDesired({
        revision: 'rev-2',
        sessions: { ...(current?.sessions ?? {}), 'sess-9': false },
        overrides: current?.overrides,
      }))

      expect(next.revision).toBe('rev-2')
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({
        revision: 'rev-2',
        sessions: { 'sess-1': true, 'sess-9': false },
        overrides: { allowLan: true },
      }))
      expect(repo.updateDesired(PROJECT_B, (current) => makeDesired({ sessions: current?.sessions ?? {} })).sessions).toEqual({})
    })

    test('replacement overwrites prior value under the same key', () => {
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v1' }))
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v2', sessions: {} }))
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({ revision: 'v2', sessions: {} }))
    })
  })

  describe('legacy desired rows', () => {
    function writeRaw(projectId: string, key: string, data: string): void {
      db.run(
        'INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?)',
        [projectId, key, data, Date.now()],
      )
    }

    test('a legacy enabled row with a session parses into a single session entry', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({
        version: 1,
        revision: 'legacy-1',
        enabled: true,
        sessionId: 'sess-legacy',
        requestedAt: 500,
      }))

      expect(repo.getDesired(PROJECT_A)).toEqual({
        version: 2,
        revision: 'legacy-1',
        sessions: { 'sess-legacy': true },
        requestedAt: 500,
      })
    })

    test('a legacy disabled row with a session parses into a false session entry', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({
        version: 1,
        revision: 'legacy-2',
        enabled: false,
        sessionId: 'sess-legacy',
        requestedAt: 500,
      }))

      expect(repo.getDesired(PROJECT_A)).toEqual({
        version: 2,
        revision: 'legacy-2',
        sessions: { 'sess-legacy': false },
        requestedAt: 500,
      })
    })

    test('a legacy row without a session parses into an empty session map', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({
        version: 1,
        revision: 'legacy-3',
        enabled: true,
        sessionId: null,
        requestedAt: 500,
      }))

      expect(repo.getDesired(PROJECT_A)).toEqual({
        version: 2,
        revision: 'legacy-3',
        sessions: {},
        requestedAt: 500,
      })
    })

    test('a legacy applied row no longer parses and reads as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({
        version: 1,
        revision: 'legacy-1',
        enabled: true,
        sessionId: 'sess-legacy',
        error: null,
        appliedAt: 500,
      }))

      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })
  })

  describe('applied round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('round-trips a full applied state', () => {
      const state = makeApplied({ revision: 'abc', running: false, error: 'boom', appliedAt: 555 })
      repo.setApplied(PROJECT_A, state)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('round-trips null error', () => {
      const state = makeApplied({ error: null })
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
      const state = { version: 1 as const, phase: 'loading' as const, revision: 'rev-1' }
      repo.setControllerState(PROJECT_A, state)
      expect(repo.getControllerState(PROJECT_A)).toEqual(state)
      expect(repo.getPair(PROJECT_A).controller).toEqual(state)
    })

    test('round-trips a null revision', () => {
      const state = { version: 1 as const, phase: 'ready' as const, revision: null }
      repo.setControllerState(PROJECT_A, state)
      expect(repo.getControllerState(PROJECT_A)).toEqual(state)
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

      repo.setDesired(PROJECT_A, makeDesired({ revision: 'd2' }))
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({ revision: 'd2' }))
      expect(repo.getApplied(PROJECT_A)).toEqual(applied)
    })
  })

  describe('project isolation', () => {
    test('states under different project ids are independent', () => {
      const desiredA = makeDesired({ revision: 'a' })
      const desiredB = makeDesired({ revision: 'b', sessions: {} })
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
        [projectId, key, data, Date.now()],
      )
    }

    test('treats invalid JSON as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, '{not json')
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, 'nope')
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('rejects malformed controller state', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_CONTROLLER_KEY, JSON.stringify({ version: 1, phase: 'unknown', revision: 'rev-1' }))
      expect(repo.getControllerState(PROJECT_A)).toBeNull()
    })

    test('treats wrong version as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), version: 3 }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), version: 1 }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats non-boolean session values and running flag as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), sessions: { 'sess-1': 'yes' } }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), running: 1 }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats non-finite timestamp as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), requestedAt: Number.NaN }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), appliedAt: Infinity }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats wrong-type nullable error as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), error: 42 }))
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats empty or whitespace-only revision and session id as absent', () => {
      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired({ sessions: { '  ': true } }) }))
      writeRaw(PROJECT_A, SESSION_SANDBOX_APPLIED_KEY, JSON.stringify({ ...makeApplied(), revision: '   ' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()

      writeRaw(PROJECT_A, SESSION_SANDBOX_DESIRED_KEY, JSON.stringify({ ...makeDesired(), revision: '' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
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
