import type { Permission } from '@opencode-ai/sdk'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'

export interface PermissionAskDeps {
  resolver: {
    resolveActiveLoopForSession(sessionId: string): Promise<{ loopName: string; active: boolean; sandbox?: boolean; worktreeDir?: string } | null>
  }
  logger: Logger
  v2: OpencodeClient
}

export function createPermissionAskHandler(deps: PermissionAskDeps) {
  return async (input: Permission, _output: { status?: 'allow' | 'deny' | 'ask' }): Promise<void> => {
    const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])
    const state = await deps.resolver.resolveActiveLoopForSession(input.sessionID).catch(() => null)
    deps.logger.log(
      `[permission.ask] session=${input.sessionID} type=${input.type} patterns=[${patterns.join(', ')}] ` +
      `loop=${state?.loopName ?? 'none'} worktreeDir=${state?.worktreeDir ?? 'n/a'} sandbox=${state?.sandbox ?? 'n/a'}`
    )

    try {
      const sess = await deps.v2.session.get({ sessionID: input.sessionID, directory: state?.worktreeDir })
      const persisted = (sess.data as { permission?: unknown })?.permission ?? null
      deps.logger.log(`[permission.ask] persisted-ruleset session=${input.sessionID} ruleset=${JSON.stringify(persisted)}`)
    } catch (err) {
      deps.logger.error(`[permission.ask] failed to fetch session ${input.sessionID} for diag`, err)
    }

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

    // For worktree loops, we let opencode's core permission system handle all decisions
    // by not setting output.status. This prevents conflicts between the hook and
    // opencode's own ruleset evaluation which throws DeniedError.
    deps.logger.log(`[permission.ask] worktree loop=${state.loopName} — falling through to opencode default`)
    return
  }
}