import { collectLoopPermissionConfigWarnings } from '../constants/loop'
import { isForgeWorktreeDir } from '../workspace/forge-naming'
import type { Logger, PluginConfig } from '../types'

export interface LoopPermissionWarningSink {
  logger: Logger | Console
  /** Called once with the collected warnings when they should be surfaced to the user. */
  onWarnings: (warnings: string[]) => void
}

/**
 * Single emitter for `loop.permissions` config warnings. Every launch surface
 * routes through this so the once-per-root-instance semantics live in one
 * place: warnings are always logged (cheap and useful for diagnosis), and the
 * user-facing surface fires only for non-worktree directories. A forge worktree
 * is a fresh plugin instance of the same project, so re-surfacing there would
 * spam the toast once per loop/group launch.
 */
export function emitLoopPermissionConfigWarnings(
  config: PluginConfig | undefined,
  dataDir: string,
  directory: string,
  sink: LoopPermissionWarningSink,
): void {
  const warnings = collectLoopPermissionConfigWarnings(config)
  for (const warning of warnings) {
    sink.logger.log(warning)
  }
  if (warnings.length > 0 && !isForgeWorktreeDir(dataDir, directory)) {
    sink.onWarnings(warnings)
  }
}
