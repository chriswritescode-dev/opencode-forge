import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import type { Logger } from '../types'

/** Filename forge writes the inline opencode config to inside a worktree. */
export const WORKTREE_OPENCODE_CONFIG_FILENAME = 'opencode.jsonc'

/**
 * Placeholder token users may embed in `loop.worktreeOpencodeConfig` string values
 * (typically MCP `command` arrays). Replaced with the loop's sandbox container name
 * at write time; MCP entries referencing it are dropped when the loop has no sandbox.
 */
export const SANDBOX_CONTAINER_PLACEHOLDER = '{{FORGE_SANDBOX_CONTAINER}}'

/** Filenames opencode discovers as a project config; any present means "already configured". */
const OPENCODE_CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json'] as const

type WriteWorktreeOpencodeConfigReason = 'no-config' | 'exists' | 'written' | 'error'

export interface WriteWorktreeOpencodeConfigInput {
  /** Absolute worktree root directory. */
  directory: string
  /** Inline config object from `loop.worktreeOpencodeConfig` (may be undefined/empty). */
  config: Record<string, unknown> | undefined
  /**
   * Sandbox container name for this loop, when one will be provisioned.
   * Substituted for {@link SANDBOX_CONTAINER_PLACEHOLDER} in config string values.
   * When undefined, MCP entries referencing the placeholder are dropped instead.
   */
  sandboxContainerName?: string
  logger: Logger
}

export interface WriteWorktreeOpencodeConfigResult {
  written: boolean
  reason: WriteWorktreeOpencodeConfigReason
  /** Path written when `written` is true; undefined otherwise. */
  path?: string
}

function substituteDeep(value: unknown, containerName: string): unknown {
  if (typeof value === 'string') return value.split(SANDBOX_CONTAINER_PLACEHOLDER).join(containerName)
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, containerName))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, containerName)]))
  }
  return value
}

/**
 * Resolve {@link SANDBOX_CONTAINER_PLACEHOLDER} in a config object. With a container
 * name, every string occurrence is substituted. Without one (loop has no sandbox),
 * MCP entries referencing the placeholder are dropped so opencode never spawns a
 * `docker exec` against a container that does not exist; any residual occurrence
 * outside `mcp` is logged as a warning and left as-is.
 */
function resolveSandboxPlaceholder(
  config: Record<string, unknown>,
  sandboxContainerName: string | undefined,
  logger: Logger,
): Record<string, unknown> {
  if (!JSON.stringify(config).includes(SANDBOX_CONTAINER_PLACEHOLDER)) return config
  if (sandboxContainerName) {
    return substituteDeep(config, sandboxContainerName) as Record<string, unknown>
  }
  const result = { ...config }
  const mcp = result.mcp
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    const kept: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [name, entry] of Object.entries(mcp)) {
      if (JSON.stringify(entry)?.includes(SANDBOX_CONTAINER_PLACEHOLDER)) dropped.push(name)
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

/**
 * Write the inline opencode config into a worktree as `opencode.jsonc`.
 * Skip-if-exists (never overwrites a committed opencode config) and non-fatal:
 * any failure is logged and reported via `reason: 'error'`, never thrown.
 */
export function writeWorktreeOpencodeConfig(
  input: WriteWorktreeOpencodeConfigInput,
): WriteWorktreeOpencodeConfigResult {
  const { directory, logger, sandboxContainerName } = input
  if (!input.config || typeof input.config !== 'object' || Object.keys(input.config).length === 0) {
    return { written: false, reason: 'no-config' }
  }
  const config = resolveSandboxPlaceholder(input.config, sandboxContainerName, logger)
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
