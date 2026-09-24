import type { Plugin } from '@opencode/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../storage'

export interface FollowDecisionInput {
  /** Session that was just created (from a session.created event). */
  newSession: { id: string; scope?: string | undefined; parentID?: string | undefined }
  /** Session the user is currently viewing, or null when not on a session route. */
  currentSession: { id: string; scope?: string | undefined } | null
}

/**
 * Pure decision rule: follow only when the user is viewing a session in the
 * same loop scope as the new session, and they are not already on it. The
 * scope is the loop worktree directory.
 * A shared scope is the trust signal — when a session.created event fires
 * inside the loop the user is currently in, that is virtually always a
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
  if (!newSession.scope) return false
  if (currentSession.scope !== newSession.scope) return false
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

export function attachV2LoopSessionFollower(
  context: Plugin.Context,
  isLoopDirectory: (directory: string) => boolean,
): () => void {
  return context.data.on('session.created', (event) => {
    const route = context.ui.router.current()
    if (route.type !== 'session') return
    const newDirectory = event.data.location.directory
    const currentDirectory = context.data.session.get(route.sessionID)?.location.directory
    if (!shouldFollowNewSession({
      newSession: {
        id: event.data.sessionID,
        scope: isLoopDirectory(newDirectory) ? newDirectory : undefined,
        parentID: event.data.parentID,
      },
      currentSession: { id: route.sessionID, scope: currentDirectory },
    })) return
    try {
      context.ui.router.navigate({ type: 'session', sessionID: event.data.sessionID })
      tuiFollowDebug(`navigated directory=${newDirectory} from=${route.sessionID} to=${event.data.sessionID}`)
    } catch (err) {
      tuiFollowDebug(`router.navigate failed from=${route.sessionID} to=${event.data.sessionID} error="${(err as Error).message}"`)
    }
  })
}
