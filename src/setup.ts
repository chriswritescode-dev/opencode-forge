import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { resolveLogPath } from './storage'
import { syncBundledDir } from './utils/bundled-sync'
import {
  getBundleSpecs,
  resolveConfigDir,
  resolveConfigPath,
  resolveBundledConfigPath,
} from './install/paths'
import type { PluginConfig } from './types'

// Re-exported for consumers that import path helpers from setup.
export {
  resolveConfigPath,
  resolvePromptsDir,
  resolveBundledContainerDir,
} from './install/paths'

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

/**
 * Silently install bundled prompts and skills into the user config dir. This
 * runs on every plugin load and is intentionally non-interactive: it preserves
 * user edits and never deletes files. Use the standalone installer
 * (`bunx opencode-forge`) for interactive (re)install, conflict resolution, and
 * orphan pruning.
 */
function ensureBundledAssets(): void {
  for (const spec of getBundleSpecs()) {
    if (!existsSync(spec.bundledDir)) continue
    if (!existsSync(spec.destDir)) mkdirSync(spec.destDir, { recursive: true })
    try {
      syncBundledDir(spec.bundledDir, spec.destDir, spec.manifestPath, spec.filter)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[forge] Failed to install bundled ${spec.label}: ${message}`)
    }
  }
}

export function loadPluginConfig(): PluginConfig {
  ensureGlobalConfig()
  ensureBundledAssets()

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
