import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import Database from 'better-sqlite3'

import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createLoopNewSessionOutcomesRepo } from '../../src/storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../../src/storage/repos/loop-new-session-cancellations-repo'
import { connectForgeProject, __setCrossProcessNewSessionResolver } from '../../src/utils/tui-client'

/**
 * Final-audit bug 2: a cross-process `promptAsync` rejection used to bypass
 * outcome/cancellation arbitration. The panel returned a clean `null` failure
 * even when the host invocation had actually been accepted (the response was
 * lost after the request was queued). A panel failure shown to the user while
 * the server-side launch still proceeds causes a retry with a fresh nonce,
 * producing a duplicate loop.
 *
 * The fix routes the rejection through `cancelNewSessionRequestExclusive`
 * (the same arbitration the resolver uses on timeout):
 *   - 'cancelled'   -> safe terminal failure; the cancellation marker now
 *                      fences off a delayed host invocation at
 *                      handlePlanNewSession entry (no duplicate launch).
 *   - 'committed'   -> the host invocation actually won arbitration just
 *                      before the response was lost; re-read the outcome row
 *                      and report success so the user does not retry.
 *   - 'unavailable' / 'write-failed' -> throw an explicit uncertain failure
 *                      so the panel never masks the race.
 *
 * This file does NOT mock `bun:sqlite` — the vitest alias shim routes it to
 * better-sqlite3 so the shared outcome/cancellation stores are real, allowing
 * the panel arbitration to read and write actual rows.
 */
const PROJECT_ID = 'proj_prompt_fail_xp'
const DIRECTORY = '/tmp/forge-tui-prompt-fail-' + Date.now()

describe('cross-process new-session promptAsync rejection routes through cancellation arbitration', () => {
  let tmpRoot: string
  let sharedDbPath: string

  beforeEach(() => {
    mkdirSync(DIRECTORY, { recursive: true })
    tmpRoot = join(tmpdir(), `forge-tui-prompt-fail-${randomUUID()}`)
    mkdirSync(tmpRoot, { recursive: true })
    sharedDbPath = join(tmpRoot, 'forge.db')
    const db = new Database(sharedDbPath)
    setupLoopsTestDb(db)
    db.close()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    __setCrossProcessNewSessionResolver(null)
  })

  function buildMockApi(): any {
    const api: any = {
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
          promptAsync: vi.fn().mockRejectedValue(new Error('host prompt channel lost')),
        },
      },
      route: { navigate: vi.fn() },
    }
    // The cross-process gate inspects the legacy hey-api client for a
    // loopback baseUrl. Inject the seam so the gate treats the connected
    // opencode server as a co-located (loopback) source, allowing the
    // explicit dataDir below to be authoritative.
    api.client._client = { getConfig: () => ({ baseUrl: 'http://127.0.0.1:3000' }) }
    return api
  }

  async function runCrossProcessLaunch() {
    const api = buildMockApi()
    const client = await connectForgeProject(api, DIRECTORY, [], { dataDir: tmpRoot })
    expect(client).not.toBeNull()
    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Cross-process prompt failure',
      plan: '# Plan\nDo the thing cross-process',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
      executionVariant: 'cross-exec-variant',
      auditorVariant: 'cross-audit-variant',
    })
    return { result, api }
  }

  test('promptAsync rejection reports terminal failure when no outcome committed (cancellation wins)', async () => {
    /**
     * Cold-race scenario: the panel queued the host instruction and the
     * response was lost before the server committed any outcome. The
     * arbitration writes a cancellation marker (no committed outcome to lose
     * against) and returns 'cancelled', so the panel reports a deterministic
     * failure and the panel does NOT surface success. A delayed host
     * invocation carrying this nonce will be refused at handlePlanNewSession
     * entry, preventing a duplicate launch on retry.
     */
    const { result, api } = await runCrossProcessLaunch()

    expect(result).toBeNull()
    expect(api.client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(api.client.session.create).not.toHaveBeenCalled()
    expect(api.client.experimental.workspace.create).not.toHaveBeenCalled()

    // The shared store holds the cancellation marker for this nonce — a
    // delayed host-side invocation can be fenced via isCancelled.
    const apiPromptArgs = api.client.session.promptAsync.mock.calls[0][0] as { parts: { text: string }[] }
    const instruction = apiPromptArgs.parts?.[0]?.text ?? ''
    const nonce = instruction.match(/requestNonce:\s*"([^"]+)"/)?.[1]
    expect(nonce).toBeTruthy()

    const db = new Database(sharedDbPath)
    const isCancelled = createLoopNewSessionCancellationsRepo(db).isCancelled(PROJECT_ID, nonce!)
    db.close()
    expect(isCancelled).toBe(true)
  })

  test('promptAsync rejection reports success when the outcome already committed (no false failure)', async () => {
    /**
     * Hot-race scenario: the server-side handler actually committed the launch
     * (audited loop created) just before the response was lost. The panel's
     * arbitration observes 'committed' and re-reads the outcome row, reporting
     * success so the user does NOT retry against an already-running loop.
     */
    const api = buildMockApi()
    const client = await connectForgeProject(api, DIRECTORY, [], { dataDir: tmpRoot })
    expect(client).not.toBeNull()

    // Pre-seed the panel's view: simulate the host invocation committing an
    // audited-loop outcome row keyed by THIS launch's nonce before the
    // promptAsync rejection arrives. The panel mints the nonce internally and
    // embeds it in the host instruction; we capture it via the
    // promptAsync mock call args after dispatching, then write the matching
    // outcome row BEFORE the rejection resolves.
    //
    // Strategy: queue the launch, intercept promptAsync to race an outcome
    // commit in before returning the rejection. The shared DB write happens
    // synchronously via better-sqlite3, so the arbitration will observe it.
    api.client.session.promptAsync.mockImplementationOnce(async (args: { parts: { text: string }[] }) => {
      // Extract the nonce the panel embedded in the host instruction.
      const instruction = args.parts?.[0]?.text ?? ''
      const match = instruction.match(/requestNonce:\s*"([^"]+)"/)
      const nonce = match?.[1]
      expect(nonce).toBeTruthy()

      // Simulate the server committing an audited-loop outcome just before the
      // promptAsync response is lost (the race the fix must preserve).
      const db = new Database(sharedDbPath)
      createLoopNewSessionOutcomesRepo(db).recordExclusive({
        projectId: PROJECT_ID,
        requestNonce: nonce!,
        hostSessionId: 'sess-host',
        outcomeSessionId: 'loop-executor-race-winner',
        loopName: 'race-winner-loop',
        kind: 'audited',
      })
      db.close()

      throw new Error('host prompt channel lost')
    })

    const result = await client!.plan.execute('sess-host', {
      mode: 'new-session',
      title: 'Cross-process hot race',
      plan: '# Plan\nDo the thing cross-process',
      executionModel: 'test/exec',
      auditorModel: 'test/auditor',
      executionVariant: 'cross-exec-variant',
      auditorVariant: 'cross-audit-variant',
    })

    expect(result).not.toBeNull()
    expect('error' in (result as object)).toBe(false)
    const ok = result as { sessionId: string; loopName?: string }
    // The panel reports the COMMITTED outcome (not a phantom failure),
    // preventing a retry that would start a duplicate loop.
    expect(ok.sessionId).toBe('loop-executor-race-winner')
    expect(ok.loopName).toBe('race-winner-loop')
  })
})
