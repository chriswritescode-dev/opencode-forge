import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../storage'

/**
 * Returns the sessionID of the TUI's currently focused route, or null when
 * the user is not viewing a session (e.g. on the home route).
 */
export function getCurrentRouteSessionId(api: TuiPluginApi): string | null {
  const route = api.route.current
  if (route.name !== 'session') return null
  const params = (route as { params?: { sessionID?: unknown } }).params
  return typeof params?.sessionID === 'string' ? params.sessionID : null
}

export interface FollowDecisionInput {
  /** Session that was just created (from a session.created event). */
  newSession: { id: string; workspaceID?: string | undefined; parentID?: string | undefined }
  /** Session the user is currently viewing, or null when not on a session route. */
  currentSession: { id: string; workspaceID?: string | undefined } | null
}

/**
 * Pure decision rule: follow only when the user is viewing a session in the
 * same workspace as the new session, and they are not already on it. The
 * shared workspaceID is the trust signal — when a session.created event fires
 * inside the workspace the user is currently in, that is virtually always a
 * loop rotation (coding → audit → coding) and the TUI should follow.
 *
 * Sessions with a `parentID` are subagents/children (e.g. Task-tool spawns)
 * that inherit the loop's workspace but are NOT loop rotations. They must not
 * yank the user away from the loop they are watching. Loop rotation sessions
 * are created without a parent, so parentID is the discriminator.
 *
 * Returning true means the TUI should navigate from `currentSession.id` to
 * `newSession.id`. The rule deliberately does NOT yank users who have
 * navigated away from the loop's workspace.
 */
export function shouldFollowNewSession(input: FollowDecisionInput): boolean {
  const { newSession, currentSession } = input
  if (!currentSession) return false
  if (currentSession.id === newSession.id) return false
  if (newSession.parentID) return false
  if (!newSession.workspaceID) return false
  if (currentSession.workspaceID !== newSession.workspaceID) return false
  return true
}

function tuiFollowDebug(message: string): void {
  try {
    const file = resolveLogPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} DEBUG [OpenCodeForge:TUI:follow] ${message}\n`, 'utf-8')
  } catch {
    // Swallow logging errors — follow behavior must not interfere with TUI.
  }
}

/**
 * Subscribes to `session.created` events and navigates the TUI to the new
 * session when the user is currently inside another session in the same
 * workspace. Idempotent on disposal: returns an unsubscribe function
 * suitable for registration with `api.lifecycle.onDispose`.
 *
 * Navigation is dispatched synchronously inside the event handler. Deferring
 * it (e.g. behind an async workspace.list refresh) races with retention/delete
 * of the outgoing session: by the time the deferred callback runs, the TUI
 * has already been kicked off the route we were comparing against.
 */
export function attachLoopSessionFollower(api: TuiPluginApi): () => void {
  let disposed = false

  const unsubscribe = api.event.on('session.created', (event) => {
    if (disposed) return
    const newSession = event.properties.info
    const newWorkspaceID = newSession.workspaceID
    if (!newWorkspaceID) {
      tuiFollowDebug(`skip session=${newSession.id} reason=no-workspaceID-on-new`)
      return
    }

    const currentSessionID = getCurrentRouteSessionId(api)
    if (!currentSessionID) {
      tuiFollowDebug(`skip session=${newSession.id} workspace=${newWorkspaceID} reason=no-current-session-route`)
      return
    }
    if (currentSessionID === newSession.id) {
      tuiFollowDebug(`skip session=${newSession.id} reason=already-on-new`)
      return
    }

    const currentSession = api.state.session.get(currentSessionID)
    if (!currentSession) {
      tuiFollowDebug(`skip session=${newSession.id} workspace=${newWorkspaceID} reason=current-session-not-in-state currentID=${currentSessionID}`)
      return
    }
    if (!shouldFollowNewSession({
      newSession: { id: newSession.id, workspaceID: newWorkspaceID, parentID: newSession.parentID },
      currentSession: { id: currentSession.id, workspaceID: currentSession.workspaceID },
    })) {
      const reason = newSession.parentID ? 'subagent-child-session' : 'workspace-mismatch'
      tuiFollowDebug(`skip session=${newSession.id} workspace=${newWorkspaceID} reason=${reason} current=${currentSessionID} currentWorkspace=${currentSession.workspaceID ?? 'none'} parent=${newSession.parentID ?? 'none'}`)
      return
    }

    try {
      api.route.navigate('session', { sessionID: newSession.id })
      tuiFollowDebug(`navigated workspace=${newWorkspaceID} from=${currentSessionID} to=${newSession.id}`)
    } catch (err) {
      tuiFollowDebug(`route.navigate failed from=${currentSessionID} to=${newSession.id} error="${(err as Error).message}"`)
    }
  })

  return () => {
    disposed = true
    try {
      unsubscribe()
    } catch (err) {
      tuiFollowDebug(`unsubscribe failed error="${(err as Error).message}"`)
    }
  }
}
