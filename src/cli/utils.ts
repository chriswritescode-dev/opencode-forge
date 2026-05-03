import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, basename } from 'path'
import { createInterface } from 'readline'
import { createOpencodeClientFromServer as createClientFromServer } from '../utils/opencode-client'
import { openForgeDatabase } from '../storage/database'
import type { LoopState } from '../services/loop'
import { findPartialMatch } from '../utils/partial-match'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

function resolveDefaultDbPath(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  const dataDir = join(xdgDataHome, 'opencode', 'forge')
  return join(dataDir, 'forge.db')
}

export function openDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath || resolveDefaultDbPath()

  if (!existsSync(resolvedPath)) {
    console.error(`Database not found at ${resolvedPath}. Run OpenCode first to initialize OpenCode Forge.`)
    process.exit(1)
  }

  return openForgeDatabase(resolvedPath)
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
function withOpencodeProjectDb<T>(fn: (db: Database) => T): T | null {
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
 * Builds an OpencodeClient from a server URL.
 */
export function createOpencodeClientFromServer(serverUrl: string, directory: string): OpencodeClient {
  return createClientFromServer({ serverUrl, directory })
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
