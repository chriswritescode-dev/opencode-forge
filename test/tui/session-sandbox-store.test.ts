import { describe, test, expect } from 'vitest'
import {
  deriveSessionSandboxDisplayStatus,
  hostSandboxToggleBlocked,
  isHostSandboxRunning,
  isSessionSandboxPreferenceSettled,
  isSessionSandboxWanted,
  type SessionSandboxPreference,
} from '../../src/tui/session-sandbox-store'
import type { SessionSandboxAppliedState, SessionSandboxDesiredState } from '../../src/storage/repos/session-sandbox-preferences-repo'

function desired(overrides: Partial<SessionSandboxDesiredState> = {}): SessionSandboxDesiredState {
  return { version: 2, revision: 'r1', sessions: {}, requestedAt: 1, ...overrides }
}

function appliedState(overrides: Partial<SessionSandboxAppliedState> = {}): SessionSandboxAppliedState {
  return { version: 2, revision: 'r1', running: true, error: null, appliedAt: 1, ...overrides }
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

  describe('isHostSandboxRunning', () => {
    test('is running only for a matching, error-free applied row that reports running', () => {
      const row = appliedState({ revision: 'r1', running: true, error: null })
      expect(isHostSandboxRunning({ desired: desired(), applied: row, hostSessionsDefault: true })).toBe(true)
    })

    test('is not running without a desired state or before the applied revision arrives', () => {
      expect(isHostSandboxRunning({ desired: null, applied: appliedState(), hostSessionsDefault: true })).toBe(false)
      expect(isHostSandboxRunning({ desired: desired(), applied: null, hostSessionsDefault: true })).toBe(false)
    })

    test('is not running for a stale revision, a non-running row, or an error', () => {
      expect(isHostSandboxRunning({
        desired: desired(),
        applied: appliedState({ revision: 'old-rev' }),
        hostSessionsDefault: true,
      })).toBe(false)
      expect(isHostSandboxRunning({
        desired: desired(),
        applied: appliedState({ running: false }),
        hostSessionsDefault: true,
      })).toBe(false)
      expect(isHostSandboxRunning({
        desired: desired(),
        applied: appliedState({ error: 'msb failed' }),
        hostSessionsDefault: true,
      })).toBe(false)
    })
  })

  describe('isSessionSandboxWanted', () => {
    test('uses the project default when the session has no explicit entry', () => {
      const pref = { desired: desired({ sessions: { 'sess-2': false } }), applied: null, hostSessionsDefault: true }
      expect(isSessionSandboxWanted(pref, 'sess-1')).toBe(true)
      expect(isSessionSandboxWanted({ ...pref, hostSessionsDefault: false }, 'sess-1')).toBe(false)
    })

    test('an explicit per-session entry wins over the project default', () => {
      const on = { desired: desired({ sessions: { 'sess-1': true } }), applied: null, hostSessionsDefault: false }
      expect(isSessionSandboxWanted(on, 'sess-1')).toBe(true)
      const off = { desired: desired({ sessions: { 'sess-1': false } }), applied: null, hostSessionsDefault: true }
      expect(isSessionSandboxWanted(off, 'sess-1')).toBe(false)
    })

    test('falls back to the project default without a persisted desired state', () => {
      expect(isSessionSandboxWanted({ desired: null, applied: null, hostSessionsDefault: true }, 'sess-1')).toBe(true)
    })
  })

  describe('isSessionSandboxPreferenceSettled', () => {
    test('is settled with no persisted desired state', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: null, applied: null, hostSessionsDefault: true })).toBe(true)
    })

    test('is pending while a desired state awaits its matching applied revision', () => {
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: null, hostSessionsDefault: true })).toBe(false)
    })

    test('is pending while the applied row carries a stale revision', () => {
      const stale = appliedState({ revision: 'old-rev' })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: stale, hostSessionsDefault: true })).toBe(false)
    })

    test('is settled once the applied revision matches, including an error', () => {
      const off = appliedState({ revision: 'r1', running: false, error: null })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: off, hostSessionsDefault: true })).toBe(true)
      const errored = appliedState({ revision: 'r1', running: false, error: 'msb failed to start' })
      expect(isSessionSandboxPreferenceSettled({ desired: desired(), applied: errored, hostSessionsDefault: true })).toBe(true)
    })
  })

  describe('deriveSessionSandboxDisplayStatus', () => {
    test('shows enabled for the current session of a sandboxed running loop', () => {
      expect(deriveSessionSandboxDisplayStatus({
        desired: null,
        applied: null,
        activeLoopSandboxes: { 'sess-1': true },
        hostSessionsDefault: false,
      }, 'sess-1')).toBe('enabled')
    })

    test('uses loop sandbox state before the per-session preference', () => {
      expect(deriveSessionSandboxDisplayStatus({
        desired: desired({ sessions: { 'sess-1': true } }),
        applied: appliedState(),
        activeLoopSandboxes: { 'sess-1': false },
        hostSessionsDefault: true,
      }, 'sess-1')).toBe('disabled')
    })

    test('shows enabled for a session inheriting an enabled project default', () => {
      const pref = { desired: desired(), applied: appliedState(), hostSessionsDefault: true }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('enabled')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-2')).toBe('enabled')
    })

    test('shows disabled for a session that opted out while the shared sandbox runs', () => {
      const pref = {
        desired: desired({ sessions: { 'sess-1': false } }),
        applied: appliedState(),
        hostSessionsDefault: true,
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('disabled')
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-2')).toBe('enabled')
    })

    test('shows disabled for every session when the project default is off and none opted in', () => {
      const pref = { desired: desired(), applied: null, hostSessionsDefault: false }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('disabled')
      expect(deriveSessionSandboxDisplayStatus({
        desired: desired({ sessions: { 'sess-1': true } }),
        applied: appliedState(),
        hostSessionsDefault: false,
      }, 'sess-1')).toBe('enabled')
    })

    test('shows loading while the controller is loading at the desired revision', () => {
      const pref = {
        desired: desired(),
        applied: appliedState(),
        controller: { version: 1 as const, phase: 'loading' as const, revision: 'r1' },
        hostSessionsDefault: true,
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('loading')
      expect(deriveSessionSandboxDisplayStatus({ ...pref, controller: { ...pref.controller, phase: 'ready' } }, 'sess-1')).toBe('enabled')
    })

    test('shows loading before the shared sandbox is running', () => {
      expect(deriveSessionSandboxDisplayStatus({
        desired: desired(),
        applied: appliedState({ revision: 'r1', running: false }),
        hostSessionsDefault: true,
      }, 'sess-1')).toBe('loading')
      expect(deriveSessionSandboxDisplayStatus({
        desired: null,
        applied: null,
        hostSessionsDefault: true,
      }, 'sess-1')).toBe('loading')
    })

    test('shows loading while a newer request supersedes the applied revision', () => {
      const pref = {
        desired: desired({ revision: 'r2' }),
        applied: appliedState({ revision: 'r1', running: true, error: null }),
        hostSessionsDefault: true,
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('loading')
    })

    test('shows failed for a matching failed controller state', () => {
      const pref = {
        desired: desired(),
        applied: appliedState({ error: 'unavailable', running: false }),
        controller: { version: 1 as const, phase: 'failed' as const, revision: 'r1' },
        hostSessionsDefault: true,
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('failed')
    })

    test('shows failed for a settled applied revision carrying an error', () => {
      const pref: SessionSandboxPreference = {
        desired: desired(),
        applied: appliedState({ running: false, error: 'msb failed to start' }),
        hostSessionsDefault: true,
      }
      expect(deriveSessionSandboxDisplayStatus(pref, 'sess-1')).toBe('failed')
    })

    test('shows disabled without a session or preference', () => {
      expect(deriveSessionSandboxDisplayStatus(null, 'sess-1')).toBe('disabled')
      expect(deriveSessionSandboxDisplayStatus({ desired: null, applied: null, hostSessionsDefault: true })).toBe('disabled')
    })
  })
})
