import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { Worker } from 'worker_threads'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  awaitSessionSandboxState,
  beginSessionSandboxStateRequest,
  deriveSessionSandboxAcknowledged,
  hostSandboxToggleBlocked,
  isSessionSandboxPreferenceSettled,
  readSessionSandboxPreference,
  writeSessionSandboxDesired,
  requestSessionSandboxState,
} from '../../src/tui/session-sandbox-store'
import { createSessionSandboxPreferencesRepo } from '../../src/storage'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState } from '../../src/storage'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT_A = 'project-a'

describe('session-sandbox-store (TUI bridge)', () => {
  let tempDir: string
  let dbPath: string
  let db: Database
  let repo: ReturnType<typeof createSessionSandboxPreferencesRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-sandbox-store-test-'))
    dbPath = join(tempDir, 'forge.db')
    db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
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

  function writeApplied(overrides: Partial<SessionSandboxAppliedState> = {}): SessionSandboxAppliedState {
    const applied: SessionSandboxAppliedState = {
      version: 1,
      revision: 'rev-applied',
      enabled: true,
      sessionId: 'sess-1',
      error: null,
      appliedAt: Date.now(),
      ...overrides,
    }
    repo.setApplied(PROJECT_A, applied)
    return applied
  }

  describe('hostSandboxToggleBlocked', () => {
    test('blocks the toggle when sandboxing is disabled by config', () => {
      expect(hostSandboxToggleBlocked(false)).toBe('Host sandbox is disabled by config (sandbox.enabled: false)')
    })

    test('allows the toggle when sandboxing is enabled by config', () => {
      expect(hostSandboxToggleBlocked(true)).toBeNull()
    })
  })

  describe('readSessionSandboxPreference', () => {
    test('returns both null and unavailable when the database file is missing', () => {
      const missing = join(tempDir, 'does-not-exist.db')
      expect(readSessionSandboxPreference(PROJECT_A, missing)).toEqual({
        desired: null,
        applied: null,
        unavailable: true,
        unavailableReason: 'database file not found',
      })
    })

    test('returns both null and unavailable when the table is uninitialized', () => {
      const emptyDbPath = join(tempDir, 'empty.db')
      const empty = new Database(emptyDbPath)
      empty.close()
      const pref = readSessionSandboxPreference(PROJECT_A, emptyDbPath)
      expect(pref).toMatchObject({ desired: null, applied: null, unavailable: true })
      // The reason must name the missing table so a misresolved database path is diagnosable
      // rather than surfacing as an opaque "unavailable".
      expect(pref.unavailableReason).toMatch(/tui_preferences/)
    })

    test('reads persisted desired and applied rows', () => {
      const desired = { version: 1 as const, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 100 }
      const applied = writeApplied({ revision: 'r1' })
      repo.setDesired(PROJECT_A, desired)

      const pref = readSessionSandboxPreference(PROJECT_A, dbPath)
      expect(pref.desired).toEqual(desired)
      expect(pref.applied).toEqual(applied)
    })

    test('reads rows for the correct project only', () => {
      repo.setDesired(PROJECT_A, { version: 1 as const, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 1 })
      expect(readSessionSandboxPreference('project-b', dbPath)).toEqual({ desired: null, applied: null, unavailable: false })
    })

    test('does not create a missing database file', () => {
      const missing = join(tempDir, 'never-created.db')
      expect(readSessionSandboxPreference(PROJECT_A, missing)).toEqual({
        desired: null,
        applied: null,
        unavailable: true,
        unavailableReason: 'database file not found',
      })
      expect(existsSync(missing)).toBe(false)
    })

    test('returns nulls when the file exists but is unreadable', () => {
      const corruptPath = join(tempDir, 'corrupt.db')
      writeFileSync(corruptPath, 'this is not a sqlite database at all, definitely not')
      // Opening succeeds lazily; the first query fails and is swallowed, and the
      // locally opened handle is closed in the finally block.
      const pref = readSessionSandboxPreference(PROJECT_A, corruptPath)
      expect(pref).toMatchObject({ desired: null, applied: null, unavailable: true })
      expect(pref.unavailableReason).toBeTruthy()
    })

    test('reports unavailable until the table exists, then available once initialized', () => {
      const path = join(tempDir, 'delayed.db')
      // A transiently unavailable read (missing DB) must be distinguishable from "no persisted
      // state" so the TUI keeps polling instead of permanently showing OFF.
      expect(readSessionSandboxPreference(PROJECT_A, path)).toEqual({
        desired: null,
        applied: null,
        unavailable: true,
        unavailableReason: 'database file not found',
      })

      // Server initializes the DB and table; the same read now reports available.
      const initialized = new Database(path)
      setupLoopsTestDb(initialized)
      initialized.close()
      expect(readSessionSandboxPreference(PROJECT_A, path)).toEqual({ desired: null, applied: null, unavailable: false })
    })

    test('assembles desired and applied from one snapshot despite an intervening desired write', async () => {
      // A concurrent writer commits atomic (desired, applied) pairs whose
      // revisions always match. Any reader must therefore see either the
      // pre-commit or post-commit pair, never a mix across commit boundaries.
      // The pre-fix code read the two keys as separate autocommit queries, so a
      // commit landing between them could yield mismatched revisions and briefly
      // trust a superseded ON state.
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads')
        const Database = require('better-sqlite3')
        const db = new Database(workerData.dbPath)
        db.pragma('journal_mode = WAL')
        db.pragma('busy_timeout = 5000')
        const upsert = db.prepare(
          'INSERT INTO tui_preferences (project_id, key, data, expires_at, updated_at) ' +
          'VALUES (?, ?, ?, NULL, ?) ' +
          'ON CONFLICT(project_id, key) DO UPDATE SET data = excluded.data, expires_at = NULL, updated_at = excluded.updated_at'
        )
        const writePair = db.transaction((rev) => {
          const now = Date.now()
          upsert.run(workerData.projectId, workerData.desiredKey,
            JSON.stringify({ version: 1, revision: rev, enabled: true, sessionId: 'sess-1', requestedAt: now }), now)
          upsert.run(workerData.projectId, workerData.appliedKey,
            JSON.stringify({ version: 1, revision: rev, enabled: true, sessionId: 'sess-1', error: null, appliedAt: now }), now)
        })
        const start = Date.now()
        let i = 0
        while (Date.now() - start < workerData.durationMs) {
          i++
          writePair('r' + i)
        }
        parentPort.postMessage({ writes: i })
      `
      const worker = new Worker(workerCode, {
        eval: true,
        workerData: {
          dbPath,
          projectId: PROJECT_A,
          desiredKey: 'session-sandbox.desired',
          appliedKey: 'session-sandbox.applied',
          durationMs: 500,
        },
      })
      const done = new Promise<{ writes: number }>((resolve) => worker.once('message', resolve))

      let reads = 0
      let violation: string | null = null
      const end = Date.now() + 500
      while (Date.now() < end) {
        const pref = readSessionSandboxPreference(PROJECT_A, dbPath)
        reads++
        if (pref.desired && pref.applied && pref.desired.revision !== pref.applied.revision) {
          violation = `desired=${pref.desired.revision} applied=${pref.applied.revision}`
          break
        }
      }
      const { writes } = await done
      await worker.terminate()

      expect(writes).toBeGreaterThan(0)
      expect(reads).toBeGreaterThan(0)
      expect(violation).toBeNull()
    })
  })

  describe('writeSessionSandboxDesired', () => {
    test('persists desired and surfaces it on read', () => {
      const desired = { version: 1 as const, revision: 'r9', enabled: false, sessionId: 'sess-2', requestedAt: 42 }
      writeSessionSandboxDesired(PROJECT_A, dbPath, desired)
      expect(readSessionSandboxPreference(PROJECT_A, dbPath).desired).toEqual(desired)
    })

    test('throws when the database file is missing', () => {
      const missing = join(tempDir, 'does-not-exist.db')
      expect(() =>
        writeSessionSandboxDesired(PROJECT_A, missing, {
          version: 1,
          revision: 'r1',
          enabled: true,
          sessionId: 'sess-1',
          requestedAt: 1,
        }),
      ).toThrow()
      expect(existsSync(missing)).toBe(false)
    })

    test('throws when the table is uninitialized instead of creating a schema', () => {
      const emptyDbPath = join(tempDir, 'empty.db')
      const empty = new Database(emptyDbPath)
      empty.close()
      expect(() =>
        writeSessionSandboxDesired(PROJECT_A, emptyDbPath, {
          version: 1,
          revision: 'r1',
          enabled: true,
          sessionId: 'sess-1',
          requestedAt: 1,
        }),
      ).toThrow()
    })
  })

  describe('deriveSessionSandboxAcknowledged', () => {
    function desired(overrides: Partial<SessionSandboxDesiredState> = {}) {
      return { version: 1 as const, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 1, ...overrides }
    }

    test('derives ON only for a matching, error-free applied row', () => {
      const applied = writeApplied({ revision: 'r1', enabled: true, error: null })
      const pref = { desired: desired(), applied }
      expect(deriveSessionSandboxAcknowledged(pref)).toEqual(applied)
    })

    test('derives OFF while the matching applied row has not arrived yet', () => {
      // A late acknowledgement: the TUI reads before server reconciliation
      // writes the applied row, so it must not report ON prematurely.
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: null })).toBeNull()
    })

    test('derives the matching applied row when it arrives after an earlier read', () => {
      // The polling refresh re-reads after the initial snapshot, so a matching
      // applied ON written after initialization must transition to ON.
      const before = deriveSessionSandboxAcknowledged({ desired: desired(), applied: null })
      expect(before).toBeNull()
      const applied = writeApplied({ revision: 'r1', enabled: true, error: null })
      const after = deriveSessionSandboxAcknowledged({ desired: desired(), applied })
      expect(after).toEqual(applied)
    })

    test('derives OFF for a mismatched or stale applied revision', () => {
      const stale = writeApplied({ revision: 'old-rev', enabled: true, error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: stale })).toBeNull()
      const wrongSession = writeApplied({ revision: 'r1', enabled: true, sessionId: 'sess-other', error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: wrongSession })).toBeNull()
    })

    test('derives OFF for a matching revision carrying an error or disabled desired', () => {
      const errored = writeApplied({ revision: 'r1', enabled: true, error: 'sbx failed' })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: errored })).toBeNull()
      const disabledDesired = desired({ enabled: false })
      expect(deriveSessionSandboxAcknowledged({ desired: disabledDesired, applied: errored })).toBeNull()
    })

    test('derives OFF when an ON acknowledgement is superseded by a newer desired revision', () => {
      // An ON request resolves at revision r1, but a subsequent toggle already moved
      // the desired revision to r2 (still pending application). Deriving from the
      // authoritative pair must not publish the stale ON.
      const staleOn = writeApplied({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null })
      const superseded = desired({ revision: 'r2', enabled: false, sessionId: 'sess-1' })
      expect(deriveSessionSandboxAcknowledged({ desired: superseded, applied: staleOn })).toBeNull()
    })

    test('an unavailable read (missing DB/table) is never derived as ON', () => {
      // Even if a previous snapshot looked like ON, an unavailable read has no rows to trust and
      // must derive OFF so a transient startup failure never flashes a false ON.
      expect(
        deriveSessionSandboxAcknowledged({ desired: null, applied: null, unavailable: true }),
      ).toBeNull()
    })
  })

  describe('isSessionSandboxPreferenceSettled', () => {
    function desired(overrides: Partial<SessionSandboxDesiredState> = {}) {
      return { version: 1 as const, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 1, ...overrides }
    }

    test('is settled with no persisted desired state', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: null, applied: null })).toBe(true)
    })

    test('is pending while a desired state awaits its matching applied revision', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: null })).toBe(false)
    })

    test('is pending while the applied row carries a stale revision', () => {
      const stale = writeApplied({ revision: 'old-rev', enabled: true, error: null })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: stale })).toBe(false)
    })

    test('is settled once the applied revision matches, including OFF and error', () => {
      const off = writeApplied({ revision: 'r1', enabled: false, error: null })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: off })).toBe(true)
      const errored = writeApplied({ revision: 'r1', enabled: false, error: 'sbx failed to start' })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: errored })).toBe(true)
    })
  })

  describe('requestSessionSandboxState', () => {
    test('writes desired and resolves on the matching applied revision', async () => {
      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 2000,
        pollMs: 10,
      })

      const { desired } = readSessionSandboxPreference(PROJECT_A, dbPath)
      expect(desired).not.toBeNull()
      expect(desired!.enabled).toBe(true)
      expect(desired!.sessionId).toBe('sess-1')

      writeApplied({ revision: desired!.revision, enabled: true, error: null })

      const applied = await promise
      expect(applied.revision).toBe(desired!.revision)
      expect(applied.enabled).toBe(true)
      expect(applied.error).toBeNull()
    })

    test('ignores a stale applied revision and only resolves on the matching one', async () => {
      // A stale ON acknowledgement for a different revision must not falsely resolve.
      writeApplied({ revision: 'stale-rev', enabled: true, error: null })

      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 2000,
        pollMs: 10,
      })

      const { desired } = readSessionSandboxPreference(PROJECT_A, dbPath)
      writeApplied({ revision: desired!.revision, enabled: true, error: null })

      const applied = await promise
      expect(applied.revision).toBe(desired!.revision)
    })

    test('throws the server error when a matching applied row carries an error', async () => {
      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 2000,
        pollMs: 10,
      })

      const { desired } = readSessionSandboxPreference(PROJECT_A, dbPath)
      writeApplied({ revision: desired!.revision, enabled: false, error: 'sbx failed to start' })

      await expect(promise).rejects.toThrow('sbx failed to start')
    })

    test('throws on timeout when no matching applied row arrives', async () => {
      await expect(
        requestSessionSandboxState({
          projectId: PROJECT_A,
          dbPath,
          sessionId: 'sess-1',
          enabled: true,
          timeoutMs: 60,
          pollMs: 10,
        }),
      ).rejects.toThrow(/Timed out/)
    })

    test('resolves an acknowledgement that arrives during the final poll sleep', async () => {
      // pollMs >= timeoutMs: a single bounded sleep spans the whole window, and the
      // acknowledgement lands mid-sleep. The waiter must still read it before declaring timeout.
      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 100,
        pollMs: 10_000,
      })
      const { desired } = readSessionSandboxPreference(PROJECT_A, dbPath)
      setTimeout(() => {
        writeApplied({ revision: desired!.revision, enabled: true, error: null })
      }, 50)
      const applied = await promise
      expect(applied.revision).toBe(desired!.revision)
      expect(applied.enabled).toBe(true)
    })

    test('rejects a matching applied row carrying an empty-string error', async () => {
      // `error: ''` is a valid non-null error; it must reject rather than report success.
      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 2000,
        pollMs: 10,
      })
      const { desired } = readSessionSandboxPreference(PROJECT_A, dbPath)
      writeApplied({ revision: desired!.revision, enabled: false, error: '' })
      await expect(promise).rejects.toThrow()
    })

    test('rejects immediately when the signal is already aborted before any read', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        requestSessionSandboxState({
          projectId: PROJECT_A,
          dbPath,
          sessionId: 'sess-1',
          enabled: true,
          timeoutMs: 2000,
          pollMs: 10,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/i)
      // A pre-cancelled request must not persist a desired revision the server could still apply.
      expect(readSessionSandboxPreference(PROJECT_A, dbPath).desired).toBeNull()
    })

    test('caps each poll sleep to the remaining deadline when pollMs exceeds timeoutMs', async () => {
      const start = Date.now()
      await expect(
        requestSessionSandboxState({
          projectId: PROJECT_A,
          dbPath,
          sessionId: 'sess-1',
          enabled: true,
          timeoutMs: 100,
          pollMs: 10_000,
        }),
      ).rejects.toThrow(/Timed out/)
      expect(Date.now() - start).toBeLessThan(1000)
    })

    test('throws when the poll is cancelled via signal', async () => {
      const controller = new AbortController()
      const promise = requestSessionSandboxState({
        projectId: PROJECT_A,
        dbPath,
        sessionId: 'sess-1',
        enabled: true,
        timeoutMs: 2000,
        pollMs: 10,
        signal: controller.signal,
      })
      controller.abort()
      await expect(promise).rejects.toThrow(/cancelled/i)
    })
  })

  describe('beginSessionSandboxStateRequest + awaitSessionSandboxState', () => {
    test('persists the desired revision synchronously and clears a prior ON before the applied row arrives', async () => {
      // Acknowledged ON at revision r1.
      const on = writeApplied({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null })
      repo.setDesired(PROJECT_A, { version: 1 as const, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 1 })
      expect(deriveSessionSandboxAcknowledged(readSessionSandboxPreference(PROJECT_A, dbPath))).toEqual(on)

      // Toggle OFF writes revision r2 synchronously. The authoritative pair now
      // has a mismatched revision, so the sidebar must not keep reporting ON even
      // though the r2 applied row has not arrived yet.
      const revision = beginSessionSandboxStateRequest(PROJECT_A, dbPath, { sessionId: 'sess-1', enabled: false })
      expect(deriveSessionSandboxAcknowledged(readSessionSandboxPreference(PROJECT_A, dbPath))).toBeNull()

      // The pending request then resolves once the matching OFF is applied.
      const promise = awaitSessionSandboxState(PROJECT_A, dbPath, revision, { timeoutMs: 2000, pollMs: 10 })
      writeApplied({ revision, enabled: false, error: null })
      const applied = await promise
      expect(applied.revision).toBe(revision)
      expect(applied.enabled).toBe(false)
    })
  })
})
