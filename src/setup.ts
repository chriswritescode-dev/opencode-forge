import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { resolveLogPath } from './storage'
import type { PluginConfig } from './types'

function resolveBundledConfigPath(): string {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  return join(pluginDir, '..', 'forge-config.jsonc')
}

function resolveConfigDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || defaultBase
  return join(xdgConfigHome, 'opencode')
}

export function resolveConfigPath(): string {
  return join(resolveConfigDir(), 'forge-config.jsonc')
}

function resolveLegacyConfigPaths(): string[] {
  return [
    join(resolveConfigDir(), 'memory-config.jsonc'),
    join(resolveConfigDir(), 'graph-config.jsonc'),
  ]
}

function ensureGlobalConfig(): void {
  const configDir = resolveConfigDir()
  const newConfigPath = resolveConfigPath()

  if (existsSync(newConfigPath)) {
    return
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  for (const legacyConfigPath of resolveLegacyConfigPaths()) {
    if (existsSync(legacyConfigPath)) {
      copyFileSync(legacyConfigPath, newConfigPath)
      return
    }
  }

  const bundledConfigPath = resolveBundledConfigPath()
  if (existsSync(bundledConfigPath)) {
    copyFileSync(bundledConfigPath, newConfigPath)
  }
}

function getDefaultConfig(): PluginConfig {
  return {
    logging: {
      enabled: false,
      file: resolveLogPath(),
    },
    api: {
      enabled: false,
      host: '127.0.0.1',
      port: 5552,
    },
  }
}

function isValidPluginConfig(config: unknown): config is PluginConfig {
  if (!config || typeof config !== 'object') return false
  return true
}

function stripComments(content: string): string {
  let result = content
  result = result.replace(/\/\*[\s\S]*?\*\//g, '')
  result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
  return result
}

function stripTrailingCommas(content: string): string {
  let result = content
  result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
  result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
  return result
}

function parseJsonc<T = unknown>(content: string): T {
  const cleaned = stripComments(content)
  const normalized = stripTrailingCommas(cleaned)
  return JSON.parse(normalized) as T
}

export function loadPluginConfig(): PluginConfig {
  ensureGlobalConfig()
  
  const configPath = resolveConfigPath()

  if (!existsSync(configPath)) {
    return getDefaultConfig()
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    const parsed = parseJsonc(content)

    if (!isValidPluginConfig(parsed)) {
      console.warn(`[forge] Invalid config at ${configPath}, using defaults`)
      return getDefaultConfig()
    }

    return normalizeConfig(parsed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[forge] Failed to load config at ${configPath}: ${message}, using defaults`)
    return getDefaultConfig()
  }
}

function normalizeConfig(config: PluginConfig): PluginConfig {
  // Emit deprecation warning before coalescing
  if (config.defaultKvTtlMs !== undefined && config.completedLoopTtlMs === undefined) {
    console.warn('[forge] Config: "defaultKvTtlMs" is deprecated, please rename to "completedLoopTtlMs". Compatibility shim will be removed in a future release.')
  }

  return {
    dataDir: config.dataDir,
    completedLoopTtlMs: config.completedLoopTtlMs ?? config.defaultKvTtlMs,
    logging: config.logging,
    compaction: config.compaction,
    messagesTransform: config.messagesTransform,
    executionModel: config.executionModel,
    auditorModel: config.auditorModel,
    loop: config.loop,
    tui: config.tui,
    agents: config.agents,
    sandbox: config.sandbox,
    graph: config.graph,
    api: config.api
      ? {
          enabled: config.api.enabled ?? false,
          host: config.api.host ?? '127.0.0.1',
          port: config.api.port ?? 5552,
        }
      : undefined,
  }
}
