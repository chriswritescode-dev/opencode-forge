import { spawnSync } from 'child_process'
import {
  openDatabase,
  confirm,
  resolveLoopByNameOrExit,
  printBlock,
  getCliV2Client,
} from '../utils'
import { createLoopsRepo } from '../../storage/repos/loops-repo'
import { teardownWorktreeArtifacts, cleanupLoopWorktree } from '../../utils/worktree-cleanup'
import { listLoopStatesFromDb } from '../../storage/cli-helpers'

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
    const loops = listLoopStatesFromDb(db, argv.resolvedProjectId, { activeOnly: true })

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
    } else if (state.worktree && state.worktreeDir) {
      console.log(`  Worktree:  ${state.worktreeDir} (will be preserved, use --cleanup to remove)`)
    }
    console.log('')

    const shouldProceed = argv.force || await confirm(`Cancel loop '${state.loopName}'`)

    if (!shouldProceed) {
      console.log('Cancelled.')
      return
    }

    const now = Date.now()
    createLoopsRepo(db).terminate(loopToCancel.row.project_id, loopToCancel.row.loop_name, {
      status: 'cancelled',
      reason: 'cancelled',
      completedAt: now,
    })

    console.log(`Cancelled loop: ${state.loopName}`)

    if (state.worktree && state.worktreeDir) {
      const v2 = await getCliV2Client(state.worktreeDir)
      if (!v2) {
        console.log('')
        console.log('Warning: Could not connect to OpenCode server. Skipping session/workspace cleanup.')
        if (argv.cleanup) {
          console.log('Removing worktree directory as requested...')
          // Only do git commit and worktree removal when server is unreachable
          if (state.worktreeDir) {
            try {
              // Commit changes first
              const addResult = spawnSync('git', ['add', '-A'], { cwd: state.worktreeDir, encoding: 'utf-8' })
              if (addResult.status === 0) {
                const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: state.worktreeDir, encoding: 'utf-8' })
                if (statusResult.status === 0) {
                  const status = statusResult.stdout.trim()
                  if (status) {
                    const message = `loop: ${state.loopName} cancelled after ${state.iteration} iteration${state.iteration === 1 ? '' : 's'}`
                    const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: state.worktreeDir, encoding: 'utf-8' })
                    if (commitResult.status === 0) {
                      console.log(`  Changes committed: true`)
                    }
                  }
                }
              }
            } catch (err) {
              console.log(`  Note: Could not commit changes: ${err instanceof Error ? err.message : String(err)}`)
            }
            // Remove worktree
            const cleanupResult = await cleanupLoopWorktree({
              worktreeDir: state.worktreeDir,
              logPrefix: 'oc-forge loop cancel',
              logger: console,
            })
            console.log(`  Worktree removed: ${cleanupResult.removed}`)
            if (cleanupResult.error) {
              console.log(`  Error: ${cleanupResult.error}`)
            }
          }
        } else {
          console.log('The worktree will be preserved. Use --cleanup to remove it.')
        }
        console.log('')
      } else {
        const teardown = await teardownWorktreeArtifacts({
          v2,
          loopName: state.loopName,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          worktreeDir: state.worktreeDir,
          projectDir: state.projectDir,
          worktree: true,
          doCommit: true,
          doRemoveWorktree: argv.cleanup ?? false,
          reasonLabel: 'cancelled',
          worktreeBranch: state.worktreeBranch,
          iteration: state.iteration,
          logPrefix: 'oc-forge loop cancel',
          logger: console,
        })
        console.log(`  Session deleted: ${teardown.sessionDeleted}`)
        console.log(`  Workspace deleted: ${teardown.workspaceDeleted}`)
        console.log(`  Worktree removed: ${teardown.worktreeRemoved}`)
        if (teardown.committed) {
          console.log(`  Changes committed: true`)
        }
        if (teardown.errors.length > 0) {
          console.log(`  Errors: ${teardown.errors.join(', ')}`)
        }
        console.log('')
      }
    } else if (argv.cleanup && state.worktreeDir && !state.worktree) {
      console.log('')
      console.log('Note: --cleanup specified but loop is not a worktree loop.')
      console.log('')
    }
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
