import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { resolveLogPath } from './storage'
import { BUNDLED_PROMPTS_DIR } from './prompts/loader'
import { syncBundledDir } from './utils/bundled-sync'
import type { PluginConfig } from './types'

function resolvePluginDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function resolveBundledConfigPath(): string {
  return join(resolvePluginDir(), '..', 'forge-config.jsonc')
}

function resolveConfigDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || defaultBase
  return join(xdgConfigHome, 'opencode')
}

export function resolveBundledContainerDir(): string {
  return join(resolvePluginDir(), '..', 'container')
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

export function resolvePromptsDir(): string {
  return join(resolveConfigDir(), 'forge', 'prompts')
}

function resolveManifestPath(name: string): string {
  return join(resolveConfigDir(), 'forge', 'manifests', `${name}.json`)
}

function ensureBundledDir(
  label: string,
  srcDir: string,
  destDir: string,
  filter?: (relPath: string) => boolean,
): void {
  if (!existsSync(srcDir)) return
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  try {
    syncBundledDir(srcDir, destDir, resolveManifestPath(label), filter)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[forge] Failed to install bundled ${label}: ${message}`)
  }
}

function ensureBundledPrompts(): void {
  // BUNDLED_PROMPTS_DIR resolves to the compiled module directory, which also
  // contains JS/declaration/sourcemap build artifacts. Only prompt markdown
  // files should be installed into the user prompts directory.
  ensureBundledDir('prompts', BUNDLED_PROMPTS_DIR, resolvePromptsDir(), (rel) => rel.endsWith('.md'))
}

export function loadPluginConfig(): PluginConfig {
  ensureGlobalConfig()
  ensureBundledSkills()
  ensureBundledPrompts()

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
  return { ...config }
}

function ensureBundledSkills(): void {
  ensureBundledDir('skills', join(resolvePluginDir(), '..', 'skills'), join(resolveConfigDir(), 'skills'))
}


