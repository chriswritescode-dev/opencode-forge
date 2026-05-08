import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { resolveLogPath } from './storage'
import { modify, applyEdits, type JSONPath } from 'jsonc-parser/lib/esm/main'
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
  const result = { ...config }
  if (!result.decomposer) {
    result.decomposer = {}
  }
  if (result.decomposer.enabled === undefined) result.decomposer.enabled = true
  if (result.decomposer.mode === undefined) result.decomposer.mode = 'agent'
  if (result.decomposer.onParseFailure === undefined) result.decomposer.onParseFailure = 'legacy'
  if (result.decomposer.maxSections === undefined) result.decomposer.maxSections = 12
  return result
}

/**
 * Saves the plugin config to disk while preserving comments and formatting.
 * Uses jsonc-parser to apply targeted edits without disturbing existing structure.
 */
export function savePluginConfig(next: PluginConfig): void {
  const configDir = resolveConfigDir()
  mkdirSync(configDir, { recursive: true })
  const configPath = resolveConfigPath()

  let existing: string
  try {
    existing = readFileSync(configPath, 'utf-8')
  } catch {
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8')
    return
  }

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' }
  let output = existing
  for (const [path, value] of flattenLeafEntries(next)) {
    const edits = modify(output, path as JSONPath, value, { formattingOptions })
    output = applyEdits(output, edits)
  }
  writeFileSync(configPath, output, 'utf-8')
}

function* flattenLeafEntries(obj: unknown, prefix: (string | number)[] = []): Generator<[(string | number)[], unknown]> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    yield [prefix, obj]
    return
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    yield* flattenLeafEntries(v, [...prefix, k])
  }
}

/**
 * Updates the tui.autoSavePlans field and persists the config to disk.
 * Returns the updated config object.
 */
export function setTuiAutoSavePlans(enabled: boolean): PluginConfig {
  const current = loadPluginConfig()
  const next: PluginConfig = {
    ...current,
    tui: {
      ...current.tui,
      autoSavePlans: enabled,
    },
  }
  savePluginConfig(next)
  return next
}
