import { homedir, platform, tmpdir } from 'os'
import { join } from 'path'

export function resolveOpencodeDataDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  return join(xdgDataHome, 'opencode')
}

export function resolveDataDir(): string {
  return join(resolveOpencodeDataDir(), 'forge')
}

export function resolveOpencodeToolOutputDir(): string {
  return join(resolveOpencodeDataDir(), 'tool-output')
}

export function resolveOpencodeTmpDir(): string {
  return join(tmpdir(), 'opencode')
}

export function resolveLogPath(): string {
  return join(resolveDataDir(), 'logs', 'forge.log')
}

export function resolveForgeDataDir(configuredDataDir?: string): string {
  const trimmed = configuredDataDir?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : resolveDataDir()
}

export function resolveForgeDbPath(configuredDataDir?: string): string {
  return join(resolveForgeDataDir(configuredDataDir), 'forge.db')
}

