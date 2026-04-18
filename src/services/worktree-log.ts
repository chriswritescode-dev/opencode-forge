import { mkdirSync, appendFileSync, existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir } from 'os'
import type { PluginConfig, Logger } from '../types'
import { toContainerPath } from '../sandbox/path'

/**
 * Context for resolving worktree log target paths.
 */
export interface WorktreeLogContext {
  /** The project directory (loop worktree dir or project root). */
  projectDir: string
  /** Optional data directory for default path resolution. */
  dataDir?: string
  /** Optional sandbox host directory for permission path mapping. */
  sandboxHostDir?: string
  /** Whether the loop is running in sandbox mode. */
  sandbox?: boolean
}

/**
 * Serializable payload containing all data needed for worktree completion logging.
 * This allows the host session to write logs without needing access to the worktree session.
 */
export interface WorktreeCompletionLogPayload {
  /** The configured log directory (host path). */
  logDirectory: string
  /** The project directory (host path). */
  projectDir: string
  /** The name of the completed loop. */
  loopName: string
  /** ISO timestamp of completion. */
  completionTimestamp: string
  /** The iteration count when the loop completed. */
  iteration: number
  /** The worktree branch name, if applicable. */
  worktreeBranch?: string
  /** The plan text to include in the log entry, if available. */
  planText?: string | null
}

/**
 * Result of building a worktree completion log payload.
 */
export interface BuildWorktreeCompletionPayloadResult {
  /** The serializable payload for logging. */
  payload: WorktreeCompletionLogPayload
  /** The permission path for sandbox rules (may be null if outside sandbox mount). */
  permissionPath: string | null
  /** The resolved host path for the log directory. */
  hostPath: string
}

/**
 * Result of resolving a worktree log target.
 * Contains both the host path and the permission path for sandbox-aware rules.
 */
export interface WorktreeLogTarget {
  /** The absolute path on the host filesystem. */
  hostPath: string
  /** The path to use for permission rules (may be container-mapped or null if unreachable). */
  permissionPath: string | null
}

/**
 * Normalizes a configured log directory string by expanding home-directory shorthand.
 * - `~` becomes the current user's home directory
 * - `~/sub/path` becomes `<homedir>/sub/path`
 * - Already-absolute paths are returned unchanged
 * - Ordinary relative paths are returned unchanged (caller resolves against projectDir)
 */
function normalizeConfiguredLogDirectory(directory: string): string {
  // Handle exact `~` or `~/...` forms
  if (directory === '~') {
    return homedir()
  }
  
  if (directory.startsWith('~/')) {
    const relativePath = directory.slice(2)
    return join(homedir(), relativePath)
  }
  
  // Return unchanged for absolute paths or ordinary relative paths
  return directory
}

/**
 * Pure resolver: derives the configured log directory from config + runtime context.
 * Does NOT create directories or verify writability.
 * Returns null if logging is disabled or directory cannot be resolved.
 */
export function resolveWorktreeLogTarget(
  config: PluginConfig,
  context: WorktreeLogContext,
  logger?: Logger,
): WorktreeLogTarget | null {
  const worktreeLogging = config.loop?.worktreeLogging
  if (!worktreeLogging?.enabled) {
    return null
  }

  let directory = worktreeLogging.directory
  
  // Use default data-dir-based location when directory is omitted but logging is enabled
  if (!directory || directory.trim() === '') {
    if (context.dataDir) {
      directory = join(context.dataDir, 'worktree-logs')
    } else {
      logger?.error('Worktree logging: enabled but directory is not configured and no dataDir provided')
      return null
    }
  }

  try {
    // Normalize tilde expansion before checking absolute/relative
    const normalizedDirectory = normalizeConfiguredLogDirectory(directory)
    
    // Resolve relative paths against projectDir, not process.cwd()
    const resolvedPath = isAbsolute(normalizedDirectory)
      ? normalizedDirectory
      : join(context.projectDir, normalizedDirectory)
    
    // Compute permission path based on sandbox context
    let permissionPath: string | null
    if (context.sandbox) {
      if (context.sandboxHostDir) {
        // Map host path to container-visible path if within sandbox mount
        const mappedPath = toContainerPath(resolvedPath, context.sandboxHostDir)
        // Only use mapped path if it's actually within the container mount
        // If the path is outside the mount, permissionPath should be null
        // to prevent granting meaningless host-only external_directory rules
        permissionPath = mappedPath.startsWith('/workspace/') || mappedPath === '/workspace'
          ? mappedPath
          : null
      } else {
        // Sandbox enabled but no sandboxHostDir provided - cannot compute valid permission path
        // Default to null to avoid granting incorrect permissions
        permissionPath = null
      }
    } else {
      // Non-sandbox mode: use host path directly
      permissionPath = resolvedPath
    }

    return {
      hostPath: resolvedPath,
      permissionPath,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.error(`Worktree logging: failed to resolve directory "${directory}": ${errorMsg}`)
    return null
  }
}

/**
 * Validator/initializer: creates the directory and verifies write access.
 * Should only be called when host-side logging is about to occur.
 * Returns true if the directory is writable, false otherwise.
 */
export function ensureWorktreeLogDirectory(hostPath: string, logger?: Logger): boolean {
  try {
    // Create directory recursively if it doesn't exist
    if (!existsSync(hostPath)) {
      mkdirSync(hostPath, { recursive: true })
    }

    // Verify we can write to the directory
    const testFile = join(hostPath, '.write-test')
    appendFileSync(testFile, '')
    return true
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.error(`Worktree logging: failed to validate directory "${hostPath}": ${errorMsg}`)
    return false
  }
}

/**
 * Formats a date as YYYY-MM-DD in local timezone.
 */
export function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Formats a worktree completion entry with plan-based deterministic formatting.
 * This is a pure helper for tests and host logging prompts.
 */
export function formatWorktreeCompletionEntry(
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    iteration: number
    worktreeBranch?: string
  },
  planText: string | null,
): string {
  const timestamp = options.completionTimestamp.toISOString()
  const branchInfo = options.worktreeBranch ? `\n- **Branch:** ${options.worktreeBranch}` : ''
  const planSection = (planText?.trim()) || 'Plan unavailable'
  
  return `# ${options.projectDir}

## ${options.loopName}

- **Loop:** ${options.loopName}${branchInfo}
- **Completed:** ${timestamp}
- **Iteration:** ${options.iteration}

### Plan

${planSection}

---

`
}

/**
 * Appends a markdown entry to the dated log file.
 * Creates the file if it doesn't exist.
 * Returns true on success, false on failure.
 */
export function appendWorktreeLogEntry(
  directory: string,
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    iteration: number
    worktreeBranch?: string
  },
  planText?: string | null,
  logger?: Logger,
): boolean {
  try {
    const dateKey = formatDateKey(options.completionTimestamp)
    const logFile = join(directory, `${dateKey}.md`)

    const entry = formatWorktreeCompletionEntry(options, planText ?? null)

    appendFileSync(logFile, entry, 'utf-8')
    logger?.debug(`Worktree log: appended entry to ${logFile}`)
    return true
  } catch (err) {
    logger?.error(`Worktree log: failed to append entry`, err)
    return false
  }
}

/**
 * Builds a serializable payload for worktree completion logging.
 * This payload contains all data needed to write a log entry from the host session.
 * 
 * @returns The payload result with hostPath and permissionPath, or null if logging is disabled/misconfigured
 */
export function buildWorktreeCompletionPayload(
  config: PluginConfig,
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    iteration: number
    worktreeBranch?: string
    dataDir?: string
  },
  logger?: Logger,
): BuildWorktreeCompletionPayloadResult | null {
  const worktreeLogging = config.loop?.worktreeLogging
  if (!worktreeLogging?.enabled) {
    logger?.debug('Worktree logging: disabled, skipping')
    return null
  }

  // Resolve the log target using the host project directory
  const logTarget = resolveWorktreeLogTarget(config, {
    projectDir: options.projectDir,
    dataDir: options.dataDir,
  }, logger)
  
  if (!logTarget) {
    return null
  }

  const payload: WorktreeCompletionLogPayload = {
    logDirectory: logTarget.hostPath,
    projectDir: options.projectDir,
    loopName: options.loopName,
    completionTimestamp: options.completionTimestamp.toISOString(),
    iteration: options.iteration,
    worktreeBranch: options.worktreeBranch,
  }

  return {
    payload,
    permissionPath: logTarget.permissionPath,
    hostPath: logTarget.hostPath,
  }
}

/**
 * Writes a worktree completion log entry from a prepared payload.
 * This is the host-side writer that should be called from a host session context.
 * 
 * @returns true on success, false on failure (fails closed)
 */
export function writeWorktreeCompletionLog(
  payload: WorktreeCompletionLogPayload,
  logger?: Logger,
): boolean {
  // Validate and initialize the host path before writing
  if (!ensureWorktreeLogDirectory(payload.logDirectory, logger)) {
    return false
  }

  const completionDate = new Date(payload.completionTimestamp)
  
  return appendWorktreeLogEntry(
    payload.logDirectory,
    {
      projectDir: payload.projectDir,
      loopName: payload.loopName,
      completionTimestamp: completionDate,
      iteration: payload.iteration,
      worktreeBranch: payload.worktreeBranch,
    },
    payload.planText,
    logger,
  )
}


