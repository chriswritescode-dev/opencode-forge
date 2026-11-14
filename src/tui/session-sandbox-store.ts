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
  hostSessionsDefault: boolean
  unavailable?: boolean
  unavailableReason?: string
}

export function hostSandboxToggleBlocked(configEnabled: boolean): string | null {
  if (!configEnabled) return FORGE_HOST_SANDBOX_DISABLED_ERROR
  return null
}

export function isHostSandboxRunning(pref: SessionSandboxPreference): boolean {
  const { desired, applied } = pref
  return !!desired
    && !!applied
    && desired.revision === applied.revision
    && applied.running
    && applied.error === null
}

export type ParentSessionIdResolver = (sessionId: string) => string | null | undefined

export function isSessionSandboxWanted(
  pref: SessionSandboxPreference,
  sessionId: string,
  getParentSessionId?: ParentSessionIdResolver,
): boolean {
  const sessions = pref.desired?.sessions
  if (!sessions) return pref.hostSessionsDefault
  const visited = new Set<string>()
  let current: string | null | undefined = sessionId
  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current)
    if (Object.hasOwn(sessions, current)) return sessions[current]
    current = getParentSessionId?.(current)
  }
  return pref.hostSessionsDefault
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
  getParentSessionId?: ParentSessionIdResolver,
): SessionSandboxDisplayStatus {
  if (!pref || !sessionId) return 'disabled'
  if (pref.activeLoopSandboxes && Object.hasOwn(pref.activeLoopSandboxes, sessionId)) {
    return pref.activeLoopSandboxes[sessionId] ? 'enabled' : 'disabled'
  }
  if (!isSessionSandboxWanted(pref, sessionId, getParentSessionId)) return 'disabled'
  const controller = pref.controller
  if (controller && controller.revision === pref.desired?.revision) {
    if (controller.phase === 'loading') return 'loading'
    if (controller.phase === 'failed') return 'failed'
  }
  if (isHostSandboxRunning(pref)) return 'enabled'
  if (isSessionSandboxPreferenceSettled(pref) && pref.applied?.error) return 'failed'
  return 'loading'
}
