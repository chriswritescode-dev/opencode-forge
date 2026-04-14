import { mkdirSync, appendFileSync, existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import type { PluginConfig, Logger } from '../types'
import type { LoopSessionOutput } from './loop'
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
    // Resolve relative paths against projectDir, not process.cwd()
    const resolvedPath = isAbsolute(directory)
      ? directory
      : join(context.projectDir, directory)
    
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
 * Resolves and validates the configured worktree logging directory.
 * Returns null if logging is disabled or directory cannot be resolved.
 * Logs warnings when validation fails.
 * @deprecated Use resolveWorktreeLogTarget + ensureWorktreeLogDirectory instead
 */
export function resolveWorktreeLogDirectory(config: PluginConfig, logger?: Logger): string | null {
  const worktreeLogging = config.loop?.worktreeLogging
  if (!worktreeLogging?.enabled) {
    return null
  }

  const directory = worktreeLogging.directory
  if (!directory || directory.trim() === '') {
    logger?.error('Worktree logging: enabled but directory is not configured')
    return null
  }

  try {
    // Resolve to absolute path if relative (use isAbsolute for cross-platform support)
    const resolvedPath = isAbsolute(directory) ? directory : join(process.cwd(), directory)
    
    // Create directory recursively if it doesn't exist
    if (!existsSync(resolvedPath)) {
      mkdirSync(resolvedPath, { recursive: true })
    }

    // Verify we can write to the directory
    const testFile = join(resolvedPath, '.write-test')
    appendFileSync(testFile, '')
    return resolvedPath
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.error(`Worktree logging: failed to validate directory "${directory}": ${errorMsg}`)
    return null
  }
}

/**
 * Generates a summary from LoopSessionOutput.
 * Prefers the last assistant message text, falls back to file change info.
 */
export function summarizeSessionOutput(output: LoopSessionOutput): string {
  // Try to get the last assistant message
  if (output.messages && output.messages.length > 0) {
    const lastMessage = output.messages[output.messages.length - 1]
    if (lastMessage.text) {
      // Extract first line or truncate to reasonable length
      const firstLine = lastMessage.text.split('\n')[0]
      return firstLine.length > 200 ? firstLine.substring(0, 197) + '...' : firstLine
    }
  }

  // Fall back to file change info
  if (output.fileChanges) {
    const { additions, deletions, files } = output.fileChanges
    return `Modified ${files} file(s): +${additions} -${deletions}`
  }

  return 'No summary available'
}

/**
 * Formats a date as YYYY-MM-DD in local timezone.
 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Formats a timestamp for display in the log.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString()
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
    summary: string
    iteration: number
    worktreeBranch?: string
  },
  logger?: Logger,
): boolean {
  try {
    const dateKey = formatDateKey(options.completionTimestamp)
    const logFile = join(directory, `${dateKey}.md`)

    const timestamp = formatTimestamp(options.completionTimestamp)
    const branchInfo = options.worktreeBranch ? `\n- **Branch:** ${options.worktreeBranch}` : ''
    
    const entry = `## ${options.loopName}

- **Project:** ${options.projectDir}
- **Loop:** ${options.loopName}${branchInfo}
- **Completed:** ${timestamp}
- **Iteration:** ${options.iteration}
- **Summary:** ${options.summary}

---

`

    appendFileSync(logFile, entry, 'utf-8')
    logger?.debug(`Worktree log: appended entry to ${logFile}`)
    return true
  } catch (err) {
    logger?.error(`Worktree log: failed to append entry`, err)
    return false
  }
}

/**
 * Main entry point: logs a completed worktree loop.
 * Validates config, resolves directory, and appends the log entry.
 * Returns true on success, false on failure (fails closed).
 */
export function logWorktreeCompletion(
  config: PluginConfig,
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    sessionOutput: LoopSessionOutput | null
    iteration: number
    worktreeBranch?: string
    summary?: string
    dataDir?: string
    sandboxHostDir?: string
  },
  logger?: Logger,
): boolean {
  // Use the new context-aware resolver
  const logTarget = resolveWorktreeLogTarget(config, {
    projectDir: options.projectDir,
    dataDir: options.dataDir,
    sandboxHostDir: options.sandboxHostDir,
    sandbox: !!options.sandboxHostDir,
  }, logger)
  
  if (!logTarget) {
    // Error already logged by resolveWorktreeLogTarget if enabled but misconfigured
    if (!config.loop?.worktreeLogging?.enabled) {
      logger?.debug('Worktree logging: disabled, skipping')
    }
    return false
  }

  // Validate and initialize the host path before writing
  if (!ensureWorktreeLogDirectory(logTarget.hostPath, logger)) {
    return false
  }

  const summary = options.summary ?? (options.sessionOutput 
    ? summarizeSessionOutput(options.sessionOutput)
    : 'No session output available')

  return appendWorktreeLogEntry(
    logTarget.hostPath,
    {
      projectDir: options.projectDir,
      loopName: options.loopName,
      completionTimestamp: options.completionTimestamp,
      summary,
      iteration: options.iteration,
      worktreeBranch: options.worktreeBranch,
    },
    logger,
  )
}
