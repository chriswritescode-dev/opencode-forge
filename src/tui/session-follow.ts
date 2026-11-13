import type { Plugin } from '@opencode/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../utils/opencode-paths'
import { errorMessage } from '../utils/error-message'

export interface FollowDecisionInput {
  newSession: { id: string; scope?: string | undefined; parentID?: string | undefined }
  currentSession: { id: string; scope?: string | undefined } | null
}

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
  }
}

export function attachV2LoopSessionFollower(
  context: Plugin.Context,
  isLoopDirectory: (directory: string) => Promise<boolean>,
): () => void {
  return context.data.on('session.created', (event) => {
    const route = context.ui.router.current()
    if (route.type !== 'session') return
    const newDirectory = event.data.location.directory
    void (async () => {
      const inLoop = await isLoopDirectory(newDirectory)
      const currentRoute = context.ui.router.current()
      if (currentRoute.type !== 'session') return
      const currentDirectory = context.data.session.get(currentRoute.sessionID)?.location.directory
      if (!shouldFollowNewSession({
        newSession: {
          id: event.data.sessionID,
          scope: inLoop ? newDirectory : undefined,
          parentID: event.data.parentID,
        },
        currentSession: { id: currentRoute.sessionID, scope: currentDirectory },
      })) return
      try {
        context.ui.router.navigate({ type: 'session', sessionID: event.data.sessionID })
        tuiFollowDebug(`navigated directory=${newDirectory} from=${currentRoute.sessionID} to=${event.data.sessionID}`)
      } catch (err) {
        tuiFollowDebug(`router.navigate failed from=${currentRoute.sessionID} to=${event.data.sessionID} error="${errorMessage(err)}"`)
      }
    })()
  })
}
