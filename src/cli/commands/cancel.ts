import {
  openDatabase,
  confirm,
  listLoopsFromDb,
  resolveLoopByNameOrExit,
  printBlock,
} from '../utils'
import { execSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

interface CancelArgs {
  dbPath?: string
  resolvedProjectId?: string
  name?: string
  cleanup?: boolean
  force?: boolean
}

export async function run(argv: CancelArgs): Promise<void> {
  const db = openDatabase(argv.dbPath)

  try {
    const loops = listLoopsFromDb(db, argv.resolvedProjectId, { activeOnly: true })

    if (loops.length === 0) {
      printBlock('No active loops.')
      return
    }

    let loopToCancel = argv.name
      ? resolveLoopByNameOrExit(argv.name, loops)
      : undefined

    if (!loopToCancel) {
      if (loops.length === 1) {
        loopToCancel = loops[0]
      } else {
        console.log('')
        console.log('Multiple active loops. Please specify which one to cancel:')
        console.log('')
        for (const l of loops) {
          console.log(`  - ${l.state.loopName}`)
        }
        console.log('')
        console.log("Run 'oc-forge loop cancel <name>' to cancel a specific loop.")
        console.log('')
        process.exit(1)
      }
    }

    const { state } = loopToCancel

    console.log('')
    console.log(`Loop to Cancel:`)
    console.log(`  Loop:     ${state.loopName}`)
    console.log(`  Session:   ${state.sessionId}`)
    console.log(`  Iteration: ${state.iteration}/${state.maxIterations}`)
    console.log(`  Phase:     ${state.phase}`)
    if (argv.cleanup) {
      console.log(`  Worktree:  ${state.worktreeDir} (will be removed)`)
    }
    console.log('')

    const shouldProceed = argv.force || await confirm(`Cancel loop '${state.loopName}'`)

    if (!shouldProceed) {
      console.log('Cancelled.')
      return
    }

    const updatedState = {
      ...state,
      active: false,
      completedAt: new Date().toISOString(),
      terminationReason: 'cancelled',
    }
    const now = Date.now()
    
    // Update the loop in the new loops table
    db.prepare(`
      UPDATE loops SET
        status = ?,
        completed_at = ?,
        termination_reason = ?,
        completion_summary = ?
      WHERE project_id = ? AND loop_name = ?
    `).run(
      'cancelled',
      now,
      updatedState.terminationReason,
      null,
      loopToCancel.row.project_id,
      loopToCancel.row.loop_name,
    )

    console.log(`Cancelled loop: ${state.loopName}`)

    if (argv.cleanup && state.worktreeDir && state.worktree) {
      if (existsSync(state.worktreeDir)) {
        try {
          const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: state.worktreeDir, encoding: 'utf-8' }).trim()
          const gitRoot = resolve(state.worktreeDir, gitCommonDir, '..')
          const removeResult = spawnSync('git', ['worktree', 'remove', '-f', state.worktreeDir], { cwd: gitRoot, encoding: 'utf-8' })
          if (removeResult.status !== 0) {
            throw new Error(removeResult.stderr || 'git worktree remove failed')
          }
          console.log(`Removed worktree: ${state.worktreeDir}`)
        } catch {
          console.error(`Failed to remove worktree: ${state.worktreeDir}`)
          console.error('You may need to remove it manually.')
        }
      }
    }

    console.log('')
  } finally {
    db.close()
  }
}

export function help(): void {
  console.log(`
Cancel a loop

Usage:
  oc-forge loop cancel [name] [options]

Arguments:
  name                  Worktree name to cancel (optional if only one active)

Options:
  --cleanup             Remove worktree directory after cancellation
  --force               Skip confirmation prompt
  --project, -p <id>    Project ID (auto-detected from git if not provided)
  --db-path <path>      Path to forge database
  --help, -h            Show this help message
  `.trim())
}

export async function cli(args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string; dir?: string }): Promise<void> {
  const argv: CancelArgs = {
    dbPath: globalOpts.dbPath,
    resolvedProjectId: globalOpts.resolvedProjectId,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--cleanup') {
      argv.cleanup = true
    } else if (arg === '--force') {
      argv.force = true
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
