import type { Permission } from '@opencode-ai/sdk'
import type { Logger } from '../types'

export interface PermissionAskDeps {
  resolver: {
    resolveActiveLoopForSession(sessionId: string): Promise<{ loopName: string; active: boolean; sandbox?: boolean; worktree?: boolean; worktreeDir?: string } | null>
  }
  logger: Logger
}

/**
 * Permission ask hook. We never set output.status — opencode's own ruleset
 * evaluation (session ruleset → agent permission → global config) is the
 * source of truth. This hook exists purely for diagnostic logging so we can
 * trace permission flow for loop sessions.
 *
 * Worktree loops persist a session-level allow-all ruleset (see
 * `buildLoopPermissionRuleset`), so permission asks should not normally fire
 * for them. In-place loops persist no session ruleset and defer entirely to
 * the host's global config.
 */
export function createPermissionAskHandler(deps: PermissionAskDeps) {
  return async (input: Permission, _output: { status?: 'allow' | 'deny' | 'ask' }): Promise<void> => {
    const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])
    const state = await deps.resolver.resolveActiveLoopForSession(input.sessionID).catch(() => null)
    const mode = state ? (state.worktree ? 'worktree' : 'in-place') : 'non-loop'
    deps.logger.log(
      `[permission.ask] session=${input.sessionID} type=${input.type} patterns=[${patterns.join(', ')}] ` +
      `loop=${state?.loopName ?? 'none'} mode=${mode} sandbox=${state?.sandbox ?? 'n/a'}`
    )
  }
}