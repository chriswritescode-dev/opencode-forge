import type { Permission } from '@opencode-ai/sdk'
import type { Logger } from '../types'

export interface PermissionAskDeps {
  resolver: {
    resolveActiveLoopForSession(sessionId: string): Promise<{ loopName: string; active: boolean; sandbox?: boolean; worktreeDir?: string } | null>
  }
  logger: Logger
}

export function createPermissionAskHandler(deps: PermissionAskDeps) {
  return async (input: Permission, output: { status?: 'allow' | 'deny' | 'ask' }): Promise<void> => {
    const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])
    deps.logger.log(`[permission.ask] session=${input.sessionID} type=${input.type} patterns=[${patterns.join(', ')}]`)

    const state = await deps.resolver.resolveActiveLoopForSession(input.sessionID)
    if (!state) {
      deps.logger.log(`[permission.ask] unresolved session=${input.sessionID} — falling through`)
      return
    }

    // Only apply permission checks to worktree loops (sandbox or non-sandbox worktrees)
    // In-place loops fall through to host default permissions
    const isWorktree = !!state.worktreeDir
    if (!isWorktree) {
      deps.logger.log(`[permission.ask] loop=${state.loopName} is not a worktree loop — falling through to host default`)
      return
    }

    if (patterns.some((p) => p.startsWith('git push'))) {
      deps.logger.log(`[permission.ask] deny git push session=${input.sessionID} loop=${state.loopName}`)
      output.status = 'deny'
      return
    }

    deps.logger.log(`[permission.ask] allow type=${input.type} session=${input.sessionID} loop=${state.loopName}`)
    output.status = 'allow'
  }
}