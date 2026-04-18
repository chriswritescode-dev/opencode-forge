import type { LoopState } from '../../services/loop'
import {
  openDatabase,
  createOpencodeClientFromServer,
  listLoopsFromDb,
  resolveLoopByNameOrExit,
  formatDuration,
  printBlock,
  type LoopEntry,
} from '../utils'
import { formatSessionOutput, formatAuditResult } from '../../utils/loop-format'
import { fetchSessionOutput } from '../../services/loop'
import { filterByPartial } from '../../utils/partial-match'

interface StatusArgs {
  dbPath?: string
  resolvedProjectId?: string
  name?: string
  server?: string
  listWorktrees?: boolean
  listWorktreesFilter?: string
  limit?: number
}

function isValidActiveState(state: LoopState): boolean {
  return (
    state.active &&
    !!state.sessionId &&
    !!state.loopName &&
    state.iteration != null &&
    state.maxIterations != null &&
    !!state.phase &&
    !!state.startedAt
  )
}

async function tryFetchSessionOutput(serverUrl: string, sessionId: string, directory: string) {
  try {
    const client = createOpencodeClientFromServer(serverUrl, directory)
    return await fetchSessionOutput(client, sessionId, directory)
  } catch {
    return null
  }
}

async function tryFetchSessionStatus(serverUrl: string, sessionId: string, directory: string): Promise<string> {
  try {
    const client = createOpencodeClientFromServer(serverUrl, directory)
    const statusResult = await client.session.status({ directory })
    const statuses = (statusResult.data ?? {}) as Record<string, { type: string; attempt?: number; message?: string; next?: number }>
    const status = statuses[sessionId]
    if (!status) return 'unknown'
    if (status.type === 'retry') {
      return `retry (attempt ${status.attempt}, next in ${Math.round(((status.next ?? 0) - Date.now()) / 1000)}s)`
    }
    return status.type
  } catch {
    return 'unavailable'
  }
}

function printActiveLoopDetails(
  loop: LoopEntry,
  serverUrl: string,
): Promise<void> {
  const state = loop.state
  const startedAt = state.startedAt
  const durationMs = Date.now() - new Date(startedAt).getTime()

  console.log('')
  console.log(`Loop: ${state.loopName}`)
  console.log(`  Session ID:      ${state.sessionId}`)
  console.log(`  Loop Name:       ${state.loopName}`)
  if (state.worktreeBranch) {
    console.log(`  Branch:          ${state.worktreeBranch}`)
  }
  console.log(`  Worktree Dir:    ${state.worktreeDir}`)
  if (!state.worktree) {
    console.log(`  Mode:            in-place`)
  }
  console.log(`  Phase:           ${state.phase}`)
  console.log(`  Iteration:       ${state.iteration}/${state.maxIterations}`)
  console.log(`  Duration:        ${formatDuration(durationMs, { includeSeconds: true })}`)
  console.log(`  Audit:           ${state.audit ? 'Yes' : 'No'}`)
  console.log(`  Error Count:     ${state.errorCount ?? 0}`)
  console.log(`  Audit Count:     ${state.auditCount ?? 0}`)
  console.log(`  Started:         ${new Date(startedAt).toISOString()}`)

  return (async () => {
    const sessionStatus = await tryFetchSessionStatus(serverUrl, state.sessionId, state.worktreeDir)
    console.log(`  Status:          ${sessionStatus}`)
    if (state.lastAuditResult) {
      for (const line of formatAuditResult(state.lastAuditResult)) {
        console.log(line)
      }
    }

    const sessionOutput = await tryFetchSessionOutput(serverUrl, state.sessionId, state.worktreeDir)
    if (sessionOutput) {
      console.log('Session Output:')
      for (const line of formatSessionOutput(sessionOutput)) {
        console.log(line)
      }
      console.log('')
    }
  })()
}

async function printCompletedLoopDetails(
  loop: LoopEntry,
  serverUrl: string,
): Promise<void> {
  const state = loop.state
  const completedAt = state.completedAt!
  const startedAt = state.startedAt
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

  console.log('')
  console.log(`Loop (Completed): ${state.loopName}`)
  console.log(`  Session ID:      ${state.sessionId}`)
  console.log(`  Loop Name:       ${state.loopName}`)
  if (state.worktreeBranch) {
    console.log(`  Branch:          ${state.worktreeBranch}`)
  }
  console.log(`  Worktree Dir:    ${state.worktreeDir}`)
  if (!state.worktree) {
    console.log(`  Mode:            in-place (completed)`)
  }
  console.log(`  Iteration:       ${state.iteration}/${state.maxIterations}`)
  console.log(`  Duration:        ${formatDuration(durationMs, { includeSeconds: true })}`)
  console.log(`  Reason:          ${state.terminationReason ?? 'unknown'}`)
  console.log(`  Started:         ${new Date(startedAt).toISOString()}`)
  console.log(`  Completed:       ${new Date(completedAt).toISOString()}`)

  if (state.lastAuditResult) {
    for (const line of formatAuditResult(state.lastAuditResult)) {
      console.log(line)
    }
  }

  const sessionOutput = await tryFetchSessionOutput(serverUrl, state.sessionId, state.worktreeDir)
  if (sessionOutput) {
    console.log('Session Output:')
    for (const line of formatSessionOutput(sessionOutput)) {
      console.log(line)
    }
    console.log('')
  }
}

export async function run(argv: StatusArgs): Promise<void> {
  const db = openDatabase(argv.dbPath)
  const serverUrl = argv.server ?? 'http://localhost:5551'

  try {
    if (argv.listWorktrees) {
      const rows = db.prepare('SELECT loop_name, worktree_branch FROM loops WHERE project_id = ?').all(argv.resolvedProjectId ?? '') as Array<{ loop_name: string; worktree_branch: string | null }>
      const names = rows.map(r => r.loop_name)
      const filtered = filterByPartial(argv.listWorktreesFilter, names, (n) => [n])
      for (const name of filtered) {
        console.log(name)
      }
      return
    }

    const loops = listLoopsFromDb(db, argv.resolvedProjectId)
    const activeLoops = loops.filter((l) => isValidActiveState(l.state))
    const recentLoops = loops.filter((l) => !l.state.active && l.state.completedAt)

    if (argv.name) {
      const candidates = [...activeLoops, ...recentLoops]
      const matched = resolveLoopByNameOrExit(argv.name, candidates)
      if (matched.state.active) {
        await printActiveLoopDetails(matched, serverUrl)
      } else {
        await printCompletedLoopDetails(matched, serverUrl)
      }
      return
    }

    if (activeLoops.length > 0) {
      console.log('')
      console.log('Active Loops:')
      console.log('')

      for (const loop of activeLoops) {
        const durationMs = Date.now() - new Date(loop.state.startedAt).getTime()
        const iterStr = `${loop.state.iteration}/${loop.state.maxIterations}`
        const audit = loop.state.audit ? 'Yes' : 'No'

        console.log(`  ${loop.state.loopName}`)
        console.log(`    Phase: ${loop.state.phase}  Iteration: ${iterStr}  Duration: ${formatDuration(durationMs)}  Audit: ${audit}`)
        console.log('')
      }

      console.log(`Total: ${activeLoops.length} active loop(s)`)
      console.log('')
    }

    if (recentLoops.length > 0) {
      console.log('Recently Completed:')
      console.log('')

      const limit = argv.limit ?? 10
      const displayedLoops = recentLoops.slice(0, limit)
      for (const loop of displayedLoops) {
        const reason = loop.state.terminationReason ?? 'unknown'
        const completed = new Date(loop.state.completedAt!).toLocaleString()

        console.log(`  ${loop.state.loopName}`)
        console.log(`    Iterations: ${loop.state.iteration}  Reason: ${reason}  Completed: ${completed}`)
        console.log('')
      }

      if (recentLoops.length > limit) {
        console.log(`  ... and ${recentLoops.length - limit} more. Use 'oc-forge loop status <name>' for details.`)
        console.log('')
      }
    }

    if (activeLoops.length === 0 && recentLoops.length === 0) {
      printBlock('No loops found.')
    } else {
      console.log("Run 'oc-forge loop status <name>' for detailed information.")
      console.log('')
    }
  } finally {
    db.close()
  }
}

export function help(): void {
  console.log(`
Show loop status

Usage:
  oc-forge loop status [options]
  oc-forge loop status <name> [options]

Arguments:
  name                    Worktree name for detailed status (optional, supports partial matching)

Options:
  --server <url>          OpenCode server URL (default: http://localhost:5551)
  --list-worktrees        List all worktree names (for shell completion)
                          Optionally provide a filter: --list-worktrees <filter>
  --limit <n>             Limit recent loops shown (default: 10)
  --project, -p <id>      Project ID (auto-detected from git if not provided)
  --db-path <path>        Path to forge database
  --help, -h              Show this help message
  `.trim())
}

export async function cli(args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string; dir?: string }): Promise<void> {
  const argv: StatusArgs = {
    dbPath: globalOpts.dbPath,
    resolvedProjectId: globalOpts.resolvedProjectId,
    server: 'http://localhost:5551',
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--server') {
      argv.server = args[++i]
    } else if (arg === '--list-worktrees') {
      argv.listWorktrees = true
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        argv.listWorktreesFilter = args[++i]
      }
    } else if (arg === '--limit') {
      argv.limit = parseInt(args[++i], 10)
    } else if (arg === '--help' || arg === '-h') {
      help()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      argv.name = arg
    } else {
      console.error(`Unknown option: ${arg}`)
      help()
      process.exit(1)
    }
    i++
  }

  await run(argv)
}
