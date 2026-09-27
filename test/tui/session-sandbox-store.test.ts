import { describe, test, expect } from 'vitest'
import {
  awaitSessionSandboxState,
  deriveSandboxPollDelayMs,
  deriveSessionSandboxAcknowledged,
  deriveSessionSandboxDisplayStatus,
  hostSandboxToggleBlocked,
  isSessionSandboxPreferenceSettled,
  type SessionSandboxPreference,
} from '../../src/tui/session-sandbox-store'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState } from '../../src/storage/repos/session-sandbox-preferences-repo'

function desired(overrides: Partial<SessionSandboxDesiredState> = {}): SessionSandboxDesiredState {
  return { version: 1, revision: 'r1', enabled: true, sessionId: 'sess-1', requestedAt: 1, ...overrides }
}

function appliedState(overrides: Partial<SessionSandboxAppliedState> = {}): SessionSandboxAppliedState {
  return { version: 1, revision: 'r1', enabled: true, sessionId: 'sess-1', error: null, appliedAt: 1, ...overrides }
}

describe('session-sandbox-store', () => {
  describe('hostSandboxToggleBlocked', () => {
    test('blocks the toggle when sandboxing is disabled by config', () => {
      expect(hostSandboxToggleBlocked(false)).toBe('Host sandbox is disabled by config (sandbox.enabled: false)')
    })

    test('allows the toggle when sandboxing is enabled by config', () => {
      expect(hostSandboxToggleBlocked(true)).toBeNull()
    })
  })

  describe('deriveSessionSandboxAcknowledged', () => {
    test('derives ON only for a matching, error-free applied row', () => {
      const row = appliedState({ revision: 'r1', enabled: true, error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: row })).toEqual(row)
    })

    test('derives OFF while the matching applied row has not arrived yet', () => {
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: null })).toBeNull()
    })

    test('derives the matching applied row when it arrives after an earlier read', () => {
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: null })).toBeNull()
      const row = appliedState({ revision: 'r1', enabled: true, error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: row })).toEqual(row)
    })

    test('derives OFF for a mismatched or stale applied revision', () => {
      const stale = appliedState({ revision: 'old-rev', enabled: true, error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: stale })).toBeNull()
      const wrongSession = appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-other', error: null })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: wrongSession })).toBeNull()
    })

    test('derives OFF for a matching revision carrying an error or disabled desired', () => {
      const errored = appliedState({ revision: 'r1', enabled: true, error: 'msb failed' })
      expect(deriveSessionSandboxAcknowledged({ desired: desired(), applied: errored })).toBeNull()
      expect(deriveSessionSandboxAcknowledged({ desired: desired({ enabled: false }), applied: errored })).toBeNull()
    })

    test('derives OFF when an ON acknowledgement is superseded by a newer desired revision', () => {
      const staleOn = appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null })
      expect(deriveSessionSandboxAcknowledged({
        desired: desired({ revision: 'r2', enabled: false, sessionId: 'sess-1' }),
        applied: staleOn,
      })).toBeNull()
    })

    test('an unavailable read is never derived as ON', () => {
      expect(deriveSessionSandboxAcknowledged({ desired: null, applied: null, unavailable: true })).toBeNull()
    })
  })

  describe('isSessionSandboxPreferenceSettled', () => {
    test('is settled with no persisted desired state', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: null, applied: null })).toBe(true)
    })

    test('is pending while a desired state awaits its matching applied revision', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: null })).toBe(false)
    })

    test('is pending while the applied row carries a stale revision', () => {
      const stale = appliedState({ revision: 'old-rev', enabled: true, error: null })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: stale })).toBe(false)
    })

    test('is settled once the applied revision matches, including OFF and error', () => {
      const off = appliedState({ revision: 'r1', enabled: false, error: null })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: off })).toBe(true)
      const errored = appliedState({ revision: 'r1', enabled: false, error: 'msb failed to start' })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: errored })).toBe(true)
    })
  })

  describe('deriveSessionSandboxDisplayStatus', () => {
    test('shows enabled for the current session of a sandboxed running loop', () => {
      expect(deriveSessionSandboxDisplayStatus({
        desired: null,
        applied: null,
        activeLoopSandboxes: { 'sess-1': true },
      }, 'sess-1')).toBe('enabled')
    })

    test('uses loop sandbox state before a stale host acknowledgement', () => {
      expect(deriveSessionSandboxDisplayStatus({
        desired: desired(),
        applied: appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null }),
        activeLoopSandboxes: { 'sess-1': false },
      }, 'sess-1')).toBe('disabled')
    })

    test('shows loading only for the selected session while acknowledgement is pending', () => {
      const pref = { desired: desired(), applied: null }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('loading')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-other')).toBe('disabled')
    })

    test('shows enabled only for a matching acknowledged session', () => {
      const pref = { desired: desired(), applied: appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null }) }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('enabled')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-other')).toBe('disabled')
    })

    test('shows loading while startup revalidates a previously acknowledged sandbox', () => {
      const pref = {
        desired: desired(),
        applied: appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null }),
        controller: { version: 1 as const, phase: 'loading' as const, revision: 'r1', sessionId: 'sess-1' },
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('loading')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-other')).toBe('disabled')
      expect(deriveSessionSandboxDisplayStatus({ ...pref, controller: { ...pref.controller, phase: 'ready' } }, 'sess-1')).toBe('enabled')
    })

    test('shows loading while a newer disable request supersedes acknowledged ON', () => {
      const pref = {
        desired: desired({ revision: 'r2', enabled: false }),
        applied: appliedState({ revision: 'r1', enabled: true, sessionId: 'sess-1', error: null }),
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('loading')
    })

    test('shows failed for a settled desired ON that was applied OFF or with an error', () => {
      const off = appliedState({ revision: 'r1', enabled: false, sessionId: 'sess-1', error: null })
      expect(deriveSessionSandboxDisplayStatus({ desired: desired(), applied: off }, 'sess-1')).toBe('failed')
      const errored = appliedState({ revision: 'r1', enabled: false, sessionId: 'sess-1', error: 'unavailable' })
      expect(deriveSessionSandboxDisplayStatus({ desired: desired(), applied: errored }, 'sess-1')).toBe('failed')
      expect(deriveSessionSandboxDisplayStatus({ desired: desired(), applied: off }, 'sess-other')).toBe('disabled')
    })

    test('shows failed for a matching failed controller state', () => {
      const pref = {
        desired: desired(),
        applied: appliedState({ revision: 'r1', enabled: false, sessionId: 'sess-1', error: 'unavailable' }),
        controller: { version: 1 as const, phase: 'failed' as const, revision: 'r1', sessionId: 'sess-1' },
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('failed')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-other')).toBe('disabled')
    })

    test('shows disabled for a clean settled OFF and for no persisted state', () => {
      const off = appliedState({ revision: 'r1', enabled: false, sessionId: 'sess-1', error: null })
      expect(deriveSessionSandboxDisplayStatus({ desired: desired({ enabled: false }), applied: off }, 'sess-1')).toBe('disabled')
      expect(deriveSessionSandboxDisplayStatus(null, 'sess-1')).toBe('disabled')
    })
  })

  describe('deriveSandboxPollDelayMs', () => {
    test('polls promptly while a desired revision is pending', () => {
      expect(deriveSandboxPollDelayMs({ desired: desired(), applied: null })).toBe(1500)
    })

    test('backs off once the pair settles', () => {
      const settled = appliedState({ revision: 'r1', enabled: true, error: null })
      expect(deriveSandboxPollDelayMs({ desired: desired(), applied: settled })).toBe(10_000)
    })

    test('retries unavailable state and polls for newly started loops', () => {
      expect(deriveSandboxPollDelayMs({ desired: null, applied: null, unavailable: true })).toBe(5000)
      expect(deriveSandboxPollDelayMs({ desired: null, applied: null })).toBe(5000)
    })
  })

  describe('awaitSessionSandboxState', () => {
    test('resolves once the reader reports the requested revision', async () => {
      let applied: SessionSandboxAppliedState | null = null
      const promise = awaitSessionSandboxState(
        async () => ({ desired: null, applied }),
        'r1',
        { timeoutMs: 2000, pollMs: 10 },
      )
      setTimeout(() => { applied = appliedState({ revision: 'r1', enabled: true, error: null }) }, 20)
      await expect(promise).resolves.toMatchObject({ revision: 'r1', enabled: true })
    })

    test('ignores stale applied state until the requested revision arrives', async () => {
      let applied: SessionSandboxAppliedState | null = appliedState({ revision: 'stale', enabled: true, error: null })
      const promise = awaitSessionSandboxState(
        async () => ({ desired: null, applied }),
        'r1',
        { timeoutMs: 2000, pollMs: 10 },
      )
      setTimeout(() => { applied = appliedState({ revision: 'r1', enabled: true, error: null }) }, 20)
      await expect(promise).resolves.toMatchObject({ revision: 'r1', enabled: true })
    })

    test('rejects matching applied errors including an empty string', async () => {
      const promise = awaitSessionSandboxState(
        async () => ({ desired: null, applied: appliedState({ revision: 'r1', enabled: false, error: '' }) }),
        'r1',
        { timeoutMs: 2000, pollMs: 10 },
      )
      await expect(promise).rejects.toThrow()
    })

    test('times out when no matching applied revision arrives', async () => {
      await expect(
        awaitSessionSandboxState(
          async () => ({ desired: null, applied: null }),
          'r1',
          { timeoutMs: 60, pollMs: 10 },
        ),
      ).rejects.toThrow(/Timed out/)
    })

    test('reads an acknowledgement that arrives during the final bounded sleep', async () => {
      let applied: SessionSandboxAppliedState | null = null
      const promise = awaitSessionSandboxState(
        async () => ({ desired: null, applied }),
        'r1',
        { timeoutMs: 100, pollMs: 10_000 },
      )
      setTimeout(() => { applied = appliedState({ revision: 'r1', enabled: true, error: null }) }, 50)
      await expect(promise).resolves.toMatchObject({ revision: 'r1', enabled: true })
    })

    test('caps poll sleep to the remaining timeout', async () => {
      const start = Date.now()
      await expect(
        awaitSessionSandboxState(
          async () => ({ desired: null, applied: null }),
          'r1',
          { timeoutMs: 100, pollMs: 10_000 },
        ),
      ).rejects.toThrow(/Timed out/)
      expect(Date.now() - start).toBeLessThan(1000)
    })

    test('rejects when polling is cancelled', async () => {
      const controller = new AbortController()
      const promise = awaitSessionSandboxState(
        async () => ({ desired: null, applied: null }),
        'r1',
        { timeoutMs: 2000, pollMs: 10, signal: controller.signal },
      )
      controller.abort()
      await expect(promise).rejects.toThrow(/cancelled/i)
    })
  })
})
