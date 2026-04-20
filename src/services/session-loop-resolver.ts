import type { Logger } from '../types'

export interface SessionLoopResolverDeps {
  loopService: {
    resolveLoopName(sessionId: string): string | null
    getActiveState(name: string): { loopName: string; active: boolean; sandbox?: boolean } | null
  }
  getParentSessionId(sessionId: string): Promise<string | null>
  logger: Logger
}

export interface ResolvedLoop {
  loopName: string
  active: boolean
  sandbox?: boolean
}

export function createSessionLoopResolver(deps: SessionLoopResolverDeps): {
  resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null>
} {
  return {
    async resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null> {
      const directLoopName = deps.loopService.resolveLoopName(sessionId)
      const directState = directLoopName ? deps.loopService.getActiveState(directLoopName) : null

      deps.logger.debug(
        `[session-resolver] session=${sessionId} direct=${directLoopName ?? 'none'} parent=checking active=${directState?.loopName ?? 'none'}`,
      )

      if (directState?.active) return directState

      const parentId = await deps.getParentSessionId(sessionId)

      deps.logger.debug(
        `[session-resolver] session=${sessionId} direct=${directLoopName ?? 'none'} parent=${parentId ?? 'none'} active=${directState?.loopName ?? 'none'}`,
      )

      if (!parentId) return null

      const parentLoopName = deps.loopService.resolveLoopName(parentId)
      const parentState = parentLoopName ? deps.loopService.getActiveState(parentLoopName) : null
      if (parentState?.active) {
        deps.logger.log(`[session-resolver] session=${sessionId} resolved via parent=${parentId} loop=${parentState.loopName}`)
      }
      return parentState?.active ? parentState : null
    },
  }
}
