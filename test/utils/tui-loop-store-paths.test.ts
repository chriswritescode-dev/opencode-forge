import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import Database from 'better-sqlite3'

import { createLoopNewSessionOutcomesRepo } from '../../src/storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../../src/storage/repos/loop-new-session-cancellations-repo'
import { fetchNewSessionOutcomeByNonce, cancelNewSessionRequest } from '../../src/utils/tui-loop-store'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { connectForgeProject, __setCrossProcessNewSessionResolver } from '../../src/utils/tui-client'

/**
 * Auditor issue #1: cross-process polling ignores `config.dataDir` and always
 * reads the default Forge database. The shared-DB accessors in
 * `tui-loop-store` honor an explicit `dbPathOverride` threaded in by
 * `connectForgeProject` from `PluginConfig.dataDir`, so a deployment with a
 * non-default `dataDir` still resolves cross-process launches (the server
 * records outcomes/cancellations under the configured path; the TUI reads and
 * writes the SAME path). These tests assert the override is consulted — a row
 * written under the configured path is invisible to a lookup scoped to a
 * different path, and `connectForgeProject` threads the configured path into
 * the resolver closures it builds.
 */
const PROJECT_ID = 'proj-loop-store-paths'
const DIRECTORY = '/tmp/forge-tui-loop-store-placeholder'

describe('tui-loop-store honors the configured shared database path', () => {
  let tmpRoot: string
  let configuredDbPath: string
  let otherDbPath: string

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `forge-tui-loop-store-${randomUUID()}`)
    mkdirSync(tmpRoot, { recursive: true })
    // `getDbPath(override)` joins the override with `forge.db`, so the
    // configured data dir is `tmpRoot` and the resolved DB path is
    // `tmpRoot/forge.db`. `other.db` simulates an unrelated shared path.
    configuredDbPath = join(tmpRoot, 'forge.db')
    otherDbPath = join(tmpRoot, 'other.db')
    for (const p of [configuredDbPath, otherDbPath]) {
      const db = new Database(p)
      setupLoopsTestDb(db)
      db.close()
    }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('fetchNewSessionOutcomeByNonce reads only the configured path — records at a different path are invisible', () => {
    const db = new Database(configuredDbPath)
    createLoopNewSessionOutcomesRepo(db).record({
      projectId: PROJECT_ID,
      requestNonce: 'nonce-A',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-A',
      loopName: 'loop-A',
      kind: 'audited',
    })
    db.close()

    const resolved = fetchNewSessionOutcomeByNonce(PROJECT_ID, 'nonce-A', configuredDbPath)
    expect(resolved).not.toBeNull()
    expect(resolved!.outcomeSessionId).toBe('session-A')
    expect(resolved!.loopName).toBe('loop-A')
    expect(resolved!.kind).toBe('audited')

    // A different override path sees nothing — the lookup consults the
    // override, not the default Forge directory or any sibling path.
    const unresolved = fetchNewSessionOutcomeByNonce(PROJECT_ID, 'nonce-A', otherDbPath)
    expect(unresolved).toBeNull()
  })

  test('cancelNewSessionRequest writes the authoritative marker to the configured path and is visible to the server-side repo', () => {
    cancelNewSessionRequest(PROJECT_ID, 'abandoned-nonce', 'host-A', configuredDbPath)

    const db = new Database(configuredDbPath)
    const cancellationsRepo = createLoopNewSessionCancellationsRepo(db)
    expect(cancellationsRepo.isCancelled(PROJECT_ID, 'abandoned-nonce')).toBe(true)
    expect(cancellationsRepo.isCancelled(PROJECT_ID, 'unrelated-nonce')).toBe(false)
    db.close()

    // An unrelated path sees nothing — the write landed ONLY at the
    // configured override path, never at the default Forge directory.
    const dbB = new Database(otherDbPath)
    expect(createLoopNewSessionCancellationsRepo(dbB).isCancelled(PROJECT_ID, 'abandoned-nonce')).toBe(false)
    dbB.close()
  })

  test('connectForgeProject threads PluginConfig.dataDir into the cross-process resolver closures', async () => {
    /**
     * End-to-end wiring proof: when `connectForgeProject` is given a
     * `pluginConfig.dataDir` pointing at a non-default directory, the
     * cross-process resolver options it constructs use a fetchOutcome closure
     * that reads from THAT configured DB path (not the default Forge dir).
     * The injected resolver captures the options and invokes the threaded
     * fetchOutcome against a nonce the configured DB actually holds — proving
     * the closure carried the configured path end-to-end. Without honoring
     * dataDir this lookup would return null and the launch would time out.
     */
    const seededNonce = 'nonce-configured'
    const db = new Database(configuredDbPath)
    createLoopNewSessionOutcomesRepo(db).record({
      projectId: PROJECT_ID,
      requestNonce: seededNonce,
      hostSessionId: 'sess-host',
      outcomeSessionId: 'session-configured',
      loopName: 'loop-configured',
      kind: 'audited',
    })
    db.close()

    let capturedFetchOutcome: ((pid: string, nonce: string) => unknown) | null = null
    let capturedMarkCancelled: ((pid: string, nonce: string, host: string) => void) | null = null
    __setCrossProcessNewSessionResolver(async (input, options) => {
      capturedFetchOutcome = options.fetchOutcome ?? null
      capturedMarkCancelled = options.markCancelled ?? null
      // Drive the captured closure with the seeded nonce (rather than the
      // random nonce connectForgeProject minted for this launch) so we can
      // observe whether the closure resolves from the configured path.
      const outcome = options.fetchOutcome ? options.fetchOutcome(input.projectId ?? '', seededNonce) : null
      if (outcome && typeof outcome === 'object' && 'outcomeSessionId' in outcome) {
        const o = outcome as { outcomeSessionId: string; loopName: string | null }
        return { sessionId: o.outcomeSessionId, ...(o.loopName ? { loopName: o.loopName } : {}) }
      }
      return null
    })

    const mockApi: any = {
      client: {
        project: {
          current: vi.fn().mockResolvedValue({ data: { id: PROJECT_ID, worktree: DIRECTORY } }),
          list: vi.fn().mockResolvedValue({ data: [{ id: PROJECT_ID, worktree: DIRECTORY }] }),
        },
        experimental: { workspace: { list: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() } },
        session: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      route: { navigate: vi.fn() },
    }
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'

    try {
      // Cross-process path: no bridge registered for this directory.
      const client = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: tmpRoot })
      expect(client).not.toBeNull()
      expect(client!.projectId).toBe(PROJECT_ID)

      const result = await client!.plan.execute('sess-host', {
        mode: 'new-session',
        title: 'Configured dataDir',
        plan: '# Plan\nConfigured data dir',
        executionModel: 'test/exec',
        auditorModel: 'test/auditor',
        executionVariant: 'cross-exec-variant',
        auditorVariant: 'cross-audit-variant',
      })

      // The resolver captured the threaded fetchOutcome closure and ran it
      // against the seeded nonce; the closure read from the configured path
      // (`tmpRoot/forge.db`) so the resolved outcome includes the loop name.
      expect(capturedFetchOutcome).not.toBeNull()
      expect(capturedMarkCancelled).not.toBeNull()
      expect(result).not.toBeNull()
      expect('error' in result!).toBe(false)
      const ok = result as { sessionId: string; loopName?: string }
      expect(ok.sessionId).toBe('session-configured')
      expect(ok.loopName).toBe('loop-configured')
    } finally {
      __setCrossProcessNewSessionResolver(null)
    }
  })
})
