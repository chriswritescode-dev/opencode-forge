import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, basename } from 'path'
import { createInterface } from 'readline'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { openForgeDatabase } from '../storage/database'
import type { LoopState } from '../services/loop'
import { findPartialMatch } from '../utils/partial-match'
import { listLoopsFromDb as listLoopsFromDbNew } from '../storage/cli-helpers'
import { getGitProjectId as sharedGetGitProjectId } from '../utils/project-id'

function resolveDefaultDbPath(): string {
  const localForgePath = join(process.cwd(), '.opencode', 'state', 'opencode', 'forge', 'graph.db')
  if (existsSync(localForgePath)) {
    return localForgePath
  }

  const localPath = join(process.cwd(), '.opencode', 'state', 'opencode', 'graph', 'graph.db')
  if (existsSync(localPath)) {
    return localPath
  }

  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  const forgeDir = join(xdgDataHome, 'opencode', 'forge')
  if (existsSync(join(forgeDir, 'graph.db'))) {
    return join(forgeDir, 'graph.db')
  }
  const dataDir = join(xdgDataHome, 'opencode', 'graph')
  return join(dataDir, 'graph.db')
}

export function getGitProjectId(dir?: string): string | null {
  return sharedGetGitProjectId(dir)
}



export function openDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath || resolveDefaultDbPath()

  if (!existsSync(resolvedPath)) {
    console.error(`Database not found at ${resolvedPath}. Run OpenCode first to initialize OpenCode Forge.`)
    process.exit(1)
  }

  return openForgeDatabase(resolvedPath)
}



export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(`${message} (y/n): `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}


/**
 * Opens the opencode.db readonly and passes it to `fn`. Handles all lifecycle
 * (path resolution, existsSync check, read-only open, try/finally close).
 *
 * Returns `null` if opencode.db is missing or any error occurs.
 */
export function withOpencodeProjectDb<T>(fn: (db: Database) => T): T | null {
  try {
    const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
    const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
    const opencodePath = join(xdgDataHome, 'opencode', 'opencode.db')

    if (!existsSync(opencodePath)) return null

    const db = new Database(opencodePath, { readonly: true })

    try {
      return fn(db)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export function resolveProjectNames(): Map<string, string> {
  const result = withOpencodeProjectDb((db) => {
    const nameMap = new Map<string, string>()
    const rows = db.prepare('SELECT id, worktree FROM project').all() as Array<{ id: string; worktree: string }>
    for (const row of rows) {
      nameMap.set(row.id, basename(row.worktree))
    }
    return nameMap
  })
  return result ?? new Map()
}

export function resolveProjectIdByName(name: string): string | null {
  return withOpencodeProjectDb((db) => {
    const rows = db.prepare('SELECT id, worktree FROM project').all() as Array<{ id: string; worktree: string }>
    for (const row of rows) {
      if (basename(row.worktree) === name) return row.id
    }
    return null
  }) ?? null
}

interface GlobalOptions {
  dbPath?: string
  projectId?: string
  dir?: string
  help?: boolean
}

interface ParsedGlobalOptions {
  globalOpts: GlobalOptions
  remainingArgs: string[]
}

export function parseGlobalOptions(args: string[]): ParsedGlobalOptions {
  const globalOpts: GlobalOptions = {}
  const remainingArgs: string[] = []

  let i = 0
  while (i < args.length) {
    const arg = args[i]

    if (arg === '--db-path') {
      globalOpts.dbPath = args[++i]
    } else if (arg === '--project' || arg === '-p') {
      globalOpts.projectId = args[++i]
    } else if (arg === '--dir' || arg === '-d') {
      globalOpts.dir = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      globalOpts.help = true
    } else {
      remainingArgs.push(arg)
    }

    i++
  }

  return { globalOpts, remainingArgs }
}

/**
 * Builds an OpencodeClient from a server URL, extracting embedded Basic Auth
 * credentials (or falling back to `OPENCODE_SERVER_PASSWORD` env var).
 */
export function createOpencodeClientFromServer(serverUrl: string, directory: string): OpencodeClient {
  const url = new URL(serverUrl)
  const password = url.password || process.env['OPENCODE_SERVER_PASSWORD']
  const cleanUrl = new URL(url.toString())
  cleanUrl.username = ''
  cleanUrl.password = ''
  const clientConfig: Parameters<typeof createOpencodeClient>[0] = {
    baseUrl: cleanUrl.toString(),
    directory,
  }
  if (password) {
    clientConfig.headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    }
  }
  return createOpencodeClient(clientConfig)
}

export interface LoopEntry {
  state: LoopState
  row: { project_id: string; loop_name: string }
}

/**
 * Reads all loops from the new loops table, optionally scoped to a projectId.
 * Converts LoopRow to legacy LoopState for backward compatibility with CLI commands.
 *
 * Rows that fail to convert are skipped. If `activeOnly` is true, only running loops are returned.
 */
export function listLoopsFromDb(
  db: Database,
  projectId: string | undefined,
  options?: { activeOnly?: boolean },
): LoopEntry[] {
  const entries = listLoopsFromDbNew(db, projectId, {
    statuses: options?.activeOnly ? ['running'] : undefined,
    activeOnly: options?.activeOnly,
  })
  
  return entries.map((entry) => ({
    state: loopRowToState(entry.row, entry.large),
    row: { project_id: entry.row.projectId, loop_name: entry.row.loopName },
  }))
}

/**
 * Converts a LoopRow to the legacy LoopState format for CLI/TUI compatibility.
 */
function loopRowToState(row: ReturnType<typeof listLoopsFromDbNew>[number]['row'], large: ReturnType<typeof listLoopsFromDbNew>[number]['large']): LoopState {
  return {
    active: row.status === 'running',
    sessionId: row.currentSessionId,
    loopName: row.loopName,
    worktreeDir: row.worktreeDir,
    projectDir: row.projectDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    startedAt: new Date(row.startedAt).toISOString(),
    prompt: large?.prompt ?? undefined,
    phase: row.phase,
    audit: row.audit,
    lastAuditResult: large?.lastAuditResult ?? undefined,
    errorCount: row.errorCount,
    auditCount: row.auditCount,
    terminationReason: row.terminationReason ?? undefined,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    worktree: row.worktree,
    modelFailed: row.modelFailed,
    sandbox: row.sandbox,
    sandboxContainer: row.sandboxContainer ?? undefined,
    completionSummary: row.completionSummary ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
  }
}

/**
 * Resolves a partial loop name against a list of loops. On ambiguity or no
 * match, prints a message to stderr listing all available loops and exits
 * with code 1.
 */
export function resolveLoopByNameOrExit<T extends { state: LoopState }>(
  name: string,
  loops: T[],
): T {
  const { match, candidates } = findPartialMatch(name, loops, (l) => [
    l.state.loopName,
    l.state.worktreeBranch,
  ])

  if (!match && candidates.length > 0) {
    console.error(`Multiple loops match '${name}':`)
    for (const c of candidates) {
      console.error(`  - ${c.state.loopName}`)
    }
    console.error('')
    process.exit(1)
  }

  if (!match) {
    console.error(`Loop not found: ${name}`)
    console.error('')
    console.error('Available loops:')
    for (const l of loops) {
      console.error(`  - ${l.state.loopName}`)
    }
    console.error('')
    process.exit(1)
  }

  return match
}

/**
 * Prints a message surrounded by blank lines. Matches the existing
 * `console.log('')/log(msg)/log('')` boilerplate across CLI commands.
 */
export function printBlock(message: string): void {
  console.log('')
  console.log(message)
  console.log('')
}

/**
 * Formats a millisecond duration as `<h>h <m>m` (no seconds) or
 * `<h>h <m>m <s>s` when `includeSeconds` is true.
 */
export function formatDuration(ms: number, opts?: { includeSeconds?: boolean }): string {
  const hours = Math.floor(ms / (1000 * 60 * 60))
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
  if (!opts?.includeSeconds) {
    return `${hours}h ${minutes}m`
  }
  const seconds = Math.floor((ms % (1000 * 60)) / 1000)
  return `${hours}h ${minutes}m ${seconds}s`
}
