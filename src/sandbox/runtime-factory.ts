/**
 * Mode resolution and the single construction point for sandbox runtimes. All runtime
 * construction in the plugin routes through `createSandboxRuntime`; backend-specific
 * facades (`createSbxRuntime`, `createSmolvmRuntime`) are referenced only here and in tests.
 */
import type { Logger, PluginConfig, SandboxMode } from '../types'
import { createSbxRuntime, type CommandRunner, type SandboxRuntime } from './sbx'
import { createSmolvmRuntime } from './smolvm'

export type { SandboxMode }

/**
 * Resolves the configured sandbox backend. `'smolvm'` is explicit opt-in; anything else
 * (omitted, `'sbx'`, or an unknown/legacy value such as the pre-migration `'docker'`)
 * falls back to `'sbx'` so existing installs are untouched. Legacy values are reported
 * separately by `collectLegacySandboxConfigWarnings`.
 */
export function resolveSandboxMode(config: PluginConfig | undefined): SandboxMode {
  return config?.sandbox?.mode === 'smolvm' ? 'smolvm' : 'sbx'
}

/**
 * Constructs the runtime for `mode`. The single construction point for `SandboxRuntime`
 * instances; `dataDir` is forwarded so the smolvm runtime can manage its image store and
 * env-passthrough directory (the sbx runtime ignores it).
 */
export function createSandboxRuntime(
  mode: SandboxMode,
  logger: Logger,
  opts?: { dataDir?: string; run?: CommandRunner },
): SandboxRuntime {
  if (mode === 'smolvm') return createSmolvmRuntime(logger, opts)
  return createSbxRuntime(logger, { run: opts?.run })
}
