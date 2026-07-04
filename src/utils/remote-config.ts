import type { PluginConfig } from '../types'

export interface ResolvedRemoteServer {
  name: string
  url: string
  password?: string
  username: string
  gitRemote: string
  sandbox: boolean
}

function isValidRemoteEntry(
  entry: unknown,
): entry is { name: string; url: string } {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  return typeof e.name === 'string' && e.name.length > 0 &&
         typeof e.url === 'string' && e.url.length > 0
}

export function resolveRemoteServer(
  config: PluginConfig,
  name: string,
): ResolvedRemoteServer | null {
  if (!config.remotes || config.remotes.length === 0) return null
  const entry = config.remotes.find((r) => r?.name === name)
  if (!entry || !isValidRemoteEntry(entry)) return null
  return {
    name: entry.name,
    url: entry.url,
    password: entry.password,
    username: entry.username ?? 'opencode',
    gitRemote: entry.gitRemote ?? 'origin',
    sandbox: entry.sandbox ?? true,
  }
}

export function listRemoteNames(config: PluginConfig): string[] {
  if (!config.remotes || config.remotes.length === 0) return []
  return config.remotes.filter((r) => isValidRemoteEntry(r)).map((r) => r.name)
}

/**
 * Returns true if the given execution-mode label is allowed for the given target.
 * - 'local' allows all PLAN_EXECUTION_LABELS.
 * - Any remote target (non-empty, not 'local') allows only 'Loop'.
 */
export function isModeAllowedForTarget(target: string, modeLabel: string): boolean {
  if (target === 'local') return true
  return modeLabel === 'Loop'
}
