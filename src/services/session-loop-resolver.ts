import type { Logger } from '../types'
import type { LoopService } from '../loop/service'
import { findSessionAncestor, tolerateUndeterminedParent } from '../utils/session-ancestry'
import { LRUCache } from '../utils/lru-cache'

export interface SessionLoopResolverDeps {
  loop: {
    service: Pick<LoopService, 'getRunStateForSession' | 'findActiveByWorktreeDir'>
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
  /** The lane checkout this run works in; undefined for serial runs. */
  laneDir?: string
  /** The section this run belongs to, empty for plan-scoped runs. */
  sectionId?: string
  /** Zero-based index of the run's section, used for its lane environment. */
  currentSectionIndex?: number
  /** The section run the resolved session belongs to. */
  sectionRunKey: string
}

interface Resolution {
  loop: ResolvedLoop | null
  via: string
}

export function createSessionLoopResolver(deps: SessionLoopResolverDeps): {
  resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null>
} {
  const lastLogged = new LRUCache<string>(1000)

  const resolve = async (sessionId: string): Promise<Resolution> => {
    const directState = deps.loop.service.getRunStateForSession(sessionId)
    if (directState?.active) return { loop: directState, via: 'direct' }

    // Walk the ancestor chain so deeply-nested sub-agents (a sub-agent that
    // spawns another sub-agent via the Task tool) still resolve to the loop
    // session at the top of their chain. The immediate parent of such a
    // session is itself a sub-agent with no loop name, so a single hop is not
    // enough.
    let firstParentId: string | null = null
    let via = 'none'
    const ancestorState = await tolerateUndeterminedParent(findSessionAncestor(sessionId, deps.getParentSessionId, (parentId, depth) => {
      if (depth === 0) firstParentId = parentId
      const parentState = deps.loop.service.getRunStateForSession(parentId)
      if (parentState?.active) {
        via = `ancestor=${parentId} depth=${depth}`
        return parentState
      }
      return null
    }))
    if (ancestorState) return { loop: ancestorState, via }

    if (firstParentId && deps.getSessionDirectory) {
      const dir = await deps.getSessionDirectory(sessionId)
      if (dir) {
        const matched = deps.loop.service.findActiveByWorktreeDir(dir, { worktreeOnly: true })
        if (matched?.active) return { loop: matched, via: 'directory match' }
      }
    }

    return { loop: null, via: 'none' }
  }

  return {
    async resolveActiveLoopForSession(sessionId: string): Promise<ResolvedLoop | null> {
      const { loop, via } = await resolve(sessionId)
      const outcome = loop ? `loop=${loop.loopName} via ${via}` : 'no active loop'
      if (lastLogged.get(sessionId) !== outcome) {
        lastLogged.set(sessionId, outcome)
        deps.logger.log(`[session-resolver] session=${sessionId} ${outcome}`)
      }
      return loop
    },
  }
}
