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
  newSession: { id: string; workspaceID?: string | undefined }
  /** Session the user is currently viewing, or null when not on a session route. */
  currentSession: { id: string; workspaceID?: string | undefined } | null
  /** Predicate identifying forge loop workspaces. */
  isForgeWorkspace: (workspaceID: string) => boolean
}

/**
 * Pure decision rule: follow only when the user is viewing a session in the
 * same forge workspace as the new session, and they are not already on it.
 *
 * Returning true means the TUI should navigate from `currentSession.id` to
 * `newSession.id`. The rule deliberately does NOT yank users who have
 * navigated away from the loop's workspace.
 */
export function shouldFollowNewSession(input: FollowDecisionInput): boolean {
  const { newSession, currentSession, isForgeWorkspace } = input
  if (!currentSession) return false
  if (currentSession.id === newSession.id) return false
  if (!newSession.workspaceID) return false
  if (currentSession.workspaceID !== newSession.workspaceID) return false
  return isForgeWorkspace(newSession.workspaceID)
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

interface WorkspaceListEntry {
  id?: string
  type?: string
}

/**
 * Subscribes to `session.created` events and navigates the TUI to the new
 * session when the user is currently inside another session in the same
 * forge loop workspace. Idempotent on disposal: returns an unsubscribe
 * function suitable for registration with `api.lifecycle.onDispose`.
 *
 * The forge-workspace classification is resolved lazily from
 * `experimental.workspace.list` and cached per workspace id. Misses trigger
 * a single refresh; the cache survives for the lifetime of the TUI plugin.
 */
export function attachLoopSessionFollower(api: TuiPluginApi): () => void {
  const workspaceIsForge = new Map<string, boolean>()
  let refreshInFlight: Promise<void> | null = null
  let disposed = false

  const refreshWorkspaceTypes = async (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      const workspaceApi = api.client.experimental?.workspace
      if (!workspaceApi || typeof workspaceApi.list !== 'function') return
      try {
        const result = await workspaceApi.list()
        const entries = ((result as { data?: unknown[] } | undefined)?.data ?? []) as WorkspaceListEntry[]
        for (const entry of entries) {
          if (typeof entry.id === 'string' && entry.id) {
            workspaceIsForge.set(entry.id, entry.type === 'forge')
          }
        }
      } catch (err) {
        tuiFollowDebug(`refreshWorkspaceTypes: workspace.list failed error="${(err as Error).message}"`)
      }
    })().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  const isForgeWorkspaceCached = (workspaceID: string): boolean => {
    return workspaceIsForge.get(workspaceID) === true
  }

  // Prime the cache so the first rotation already resolves synchronously.
  void refreshWorkspaceTypes()

  const unsubscribe = api.event.on('session.created', (event) => {
    if (disposed) return
    const newSession = event.properties.info
    const newWorkspaceID = newSession.workspaceID
    if (!newWorkspaceID) return

    const currentSessionID = getCurrentRouteSessionId(api)
    if (!currentSessionID) return
    if (currentSessionID === newSession.id) return

    const currentSession = api.state.session.get(currentSessionID)
    if (!currentSession) return
    if (currentSession.workspaceID !== newWorkspaceID) return

    const navigateIfStillRelevant = (): void => {
      if (disposed) return
      const liveCurrent = getCurrentRouteSessionId(api)
      if (liveCurrent !== currentSessionID) {
        tuiFollowDebug(`skipped: route changed during lookup was=${currentSessionID} now=${liveCurrent ?? 'none'}`)
        return
      }
      if (!shouldFollowNewSession({
        newSession: { id: newSession.id, workspaceID: newWorkspaceID },
        currentSession: { id: currentSession.id, workspaceID: currentSession.workspaceID },
        isForgeWorkspace: isForgeWorkspaceCached,
      })) {
        tuiFollowDebug(`skipped: workspace=${newWorkspaceID} not classified as forge`)
        return
      }
      try {
        api.route.navigate('session', { sessionID: newSession.id })
        tuiFollowDebug(`navigated workspace=${newWorkspaceID} from=${currentSessionID} to=${newSession.id}`)
      } catch (err) {
        tuiFollowDebug(`route.navigate failed from=${currentSessionID} to=${newSession.id} error="${(err as Error).message}"`)
      }
    }

    if (workspaceIsForge.has(newWorkspaceID)) {
      navigateIfStillRelevant()
      return
    }

    void refreshWorkspaceTypes().then(navigateIfStillRelevant)
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
