import { homedir, platform, tmpdir } from 'os'
import { join } from 'path'

/**
 * Pure path resolvers for opencode/forge data locations. Kept free of heavy imports
 * (no `bun:sqlite`, no DB code) so lightweight modules — e.g. permission ruleset
 * construction — can derive these paths without pulling in the storage layer.
 */

export function resolveOpencodeDataDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  return join(xdgDataHome, 'opencode')
}

export function resolveDataDir(): string {
  return join(resolveOpencodeDataDir(), 'forge')
}

/**
 * Directory where opencode spills large tool outputs (its `TRUNCATION_DIR`). Mirrors opencode's
 * `path.join(Global.Path.data, 'tool-output')` so Forge can bind-mount it into sandbox containers
 * and grant it `external_directory` read access, letting tools read overflow files that opencode
 * references by absolute host path.
 */
export function resolveOpencodeToolOutputDir(): string {
  return join(resolveOpencodeDataDir(), 'tool-output')
}

/**
 * opencode's advertised scratch directory for its agents (`Global.Path.tmp`, `path.join(os.tmpdir(), app)`
 * in opencode `packages/core/src/global.ts`). opencode's shell-tool description tells the agent this
 * directory is pre-approved, so Forge grants it `external_directory` access for host file tools and
 * bind-mounts it read-write into the sandbox at the identical host path, so the same absolute path
 * resolves in both modes.
 */
export function resolveOpencodeTmpDir(): string {
  return join(tmpdir(), 'opencode')
}

export function resolveLogPath(): string {
  return join(resolveDataDir(), 'logs', 'forge.log')
}

/**
 * The single builder for the forge database path. `configuredDataDir` is
 * `PluginConfig.dataDir`; every entry point (plugin, TUI, dashboard, loop
 * execution) resolves through here so a configured `dataDir` cannot be honoured
 * by some readers and ignored by others.
 */
export function resolveForgeDbPath(configuredDataDir?: string): string {
  const trimmed = configuredDataDir?.trim()
  return join(trimmed && trimmed.length > 0 ? trimmed : resolveDataDir(), 'forge.db')
}

