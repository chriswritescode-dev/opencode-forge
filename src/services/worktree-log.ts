import { mkdirSync, appendFileSync, existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir } from 'os'
import type { PluginConfig, Logger } from '../types'
import type { LoopUsageSummary } from '../loop/token-usage'
import { formatUsageSummary } from '../utils/loop-format'

export interface WorktreeLogContext {
  projectDir: string
  dataDir?: string
}

export interface WorktreeCompletionLogPayload {
  logDirectory: string
  projectDir: string
  loopName: string
  completionTimestamp: string
  iteration: number
  worktreeBranch?: string
  planText?: string | null
  usage?: LoopUsageSummary | null
}

export interface BuildWorktreeCompletionPayloadResult {
  payload: WorktreeCompletionLogPayload
  hostPath: string
}

export interface WorktreeLogTarget {
  hostPath: string
}

function normalizeConfiguredLogDirectory(directory: string): string {
  if (directory === '~') {
    return homedir()
  }
  
  if (directory.startsWith('~/')) {
    const relativePath = directory.slice(2)
    return join(homedir(), relativePath)
  }
  
  return directory
}

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
  
  if (!directory || directory.trim() === '') {
    if (context.dataDir) {
      directory = join(context.dataDir, 'worktree-logs')
    } else {
      logger?.error('Worktree logging: enabled but directory is not configured and no dataDir provided')
      return null
    }
  }

  try {
    const normalizedDirectory = normalizeConfiguredLogDirectory(directory)
    
    const resolvedPath = isAbsolute(normalizedDirectory)
      ? normalizedDirectory
      : join(context.projectDir, normalizedDirectory)
    
    return { hostPath: resolvedPath }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.error(`Worktree logging: failed to resolve directory "${directory}": ${errorMsg}`)
    return null
  }
}

export function ensureWorktreeLogDirectory(hostPath: string, logger?: Logger): boolean {
  try {
    if (!existsSync(hostPath)) {
      mkdirSync(hostPath, { recursive: true })
    }

    const testFile = join(hostPath, '.write-test')
    appendFileSync(testFile, '')
    return true
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger?.error(`Worktree logging: failed to validate directory "${hostPath}": ${errorMsg}`)
    return false
  }
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatWorktreeCompletionEntry(
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    iteration: number
    worktreeBranch?: string
  },
  planText: string | null,
  usage?: LoopUsageSummary | null,
): string {
  const timestamp = options.completionTimestamp.toISOString()
  const branchInfo = options.worktreeBranch ? `\n- **Branch:** ${options.worktreeBranch}` : ''
  const planSection = (planText?.trim()) || 'Plan unavailable'
  
  const usageSection = usage ? `\n### Usage\n\n${formatUsageSummary(usage).join('\n')}\n` : ''
  
  return `# ${options.projectDir}

## ${options.loopName}

- **Loop:** ${options.loopName}${branchInfo}
- **Completed:** ${timestamp}
- **Iteration:** ${options.iteration}
${usageSection}
### Plan

${planSection}

---

`
}

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
  usage?: LoopUsageSummary | null,
): boolean {
  try {
    const dateKey = formatDateKey(options.completionTimestamp)
    const logFile = join(directory, `${dateKey}.md`)

    const entry = formatWorktreeCompletionEntry(options, planText ?? null, usage)

    appendFileSync(logFile, entry, 'utf-8')
    logger?.debug(`Worktree log: appended entry to ${logFile}`)
    return true
  } catch (err) {
    logger?.error(`Worktree log: failed to append entry`, err)
    return false
  }
}

export function buildWorktreeCompletionPayload(
  config: PluginConfig,
  options: {
    projectDir: string
    loopName: string
    completionTimestamp: Date
    iteration: number
    worktreeBranch?: string
    dataDir?: string
    usage?: LoopUsageSummary | null
  },
  logger?: Logger,
): BuildWorktreeCompletionPayloadResult | null {
  const worktreeLogging = config.loop?.worktreeLogging
  if (!worktreeLogging?.enabled) {
    logger?.debug('Worktree logging: disabled, skipping')
    return null
  }

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
    usage: options.usage,
  }

  return {
    payload,
    hostPath: logTarget.hostPath,
  }
}

export function writeWorktreeCompletionLog(
  payload: WorktreeCompletionLogPayload,
  logger?: Logger,
): boolean {
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
    payload.usage,
  )
}


