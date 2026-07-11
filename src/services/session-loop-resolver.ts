import type { Logger } from '../types'
import type { LoopService } from '../loop/service'
import { resolve } from 'path'

export interface SessionLoopResolverDeps {
  loop: {
    service: Pick<LoopService, 'resolveLoopName' | 'getActiveState'> & {
      resolveLoopNameForParticipant?: (sessionId: string) => string | null
    }
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
}

/**
 * Maximum number of ancestor hops to walk when resolving a session to its loop.
 * Sub-agents can spawn further sub-agents (e.g. a post-action `pr-review` skill
 * launching change-agents), producing a chain several levels deep. The cap plus
 * the cycle guard bound the work and prevent runaway lookups.
 */
const MAX_PARENT_DEPTH = 10

export function createSessionLoopResolver(deps: SessionLoopResolverDeps): {
  resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null>
} {
  // Goal loops retain a warped executor session alongside the rotating auditor
  // session. The executor is persisted in executor_session_id, distinct from
  // current_session_id (the auditor while auditing). Active-loop resolution must
  // treat both as loop participants so tool blocking and loop permissions apply
  // to the retained executor while its loop is auditing. Resolve participant-
  // aware first, then fall back to current-session-only resolution for callers
  // whose service does not expose the participant lookup.
  const resolveLoopParticipantName = (sessionId: string): string | null =>
    deps.loop.service.resolveLoopNameForParticipant?.(sessionId) ?? deps.loop.service.resolveLoopName(sessionId)

  return {
    async resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null> {
      const directLoopName = resolveLoopParticipantName(sessionId)
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
      const seen = new Set<string>([sessionId])
      let firstParentId: string | null = null
      let current = sessionId
      for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
        const parentId = await deps.getParentSessionId(current)
        if (!parentId || seen.has(parentId)) break
        seen.add(parentId)
        if (depth === 0) firstParentId = parentId

        deps.logger.debug(
          `[session-resolver] session=${sessionId} ancestor[${depth}]=${parentId} active=${directState?.loopName ?? 'none'}`,
        )

        const parentLoopName = resolveLoopParticipantName(parentId)
        const parentState = parentLoopName ? deps.loop.service.getActiveState(parentLoopName) : null
        if (parentState?.active) {
          deps.logger.log(`[session-resolver] session=${sessionId} resolved via ancestor=${parentId} depth=${depth} loop=${parentState.loopName}`)
          return parentState
        }

        current = parentId
      }

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
