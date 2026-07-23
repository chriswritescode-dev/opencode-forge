import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  __defaultCrossProcessNewSessionResolver,
  type CrossProcessNewSessionInput,
  type HostSessionNewLoopOptions,
} from '../../src/utils/tui-client'
import type { LoopNewSessionOutcomeRow, NewSessionOutcomeKind } from '../../src/storage/repos/loop-new-session-outcomes-repo'

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }))

const HOST_SESSION_ID = 'host-session-1'
const PROJECT_ID = 'proj_resolver'

function makeOutcome(
  requestNonce: string,
  overrides: Partial<LoopNewSessionOutcomeRow> & { kind?: NewSessionOutcomeKind } = {},
): LoopNewSessionOutcomeRow {
  const kind = overrides.kind ?? 'audited'
  return {
    projectId: overrides.projectId ?? PROJECT_ID,
    requestNonce,
    hostSessionId: overrides.hostSessionId ?? HOST_SESSION_ID,
    outcomeSessionId: overrides.outcomeSessionId ?? `session-for-${requestNonce}`,
    loopName: overrides.loopName ?? (kind === 'audited' ? `loop-for-${requestNonce}` : null),
    kind,
    createdAt: Date.now(),
  }
}

function makeInput(overrides: Partial<CrossProcessNewSessionInput>): CrossProcessNewSessionInput {
  return {
    projectId: PROJECT_ID,
    hostSessionId: HOST_SESSION_ID,
    requestNonce: 'requested-nonce',
    ...overrides,
  }
}

function makeOptions(overrides: Partial<HostSessionNewLoopOptions> = {}): HostSessionNewLoopOptions {
  return {
    pollIntervalMs: 0,
    timeoutMs: 200,
    fetchOutcome: () => null,
    sleep: async () => undefined,
    debug: () => undefined,
    ...overrides,
  }
}

describe('default cross-process new-session resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('fast launch: outcome present at first poll resolves immediately', async () => {
    const outcome = makeOutcome('requested-nonce', { loopName: 'requested-name', outcomeSessionId: 'session-requested-name' })
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        fetchOutcome: () => outcome,
        sleep: async () => undefined,
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.loopName).toBe('requested-name')
    expect(result!.sessionId).toBe('session-requested-name')
  })

  test('audited outcome returns the loop name; one-shot outcome returns only the session id', async () => {
    const audited = makeOutcome('audited-nonce', { kind: 'audited', loopName: 'audited-loop', outcomeSessionId: 'audited-session' })
    const oneShot = makeOutcome('one-shot-nonce', { kind: 'one-shot', loopName: null, outcomeSessionId: 'one-shot-session' })

    const auditedResult = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'audited-nonce' }),
      makeOptions({ fetchOutcome: () => audited, sleep: async () => undefined }),
    )
    expect(auditedResult!.loopName).toBe('audited-loop')
    expect(auditedResult!.sessionId).toBe('audited-session')

    const oneShotResult = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'one-shot-nonce' }),
      makeOptions({ fetchOutcome: () => oneShot, sleep: async () => undefined }),
    )
    expect(oneShotResult!.loopName).toBeUndefined()
    expect(oneShotResult!.sessionId).toBe('one-shot-session')
  })

  test('concurrent launch with a different nonce does not satisfy this request', async () => {
    /**
     * Each launch mints its own nonce; the resolver only consults the outcome
     * keyed by THIS request's nonce, so a sibling launch's outcome (even on the
     * same host session) is never misattributed. The auditor's regression:
     * title-only correlation could pick up an unrelated concurrent session.
     */
    const siblingOutcome = makeOutcome('sibling-nonce', { loopName: 'sibling-loop', outcomeSessionId: 'sibling-session' })
    let queriedNonce = ''
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        fetchOutcome: (_pid, nonce) => {
          queriedNonce = nonce
          return nonce === 'requested-nonce' ? null : siblingOutcome
        },
        sleep: async () => undefined,
      }),
    )
    expect(queriedNonce).toBe('requested-nonce')
    expect(result).toBeNull()
  })

  test('outcome attributed to a different host session is rejected (host fence)', async () => {
    /**
     * Nonces are unique per launch, so cross-host nonce reuse should not
     * happen; the host-session match is an additional fence. A row with our
     * nonce but a foreign host_session_id must not be accepted.
     */
    const foreignHostOutcome = makeOutcome('requested-nonce', { hostSessionId: 'sibling-host-session' })
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({ fetchOutcome: () => foreignHostOutcome, sleep: async () => undefined }),
    )
    expect(result).toBeNull()
  })

  test('same-title concurrent session never substitutes for this launch (nonce correlation fences it out)', async () => {
    /**
     * Auditor regression: an unrelated concurrent session sharing this launch's
     * predicted title used to be selectable by the title-only one-shot
     * fallback matcher. The resolver now correlates solely by requestNonce +
     * hostSessionId and never consults the directory session list (no
     * session.list polling at all), so a same-title unrelated session is
     * structurally invisible. Here our nonce's outcome has NOT been written
     * yet while an unrelated launch (different nonce, same host, identical
     * one-shot session title) HAS written its outcome — the resolver must
     * surface null (timing out) rather than grabbing the unrelated session.
     */
    const unrelatedOutcome = makeOutcome('unrelated-nonce', {
      kind: 'one-shot',
      loopName: null,
      outcomeSessionId: 'unrelated-same-title-session',
    })
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        fetchOutcome: (_pid, nonce) => (nonce === 'unrelated-nonce' ? unrelatedOutcome : null),
        sleep: async () => undefined,
      }),
    )
    expect(result).toBeNull()

    /**
     * Positive companion: once OUR nonce's outcome is written, the resolver
     * returns our session even though the unrelated same-title session exists
     * in the store under a different nonce.
     */
    const ourOutcome = makeOutcome('requested-nonce', {
      kind: 'one-shot',
      loopName: null,
      outcomeSessionId: 'our-fallback-session',
    })
    const positive = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        fetchOutcome: (_pid, nonce) => (nonce === 'unrelated-nonce' ? unrelatedOutcome : ourOutcome),
        sleep: async () => undefined,
      }),
    )
    expect(positive).not.toBeNull()
    expect(positive!.sessionId).toBe('our-fallback-session')
    expect(positive!.loopName).toBeUndefined()
  })

  test('slow-failure race: no outcome ever appears surfaces null (no provisional-row false positive)', async () => {
    /**
     * The handler writes a provisional loop row before sending the initial
     * prompt and may delete it again on prompt failure; the resolver reads
     * ONLY the post-commit outcome row, so a pending/failed prompt produces no
     * signal and the resolver times out instead of returning a false success.
     */
    let polls = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        timeoutMs: 60,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          polls += 1
          return null
        },
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).toBeNull()
    expect(polls).toBeGreaterThan(0)
  })

  test('successful outcome resolves after the provisional-row period elapses', async () => {
    const outcome = makeOutcome('requested-nonce', { loopName: 'requested-name', outcomeSessionId: 'session-requested-name' })
    let polls = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        timeoutMs: 60,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          polls += 1
          return polls >= 2 ? outcome : null
        },
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.loopName).toBe('requested-name')
    expect(result!.sessionId).toBe('session-requested-name')
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  test('fetchOutcome throwing is swallowed and polling continues until the outcome appears', async () => {
    const outcome = makeOutcome('requested-nonce')
    let polls = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        timeoutMs: 80,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          polls += 1
          if (polls === 1) throw new Error('transient db read failure')
          return outcome
        },
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(outcome.outcomeSessionId)
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  test('no outcome within deadline surfaces null (delayed/failed prompt)', async () => {
    let polled = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        timeoutMs: 50,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          polled += 1
          return null
        },
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).toBeNull()
    expect(polled).toBeGreaterThan(0)
  })

  test('projectId null never consults the store and times out', async () => {
    /**
     * A TUI that could not resolve a project id cannot write/read the shared
     * Forge store; the resolver degrades to an explicit timeout rather than
     * throwing or guessing.
     */
    let queried = false
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ projectId: null }),
      makeOptions({
        fetchOutcome: () => {
          queried = true
          return null
        },
        sleep: async () => undefined,
      }),
    )
    expect(result).toBeNull()
    expect(queried).toBe(false)
  })

  test('on timeout the resolver marks the launch cancelled so a delayed host invocation cannot launch later', async () => {
    /**
     * Auditor issue #2: the 30-second deadline reports failure WITHOUT
     * cancelling the queued host prompt. A delayed prompt may subsequently
     * launch the loop, duplicating a retried launch. The default resolver
     * now calls options.markCancelled with (projectId, requestNonce,
     * hostSessionId) BEFORE returning null on timeout, so the server-side
     * handler refuses the eventual host invocation. projectId null never
     * polls and therefore never marks cancellation (it could not have
     * recorded an authoritative outcome anyway).
     */
    const markCancelled = vi.fn()
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'abandoned-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => null,
        markCancelled,
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).toBeNull()
    expect(markCancelled).toHaveBeenCalledTimes(1)
    expect(markCancelled.mock.calls[0][0]).toBe(PROJECT_ID)
    expect(markCancelled.mock.calls[0][1]).toBe('abandoned-nonce')
    expect(markCancelled.mock.calls[0][2]).toBe(HOST_SESSION_ID)
  })

  test('a successful resolution never writes a cancellation marker', async () => {
    /**
     * Cancellation is written ONLY on timeout — a successful resolution
     * (the host invoked the tool and the outcome row appeared before the
     * deadline) must never abandon the launch.
     */
    const outcome = makeOutcome('resolved-nonce', { loopName: 'resolved-loop', outcomeSessionId: 'resolved-session' })
    const markCancelled = vi.fn()
    let polls = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'resolved-nonce' }),
      makeOptions({
        timeoutMs: 60,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          polls += 1
          return polls >= 2 ? outcome : null
        },
        markCancelled,
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('resolved-session')
    expect(markCancelled).not.toHaveBeenCalled()
  })

  test('projectId null times out without writing a cancellation marker (no shared store to write into)', async () => {
    const markCancelled = vi.fn()
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ projectId: null }),
      makeOptions({
        fetchOutcome: () => null,
        markCancelled,
        sleep: async () => undefined,
      }),
    )
    expect(result).toBeNull()
    expect(markCancelled).not.toHaveBeenCalled()
  })

  test('a markCancelled that throws surfaces an uncertain-failure error — the panel must not report terminal failure without a confirmed cancellation', async () => {
    /**
     * Auditor race fix: a failed cancellation write previously left the panel
     * reporting a clean timeout failure while the host invocation might still
     * be in flight (no cancellation marker committed to refuse it). The
     * resolver now throws an explicit "verdict unconfirmed" error so the panel
     * surfaces an honest uncertain-failure instead of claiming the launch
     * definitively failed. The original cancellation error is attached as the
     * `cause` for diagnostics.
     */
    const markCancelled = vi.fn(() => { throw new Error('cancellation write failed') })
    await expect(__defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'cancel-throw-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => null,
        markCancelled,
        sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      }),
    )).rejects.toThrow(/verdict unconfirmed/)
    expect(markCancelled).toHaveBeenCalledTimes(1)
  })

  test('pollIntervalMs 0 returns after a single poll when no outcome exists', async () => {
    let polls = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'requested-nonce' }),
      makeOptions({
        pollIntervalMs: 0,
        fetchOutcome: () => {
          polls += 1
          return null
        },
        sleep: async () => undefined,
      }),
    )
    expect(result).toBeNull()
    expect(polls).toBe(1)
  })
})

describe('default cross-process new-session resolver atomic arbitration outcomes', () => {
  /**
   * Auditor race fix: at timeout the resolver no longer blindly writes a
   * cancellation marker and reports terminal failure. It calls markCancelled,
   * which now returns a discriminated CrossProcessCancellationResult, and the
   * resolver's verdict follows the winner of the per-nonce arbitration
   * between cancellation and launch outcome. Exactly one can commit — the
   * loser observes the winner's row — so a delayed host invocation that wins
   * the race just before the deadline is reported as the success it actually
   * was, never as a stale timeout failure.
   */
  test('markCancelled returns "cancelled" — resolver reports terminal failure (null)', async () => {
    const markCancelled = vi.fn((): { kind: 'cancelled' } => ({ kind: 'cancelled' }))
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'cancel-win-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => null,
        markCancelled,
        sleep: async () => undefined,
      }),
    )
    expect(result).toBeNull()
    expect(markCancelled).toHaveBeenCalledTimes(1)
  })

  test('markCancelled returns "committed" with a matching outcome — resolver reports success instead of stale timeout', async () => {
    const outcome = makeOutcome('committed-race-nonce', { loopName: 'race-loop', outcomeSessionId: 'race-session' })
    const markCancelled = vi.fn((): { kind: 'committed' } => ({ kind: 'committed' }))
    let refetched = 0
    const result = await __defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'committed-race-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => {
          refetched += 1
          return outcome
        },
        markCancelled,
        sleep: async () => undefined,
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('race-session')
    expect(result!.loopName).toBe('race-loop')
    expect(refetched).toBe(1)
  })

  test('markCancelled returns "committed" but the outcome vanished — resolver throws an honest uncertain-failure', async () => {
    /** Cross-process race tail: the host committed the outcome just before
     *  deadline but the server then rolled it back (e.g. a later persistence
     *  failure). By the time the panel re-reads the row it is gone. The
     *  resolver must NOT manufacture a success off a vanished row — nor a
     *  clean timeout failure that masks the race — so it throws an explicit
     *  "outcome won arbitration but is no longer readable" error. */
    const markCancelled = vi.fn((): { kind: 'committed' } => ({ kind: 'committed' }))
    await expect(__defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'committed-then-vanished-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => null,
        markCancelled,
        sleep: async () => undefined,
      }),
    )).rejects.toThrow(/verdict unconfirmed/)
    expect(markCancelled).toHaveBeenCalledTimes(1)
  })

  test('markCancelled returns "committed" but the visible outcome belongs to a different host — resolver throws uncertain-failure', async () => {
    /** The arbitration table is keyed by nonce, but the resolver still gates
     *  acceptance on a host-session match so a nonce reused across host
     *  sessions cannot be misattributed. When the host session mismatches the
     *  resolver declines to claim success and surfaces an uncertain-failure. */
    const foreignOutcome = makeOutcome('committed-foreign-nonce', {
      hostSessionId: 'other-host',
      outcomeSessionId: 'foreign-session',
    })
    const markCancelled = vi.fn((): { kind: 'committed' } => ({ kind: 'committed' }))
    await expect(__defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'committed-foreign-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => foreignOutcome,
        markCancelled,
        sleep: async () => undefined,
      }),
    )).rejects.toThrow(/verdict unconfirmed/)
  })

  test('markCancelled returns "unavailable" (no shared DB) — resolver throws rather than claim terminal failure', async () => {
    const markCancelled = vi.fn((): { kind: 'unavailable' } => ({ kind: 'unavailable' }))
    await expect(__defaultCrossProcessNewSessionResolver(
      makeInput({ requestNonce: 'unavailable-nonce' }),
      makeOptions({
        timeoutMs: 30,
        pollIntervalMs: 5,
        fetchOutcome: () => null,
        markCancelled,
        sleep: async () => undefined,
      }),
    )).rejects.toThrow(/verdict unconfirmed/)
    expect(markCancelled).toHaveBeenCalledTimes(1)
  })

  test('markCancelled returns "write-failed" — resolver throws AND attaches the original error as cause', async () => {
    const cancellationError = new Error('cancellation write failed')
    const markCancelled = vi.fn((): { kind: 'write-failed'; error: unknown } => ({ kind: 'write-failed', error: cancellationError }))
    let caught: unknown
    try {
      await __defaultCrossProcessNewSessionResolver(
        makeInput({ requestNonce: 'write-failed-nonce' }),
        makeOptions({
          timeoutMs: 30,
          pollIntervalMs: 5,
          fetchOutcome: () => null,
          markCancelled,
          sleep: async () => undefined,
        }),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error & { cause?: unknown }).cause).toBe(cancellationError)
    expect((caught as Error).message).toMatch(/verdict unconfirmed/)
    expect(markCancelled).toHaveBeenCalledTimes(1)
  })
})
