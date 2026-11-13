import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { z } from 'zod'
import type { Logger, PluginConfig } from '../types'

export type WorktreeOpencodeConfig = NonNullable<NonNullable<PluginConfig['loop']>['worktreeOpencodeConfig']>

const jsonValueSchema = z.json()
type JsonValue = z.infer<typeof jsonValueSchema>
const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
type JsonObject = z.infer<typeof jsonObjectSchema>

function isJsonObject(value: JsonValue): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success
}

export const WORKTREE_OPENCODE_CONFIG_FILENAME = 'opencode.jsonc'

export const SANDBOX_CONTAINER_PLACEHOLDER = '{{FORGE_SANDBOX_CONTAINER}}'

const OPENCODE_CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json'] as const

type WriteWorktreeOpencodeConfigReason = 'no-config' | 'exists' | 'written' | 'error'

export interface WriteWorktreeOpencodeConfigInput {
  directory: string
  config: WorktreeOpencodeConfig | undefined
  sandboxContainerName?: string
  logger: Logger
}

export interface WriteWorktreeOpencodeConfigResult {
  written: boolean
  reason: WriteWorktreeOpencodeConfigReason
  path?: string
}

function substituteDeep(value: JsonValue, containerName: string): JsonValue {
  const text = z.string().safeParse(value)
  if (text.success) return text.data.split(SANDBOX_CONTAINER_PLACEHOLDER).join(containerName)
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, containerName))
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, containerName)]))
  }
  return value
}

function resolveSandboxPlaceholder(
  config: JsonObject,
  sandboxContainerName: string | undefined,
  logger: Logger,
): JsonObject {
  if (!JSON.stringify(config).includes(SANDBOX_CONTAINER_PLACEHOLDER)) return config
  if (sandboxContainerName) {
    const substituted = jsonObjectSchema.safeParse(substituteDeep(config, sandboxContainerName))
    return substituted.success ? substituted.data : config
  }
  const result: JsonObject = { ...config }
  const mcp = result.mcp
  if (isJsonObject(mcp)) {
    const kept: JsonObject = {}
    const dropped: string[] = []
    for (const [name, entry] of Object.entries(mcp)) {
      if (JSON.stringify(entry).includes(SANDBOX_CONTAINER_PLACEHOLDER)) dropped.push(name)
      else kept[name] = entry
    }
    if (dropped.length > 0) {
      logger.log(
        `worktree-opencode-config: dropped mcp server(s) referencing ${SANDBOX_CONTAINER_PLACEHOLDER} (loop has no sandbox): ${dropped.join(', ')}`,
      )
      if (Object.keys(kept).length > 0) result.mcp = kept
      else delete result.mcp
    }
  }
  if (JSON.stringify(result).includes(SANDBOX_CONTAINER_PLACEHOLDER)) {
    logger.log(
      `worktree-opencode-config: warning: ${SANDBOX_CONTAINER_PLACEHOLDER} present outside mcp but loop has no sandbox; leaving unsubstituted`,
    )
  }
  return result
}

export function writeWorktreeOpencodeConfig(
  input: WriteWorktreeOpencodeConfigInput,
): WriteWorktreeOpencodeConfigResult {
  const { directory, logger, sandboxContainerName } = input
  if (!input.config) {
    return { written: false, reason: 'no-config' }
  }
  const decoded = jsonObjectSchema.safeParse(input.config)
  if (!decoded.success || Object.keys(decoded.data).length === 0) {
    return { written: false, reason: 'no-config' }
  }
  const config = resolveSandboxPlaceholder(decoded.data, sandboxContainerName, logger)
  if (Object.keys(config).length === 0) {
    return { written: false, reason: 'no-config' }
  }
  const existing = OPENCODE_CONFIG_FILENAMES.find((name) => existsSync(join(directory, name)))
  if (existing) {
    logger.log(`worktree-opencode-config: ${existing} already present in ${directory}; skipping`)
    return { written: false, reason: 'exists' }
  }
  const target = join(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)
  try {
    writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    logger.log(`worktree-opencode-config: wrote ${WORKTREE_OPENCODE_CONFIG_FILENAME} in ${directory}`)
    return { written: true, reason: 'written', path: target }
  } catch (err) {
    logger.log(
      `worktree-opencode-config: failed to write ${WORKTREE_OPENCODE_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { written: false, reason: 'error' }
  }
}
