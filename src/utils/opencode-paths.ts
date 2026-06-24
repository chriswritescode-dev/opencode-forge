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
