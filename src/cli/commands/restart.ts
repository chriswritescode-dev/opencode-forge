import type { LoopState } from '../../services/loop'
import { buildLoopPermissionRuleset } from '../../constants/loop'
import {
  openDatabase,
  confirm,
  createOpencodeClientFromServer,
  resolveLoopByNameOrExit,
  printBlock,
} from '../utils'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../../storage'
import { listLoopStatesFromDb } from '../../storage/cli-helpers'
import { createLoopSessionWithWorkspace } from '../../utils/loop-session'
import { formatLoopSessionTitle } from '../../utils/session-titles'

interface RestartArgs {
  dbPath?: string
  resolvedProjectId?: string
  name?: string
  force?: boolean
  server?: string
}

export async function run(argv: RestartArgs): Promise<void> {
  const db = openDatabase(argv.dbPath)

  try {
    const loops = listLoopStatesFromDb(db, argv.resolvedProjectId)

    if (loops.length === 0) {
      printBlock('No loops.')
      return
    }

    let loopToRestart = argv.name
      ? resolveLoopByNameOrExit(argv.name, loops)
      : undefined

    if (!loopToRestart) {
      const restartableLoops = loops.filter((l) => l.state.active || (l.state.terminationReason && l.state.terminationReason !== 'completed'))
      if (restartableLoops.length === 0) {
        printBlock('No restartable loops found.')
        return
      }
      if (restartableLoops.length === 1) {
        loopToRestart = restartableLoops[0]
      } else {
        console.log('')
        console.log('Multiple restartable loops. Please specify which one to restart:')
        console.log('')
        for (const l of restartableLoops) {
          console.log(`  - ${l.state.loopName}`)
        }
        console.log('')
        console.log("Run 'oc-forge loop restart <name>' to restart a specific loop.")
        console.log('')
        process.exit(1)
      }
    }

    const { state, row } = loopToRestart

    if (state.terminationReason === 'completed') {
      printBlock(`Loop "${state.loopName}" completed successfully and cannot be restarted.`)
      process.exit(1)
    }

    if (!state.worktreeDir) {
      printBlock(`Cannot restart "${state.loopName}": worktree directory is missing.`)
      process.exit(1)
    }

    if (state.worktree && state.worktreeDir) {
      if (!existsSync(state.worktreeDir)) {
        printBlock(`Cannot restart "${state.loopName}": worktree directory no longer exists at ${state.worktreeDir}.`)
        process.exit(1)
      }
    }

    if (state.active && !argv.force) {
      console.log('')
      console.log(`Loop to Force Restart:`)
      console.log(`  Loop:     ${state.loopName}`)
      console.log(`  Session:   ${state.sessionId}`)
      console.log(`  Iteration: ${state.iteration}/${state.maxIterations}`)
      console.log(`  Phase:     ${state.phase}`)
      console.log('')

      const shouldProceed = await confirm(`Force restart active loop '${state.loopName}'`)

      if (!shouldProceed) {
        console.log('Cancelled.')
        return
      }
    }

    const serverUrl = argv.server ?? 'http://localhost:5551'
    const sessionDir = state.worktreeDir

    const client = createOpencodeClientFromServer(serverUrl, sessionDir)

    if (state.active) {
      try {
        await client.session.abort({ sessionID: state.sessionId })
        console.log(`Aborted old session: ${state.sessionId}`)
      } catch {
        console.log(`Warning: could not abort old session ${state.sessionId}`)
      }
    }

    console.log(
      `[perm-diag] cli restart loop=${state.loopName} worktree=${String(state.worktree)} sandbox=${String(state.sandbox)}`
    )

    const permissionRuleset = buildLoopPermissionRuleset({
      isWorktree: !!state.worktree,
      isSandbox: !!state.sandbox,
    })

    console.log(`restart: creating session with directory=${sessionDir} (sandbox: ${!!state.sandbox})`)

    const createResult = await createLoopSessionWithWorkspace({
      v2: client,
      title: formatLoopSessionTitle(state.loopName),
      directory: sessionDir,
      permission: permissionRuleset,
      workspaceId: state.workspaceId,
      logPrefix: 'cli-restart',
      logger: console,
    })

    if (!createResult) {
      console.error('Failed to create new session')
      process.exit(1)
    }

    const newSessionId = createResult.sessionId

    // Update the loop in the new loops table
    const updatedState: LoopState = {
      ...state,
      active: true,
      sessionId: newSessionId,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      terminationReason: undefined,
      projectDir: state.projectDir || state.worktreeDir,
    }
    
    // Write to loops table using direct SQL (CLI doesn't have loopsRepo)
    db.run('BEGIN')
    try {
      db.prepare(`
        UPDATE loops SET
          status = ?,
          current_session_id = ?,
          phase = ?,
          iteration = ?,
          error_count = ?,
          audit_count = ?,
          started_at = ?,
          completed_at = ?,
          termination_reason = ?,
          completion_summary = ?,
          sandbox_container = ?
        WHERE project_id = ? AND loop_name = ?
      `).run(
        updatedState.active ? 'running' : 'completed',
        newSessionId,
        updatedState.phase,
        updatedState.iteration,
        updatedState.errorCount,
        updatedState.auditCount,
        new Date(updatedState.startedAt).getTime(),
        updatedState.completedAt ? new Date(updatedState.completedAt).getTime() : null,
        updatedState.terminationReason ?? null,
        updatedState.completionSummary ?? null,
        null, // Clear sandbox_container so reconciler starts fresh
        row.project_id,
        row.loop_name
      )
      
      // Update large fields
      db.prepare(`
        INSERT OR REPLACE INTO loop_large_fields (project_id, loop_name, prompt, last_audit_result)
        VALUES (?, ?, ?, ?)
      `).run(
        row.project_id,
        row.loop_name,
        updatedState.prompt ?? null,
        updatedState.lastAuditResult ?? null
      )
      
      db.run('COMMIT')
    } catch (err) {
      db.run('ROLLBACK')
      throw err
    }

    // Wait for sandbox to be ready before first prompt (only for worktree + sandbox mode)
    if (state.worktree && state.sandbox) {
      const dbPath = join(resolveDataDir(), 'graph.db')
      const dbExists = existsSync(dbPath)
      
      if (dbExists) {
        const { waitForSandboxReady } = await import('../../utils/sandbox-ready')
        const waitResult = await waitForSandboxReady({
          projectId: row.project_id,
          loopName: row.loop_name,
          dbPath,
          pollMs: 100,
          timeoutMs: 15000,
        })
        
        if (!waitResult.ready) {
          console.error(`Sandbox not ready after restart: ${waitResult.reason}`)
          process.exit(1)
        }
      }
    }

    const promptText = state.prompt ?? ''

    console.log(`restart: initial prompt sessionID=${newSessionId} dir=${sessionDir} model=(default)`)

    try {
      await client.session.promptAsync({
        sessionID: newSessionId,
        directory: sessionDir,
        parts: [{ type: 'text', text: promptText }],
        agent: 'code',
      })
    } catch (err) {
      console.error(`Failed to send prompt: ${err}`)
      process.exit(1)
    }

    console.log('')
    console.log(`Restarted loop "${state.loopName}"`)
    console.log('')
    console.log(`New session: ${newSessionId}`)
    console.log(`Continuing from iteration: ${state.iteration}`)
    console.log(`Previous termination: ${state.terminationReason ?? 'unknown'}`)
    console.log(`Directory: ${state.worktreeDir}`)
    console.log('')
  } finally {
    db.close()
  }
}

export function help(): void {
  console.log(`
Restart a loop

Usage:
  oc-forge loop restart [name] [options]

Arguments:
  name                  Loop name to restart (optional if only one active)

Options:
  --force               Force restart an active loop without confirmation
  --server <url>        OpenCode server URL (default: http://localhost:5551)
  --project, -p <id>    Project ID (auto-detected from git if not provided)
  --db-path <path>      Path to forge database
  --help, -h            Show this help message
  `.trim())
}

export async function cli(args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string; dir?: string }): Promise<void> {
  const argv: RestartArgs = {
    dbPath: globalOpts.dbPath,
    resolvedProjectId: globalOpts.resolvedProjectId,
    server: 'http://localhost:5551',
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--force') {
      argv.force = true
    } else if (arg === '--server') {
      argv.server = args[++i]
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
