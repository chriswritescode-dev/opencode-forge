import { homedir, platform } from 'os'
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

export function resolveLogPath(): string {
  return join(resolveDataDir(), 'logs', 'forge.log')
}

/**
 * Default absolute path for the shared loop scratch/temp directory. Used identically on the host
 * (worktree-only loops) and inside the sandbox container (bind-mounted at the same path), so
 * absolute temp paths resolve unchanged in both modes. Overridable via `loop.tmpDir`.
 */
export const DEFAULT_FORGE_TMP_DIR = '/tmp/oc-forge'

/**
 * Resolves the shared loop temp directory. Returns the configured override (trimmed) when present,
 * otherwise {@link DEFAULT_FORGE_TMP_DIR}. The same value feeds the `external_directory` allowlist
 * (both modes) and the sandbox bind-mount (mounted at the identical container path).
 */
export function resolveForgeTempDir(configuredPath?: string): string {
  const trimmed = configuredPath?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_FORGE_TMP_DIR
}
