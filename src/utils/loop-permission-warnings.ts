import { collectLoopPermissionConfigWarnings, collectSessionReuseConfigWarnings } from '../constants/loop'
import { isForgeWorktreeDir } from '../workspace/forge-naming'
import type { Logger, PluginConfig } from '../types'

export interface LoopPermissionWarningSink {
  logger: Logger | Console
  onWarnings: (warnings: string[]) => void
}

function emitLoopConfigWarnings(
  warnings: string[],
  dataDir: string,
  directory: string,
  sink: LoopPermissionWarningSink,
): void {
  for (const warning of warnings) {
    sink.logger.log(warning)
  }
  if (warnings.length > 0 && !isForgeWorktreeDir(dataDir, directory)) {
    sink.onWarnings(warnings)
  }
}

export function emitLoopPermissionConfigWarnings(
  config: PluginConfig | undefined,
  dataDir: string,
  directory: string,
  sink: LoopPermissionWarningSink,
): void {
  emitLoopConfigWarnings(collectLoopPermissionConfigWarnings(config), dataDir, directory, sink)
}

export function emitLoopSessionReuseConfigWarnings(
  config: PluginConfig | undefined,
  dataDir: string,
  directory: string,
  sink: LoopPermissionWarningSink,
): void {
  emitLoopConfigWarnings(collectSessionReuseConfigWarnings(config), dataDir, directory, sink)
}
