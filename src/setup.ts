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
import type { JsonObject, JsonValue } from './utils/json-schema'
import { z } from 'zod'

export {
  resolveConfigPath,
  resolvePromptsDir,
  resolveSkillsDir,
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

const pluginConfigObjectSchema = z.looseObject({})

function isValidPluginConfig(config: JsonValue): config is JsonObject & PluginConfig {
  return pluginConfigObjectSchema.safeParse(config).success
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

function parseJsonc(content: string): JsonValue {
  const cleaned = stripComments(content)
  const normalized = stripTrailingCommas(cleaned)
  return z.json().parse(JSON.parse(normalized))
}

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

    return parsed
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[forge] Failed to load config at ${configPath}: ${message}, using defaults`)
    return getDefaultConfig()
  }
}
