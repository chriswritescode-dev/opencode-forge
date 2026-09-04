import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createTuiLoopRestartRepo,
  TUI_LOOP_RESTART_DESIRED_KEY,
  TUI_LOOP_RESTART_APPLIED_KEY,
} from '../../src/storage'
import type { TuiLoopRestartDesiredState, TuiLoopRestartAppliedState } from '../../src/storage'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

function makeDesired(overrides: Partial<TuiLoopRestartDesiredState> = {}): TuiLoopRestartDesiredState {
  return { version: 1, revision: 'rev-1', loopName: 'loop-1', auditorModel: 'model-x', auditorVariant: 'variant-y', requestedAt: 1000, ...overrides }
}

function makeApplied(overrides: Partial<TuiLoopRestartAppliedState> = {}): TuiLoopRestartAppliedState {
  return { version: 1, revision: 'rev-1', status: 'completed', ownerId: null, sessionId: 'sess-1', error: null, appliedAt: 2000, ...overrides }
}

describe('TuiLoopRestartRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createTuiLoopRestartRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tui-loop-restart-repo-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)
    setupLoopsTestDb(db)
    repo = createTuiLoopRestartRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  describe('desired round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getDesired(PROJECT_A)).toBeNull()
    })

    test('round-trips a full desired state', () => {
      const state = makeDesired({ revision: 'abc', loopName: 'loop-9', auditorModel: 'm', auditorVariant: 'v', requestedAt: 999 })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('round-trips the default auditor variant', () => {
      const state = makeDesired({ auditorVariant: '' })
      repo.setDesired(PROJECT_A, state)
      expect(repo.getDesired(PROJECT_A)).toEqual(state)
    })

    test('replacement overwrites prior value under the same key', () => {
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v1' }))
      repo.setDesired(PROJECT_A, makeDesired({ revision: 'v2', loopName: 'loop-2' }))
      expect(repo.getDesired(PROJECT_A)).toEqual(makeDesired({ revision: 'v2', loopName: 'loop-2' }))
    })

    test('accepts one pending desired request at a time', () => {
      expect(repo.trySetDesired(PROJECT_A, makeDesired({ revision: 'v1' }))).toBe(true)
      expect(repo.trySetDesired(PROJECT_A, makeDesired({ revision: 'v2' }))).toBe(false)
      repo.setApplied(PROJECT_A, makeApplied({ revision: 'v1' }))
      expect(repo.trySetDesired(PROJECT_A, makeDesired({ revision: 'v2' }))).toBe(true)
    })
  })

  describe('applied round-trip', () => {
    test('returns null when nothing stored', () => {
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('round-trips a full applied state', () => {
      const state = makeApplied({ revision: 'abc', sessionId: 'sess-9', error: 'boom', appliedAt: 555 })
      repo.setApplied(PROJECT_A, state)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('round-trips a processing state', () => {
      const state = makeApplied({ status: 'processing', ownerId: 'owner-1', sessionId: null, error: null })
      repo.setApplied(PROJECT_A, state)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('atomically claims a revision once', () => {
      const state = makeApplied({ status: 'processing', ownerId: 'owner-1', sessionId: null, appliedAt: 1000 })
      expect(repo.claim(PROJECT_A, state)).toBe(true)
      expect(repo.claim(PROJECT_A, state)).toBe(false)
      expect(repo.getApplied(PROJECT_A)).toEqual(state)
    })

    test('cannot replace a completed acknowledgement with a stale claim', () => {
      const completed = makeApplied({ revision: 'rev-1', sessionId: 'session-new' })
      repo.setApplied(PROJECT_A, completed)

      expect(repo.claim(PROJECT_A, makeApplied({
        revision: 'rev-1',
        status: 'processing',
        ownerId: 'owner-2',
        sessionId: null,
        appliedAt: 3000,
      }))).toBe(false)
      expect(repo.getApplied(PROJECT_A)).toEqual(completed)
    })

    test('cannot expire a processing claim after completion wins the race', () => {
      const processing = makeApplied({
        status: 'processing',
        ownerId: 'owner-1',
        sessionId: null,
        appliedAt: 1000,
      })
      const completed = makeApplied({ revision: processing.revision, sessionId: 'session-new' })
      repo.setApplied(PROJECT_A, processing)
      repo.setApplied(PROJECT_A, completed)

      expect(repo.compareAndSetApplied(PROJECT_A, processing, makeApplied({
        revision: processing.revision,
        sessionId: null,
        error: 'unknown outcome',
      }))).toBe(false)
      expect(repo.getApplied(PROJECT_A)).toEqual(completed)
    })

    test('replacement overwrites prior value under the same key', () => {
      repo.setApplied(PROJECT_A, makeApplied({ revision: 'v1', error: 'old' }))
      repo.setApplied(PROJECT_A, makeApplied({ revision: 'v2', error: null }))
      expect(repo.getApplied(PROJECT_A)).toEqual(makeApplied({ revision: 'v2', error: null }))
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

    test('keys do not collide with session sandbox keys', () => {
      const desired = makeDesired()
      repo.setDesired(PROJECT_A, desired)
      const raw = db.prepare('SELECT data FROM tui_preferences WHERE project_id = ? AND key = ?').get(PROJECT_A, 'session-sandbox.desired') as { data: string } | undefined
      expect(raw).toBeUndefined()
      expect(repo.getDesired(PROJECT_A)).toEqual(desired)
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

  describe('pair read', () => {
    test('returns both sides', () => {
      const desired = makeDesired({ revision: 'd1' })
      const applied = makeApplied({ revision: 'a1' })
      repo.setDesired(PROJECT_A, desired)
      repo.setApplied(PROJECT_A, applied)

      expect(repo.getPair(PROJECT_A)).toEqual({ desired, applied })
    })

    test('returns nulls when nothing stored', () => {
      expect(repo.getPair(PROJECT_A)).toEqual({ desired: null, applied: null })
    })

    test('reads desired and applied inside one SQLite transaction', () => {
      const desired = makeDesired()
      const applied = makeApplied()
      repo.setDesired(PROJECT_A, desired)
      repo.setApplied(PROJECT_A, applied)

      const transactionSpy = vi.spyOn(db, 'transaction')
      try {
        const pair = repo.getPair(PROJECT_A)
        expect(pair).toEqual({ desired, applied })
        expect(transactionSpy).toHaveBeenCalledTimes(1)
        expect(transactionSpy).toHaveBeenCalledWith(expect.any(Function))
        expect(transactionSpy.mock.calls[0][0]()).toEqual({ desired, applied })
      } finally {
        transactionSpy.mockRestore()
      }
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
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, '{not json')
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, 'nope')
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
      expect(repo.getPair(PROJECT_A)).toEqual({ desired: null, applied: null })
    })

    test('treats non-object JSON as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify('nope'))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify(null))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats wrong version as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify(makeDesired({ version: 2 as never })))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify(makeApplied({ version: 0 as never })))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats missing or wrong-type desired fields as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), loopName: 42 }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), auditorModel: null }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), auditorVariant: true }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), requestedAt: 'soon' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
    })

    test('treats non-finite timestamp as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), requestedAt: Number.NaN }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), appliedAt: Infinity }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats wrong-type nullable applied fields as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), sessionId: 42 }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), error: 7 }))
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats invalid applied state combinations as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), status: 'unknown' }))
      expect(repo.getApplied(PROJECT_A)).toBeNull()
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), sessionId: null, error: null }))
      expect(repo.getApplied(PROJECT_A)).toBeNull()
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), status: 'processing', sessionId: 'session' }))
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('treats empty or whitespace-only strings as absent', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), revision: '' }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, JSON.stringify({ ...makeDesired(), loopName: '   ' }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), revision: '' }))
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_APPLIED_KEY, JSON.stringify({ ...makeApplied(), sessionId: '  ' }))
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toBeNull()
    })

    test('a malformed desired row does not mask a valid applied row', () => {
      writeRaw(PROJECT_A, TUI_LOOP_RESTART_DESIRED_KEY, 'bad')
      const applied = makeApplied()
      repo.setApplied(PROJECT_A, applied)
      expect(repo.getDesired(PROJECT_A)).toBeNull()
      expect(repo.getApplied(PROJECT_A)).toEqual(applied)
      expect(repo.getPair(PROJECT_A)).toEqual({ desired: null, applied })
    })
  })
})
