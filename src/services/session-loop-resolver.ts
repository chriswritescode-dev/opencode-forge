import type { Logger } from '../types'
import type { LoopService } from '../loop/service'
import { resolve } from 'path'
import { findSessionAncestor } from '../utils/session-ancestry'

export interface SessionLoopResolverDeps {
  loop: {
    service: Pick<LoopService, 'resolveLoopName' | 'getActiveState'>
    listActive(): Array<{ loopName: string; worktreeDir: string; sandbox?: boolean; worktree?: boolean; active: boolean; workspaceId?: string }>
  }
  getParentSessionId(sessionId: string): Promise<string | null>
  getSessionDirectory?(sessionId: string): Promise<string | null>
  logger: Logger
}

export interface ResolvedLoop {
  loopName: string
  active: boolean
  sandbox?: boolean
  worktree?: boolean
  worktreeDir?: string
  workspaceId?: string
}

export function createSessionLoopResolver(deps: SessionLoopResolverDeps): {
  resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null>
} {
  return {
    async resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null> {
      const directLoopName = deps.loop.service.resolveLoopName(sessionId)
      const directState = directLoopName ? deps.loop.service.getActiveState(directLoopName) : null

      deps.logger.debug(
        `[session-resolver] session=${sessionId} direct=${directLoopName ?? 'none'} parent=checking active=${directState?.loopName ?? 'none'}`,
      )

      if (directState?.active) return directState

      // Walk the ancestor chain so deeply-nested sub-agents (a sub-agent that
      // spawns another sub-agent via the Task tool) still resolve to the loop
      // session at the top of their chain. The immediate parent of such a
      // session is itself a sub-agent with no loop name, so a single hop is not
      // enough.
      let firstParentId: string | null = null
      const ancestorState = await findSessionAncestor(sessionId, deps.getParentSessionId, (parentId, depth) => {
        if (depth === 0) firstParentId = parentId

        deps.logger.debug(
          `[session-resolver] session=${sessionId} ancestor[${depth}]=${parentId} active=${directState?.loopName ?? 'none'}`,
        )

        const parentLoopName = deps.loop.service.resolveLoopName(parentId)
        const parentState = parentLoopName ? deps.loop.service.getActiveState(parentLoopName) : null
        if (parentState?.active) {
          deps.logger.log(`[session-resolver] session=${sessionId} resolved via ancestor=${parentId} depth=${depth} loop=${parentState.loopName}`)
          return parentState
        }
        return null
      })
      if (ancestorState) return ancestorState

      if (firstParentId && deps.getSessionDirectory) {
        const dir = await deps.getSessionDirectory(sessionId)
        if (dir) {
          const normalized = resolve(dir)
          for (const state of deps.loop.listActive()) {
            if (!state.worktree) continue
            if (resolve(state.worktreeDir) === normalized) {
              deps.logger.log(`[session-resolver] session=${sessionId} resolved via directory match loop=${state.loopName}`)
              const full = deps.loop.service.getActiveState(state.loopName)
              if (full?.active) return full
            }
          }
        }
      }

      return null
    },
  }
}
