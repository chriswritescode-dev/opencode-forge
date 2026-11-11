import { existsSync, readFileSync, statSync } from 'fs'
import { platform } from 'os'
import { parseEnv } from 'util'
import type { Logger, ProjectSandboxConfig, SandboxConfig } from '../types'
import { isRecord } from '../utils/is-record'

export function isSandboxEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'PATH' && name !== 'HOME' && !name.startsWith('MSB_')
}

export function readSandboxEnvValues(value: unknown, logger?: Logger): Record<string, string> {
  if (!isRecord(value)) return {}
  const values: Record<string, string> = {}
  for (const name of Object.keys(value).sort()) {
    if (!isSandboxEnvName(name)) {
      logger?.log(`Sandbox: ignoring invalid env name ${JSON.stringify(name)}`)
      continue
    }
    const entry = value[name]
    if (typeof entry !== 'string' || entry.includes('\0')) continue
    values[name] = entry
  }
  return values
}

export function readSandboxEnvNames(value: unknown, logger?: Logger): string[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!isSandboxEnvName(name)) {
      logger?.log(`Sandbox: ignoring invalid env name ${JSON.stringify(name)}`)
      continue
    }
    names.add(name)
  }
  return [...names].sort()
}

export function readSandboxSecrets(path: string, logger: Logger): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    const text = readFileSync(path, 'utf-8')
    if (platform() !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      logger.log(`Sandbox: secrets file ${path} is readable by other users; run chmod 600 on it`)
    }
    return readSandboxEnvValues(parseEnv(text), logger)
  } catch (error) {
    logger.error(`Sandbox: failed to read secrets file ${path}: ${String(error)}`)
    return {}
  }
}

export function resolveSandboxEnv(input: {
  config?: SandboxConfig
  project?: ProjectSandboxConfig
  hostEnv?: NodeJS.ProcessEnv
  secrets?: Record<string, string>
  logger?: Logger
}): Record<string, string> {
  const hostEnv = input.hostEnv ?? process.env
  const secrets = input.secrets ?? {}
  const resolved: Record<string, string> = {}
  const passthrough = readSandboxEnvNames(
    [...(input.config?.network?.env ?? []), ...(input.project?.network?.env ?? [])],
    input.logger,
  )
  for (const name of passthrough) {
    const value = hostEnv[name] ?? secrets[name]
    if (value === undefined) {
      input.logger?.log(`Sandbox: skipping env ${name}: not set in the host environment or the secrets file`)
      continue
    }
    resolved[name] = value
  }
  Object.assign(
    resolved,
    readSandboxEnvValues(input.config?.env, input.logger),
    readSandboxEnvValues(input.project?.env, input.logger),
  )
  const sorted: Record<string, string> = {}
  for (const name of Object.keys(resolved).sort()) {
    sorted[name] = resolved[name] as string
  }
  return sorted
}
