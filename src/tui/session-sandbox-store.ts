import { FORGE_HOST_SANDBOX_DISABLED_ERROR } from '../host/forge-rpc'
import type {
  SessionSandboxAppliedState,
  SessionSandboxControllerState,
  SessionSandboxDesiredState,
} from '../storage/repos/session-sandbox-preferences-repo'

export interface SessionSandboxPreference {
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller?: SessionSandboxControllerState | null
  activeLoopSandboxes?: Record<string, boolean>
  unavailable?: boolean
  unavailableReason?: string
}

export function hostSandboxToggleBlocked(configEnabled: boolean): string | null {
  if (!configEnabled) return FORGE_HOST_SANDBOX_DISABLED_ERROR
  return null
}

export function deriveSessionSandboxAcknowledged(
  pref: SessionSandboxPreference,
): SessionSandboxAppliedState | null {
  const { desired, applied } = pref
  if (
    desired &&
    applied &&
    desired.revision === applied.revision &&
    desired.enabled &&
    applied.enabled &&
    desired.sessionId === applied.sessionId &&
    applied.error == null
  ) {
    return applied
  }
  return null
}

export function isSessionSandboxPreferenceSettled(pref: SessionSandboxPreference): boolean {
  const { desired, applied } = pref
  if (!desired) return true
  if (!applied) return false
  return applied.revision === desired.revision
}

export type SessionSandboxDisplayStatus = 'enabled' | 'disabled' | 'loading' | 'failed'

export function deriveSessionSandboxDisplayStatus(
  pref: SessionSandboxPreference | null,
  sessionId?: string,
): SessionSandboxDisplayStatus {
  if (!pref || !sessionId) return 'disabled'
  if (pref.activeLoopSandboxes && Object.hasOwn(pref.activeLoopSandboxes, sessionId)) {
    return pref.activeLoopSandboxes[sessionId] ? 'enabled' : 'disabled'
  }
  const controller = pref.controller
  if (
    controller &&
    controller.revision === pref.desired?.revision &&
    controller.sessionId === sessionId
  ) {
    if (controller.phase === 'loading' && pref.desired?.enabled) return 'loading'
    if (controller.phase === 'failed') return 'failed'
  }
  const acknowledged = deriveSessionSandboxAcknowledged(pref)
  if (acknowledged?.sessionId === sessionId) return 'enabled'
  if (
    pref.desired?.sessionId === sessionId &&
    pref.desired.enabled &&
    isSessionSandboxPreferenceSettled(pref)
  ) {
    return 'failed'
  }
  if (pref.desired?.sessionId === sessionId && !isSessionSandboxPreferenceSettled(pref)) return 'loading'
  return 'disabled'
}

