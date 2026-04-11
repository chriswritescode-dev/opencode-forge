import type { LoopState } from '../../services/loop'
import { buildCompletionSignalInstructions, LOOP_PERMISSION_RULESET } from '../../services/loop'
import { openDatabase, confirm } from '../utils'
import { findPartialMatch } from '../../utils/partial-match'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

export interface RestartArgs {
  dbPath?: string
  resolvedProjectId?: string
  name?: string
  force?: boolean
  server?: string
}

function createStatusClient(serverUrl: string, directory: string) {
  const url = new URL(serverUrl)
  const password = url.password || process.env['OPENCODE_SERVER_PASSWORD']
  const cleanUrl = new URL(url.toString())
  cleanUrl.username = ''
  cleanUrl.password = ''
  const clientConfig: Parameters<typeof createOpencodeClient>[0] = { baseUrl: cleanUrl.toString(), directory }
  if (password) {
    clientConfig.headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    }
  }
  return createOpencodeClient(clientConfig)
}

export async function run(argv: RestartArgs): Promise<void> {
  const db = openDatabase(argv.dbPath)

  try {
    const projectId = argv.resolvedProjectId

    const now = Date.now()
    let query: string
    let params: (string | number)[]

    if (projectId) {
      query = 'SELECT project_id, key, data FROM project_kv WHERE project_id = ? AND key LIKE ? AND expires_at > ?'
      params = [projectId, 'loop:%', now]
    } else {
      query = 'SELECT project_id, key, data FROM project_kv WHERE key LIKE ? AND expires_at > ?'
      params = ['loop:%', now]
    }

    let rows: Array<{ project_id: string; key: string; data: string }>
    try {
      rows = db.prepare(query).all(...params) as Array<{ project_id: string; key: string; data: string }>
    } catch {
      rows = []
    }

    if (rows.length === 0) {
      console.log('')
      console.log('No loops.')
      console.log('')
      return
    }

    const loops: Array<{ state: LoopState; row: { project_id: string; key: string; data: string } }> = []

    for (const row of rows) {
      try {
        const state = JSON.parse(row.data) as LoopState
        loops.push({ state, row })
      } catch (err) {
        console.error(`Failed to parse loop state for key ${row.key}:`, err)
      }
    }

    if (loops.length === 0) {
      console.log('')
      console.log('No loops.')
      console.log('')
      return
    }

    let loopToRestart: { state: LoopState; row: { project_id: string; key: string; data: string } } | undefined

    if (argv.name) {
      const { match, candidates } = findPartialMatch(argv.name, loops, (l) => [
        l.state.worktreeName,
        l.state.worktreeBranch,
      ])

      if (!match && candidates.length > 0) {
        console.error(`Multiple loops match '${argv.name}':`)
        for (const c of candidates) {
          console.error(`  - ${c.state.worktreeName}`)
        }
        console.error('')
        process.exit(1)
      }

      if (!match && candidates.length === 0) {
        console.error(`Loop not found: ${argv.name}`)
        console.error('')
        console.error('Available loops:')
        for (const l of loops) {
          console.error(`  - ${l.state.worktreeName}`)
        }
        console.error('')
        process.exit(1)
      }

      loopToRestart = match!
    } else {
      const restartableLoops = loops.filter((l) => l.state.active || (l.state.terminationReason && l.state.terminationReason !== 'completed'))
      if (restartableLoops.length === 0) {
        console.log('')
        console.log('No restartable loops found.')
        console.log('')
        return
      }
      if (restartableLoops.length === 1) {
        loopToRestart = restartableLoops[0]
      } else {
        console.log('')
        console.log('Multiple restartable loops. Please specify which one to restart:')
        console.log('')
        for (const l of restartableLoops) {
          console.log(`  - ${l.state.worktreeName}`)
        }
        console.log('')
        console.log("Run 'oc-forge loop restart <name>' to restart a specific loop.")
        console.log('')
        process.exit(1)
      }
    }

    if (!loopToRestart) {
      console.error('Internal error: loop not found')
      process.exit(1)
    }

    const { state, row } = loopToRestart

    if (state.terminationReason === 'completed') {
      console.log('')
      console.log(`Loop "${state.worktreeName}" completed successfully and cannot be restarted.`)
      console.log('')
      process.exit(1)
    }

    if (!state.worktreeDir) {
      console.log('')
      console.log(`Cannot restart "${state.worktreeName}": worktree directory is missing.`)
      console.log('')
      process.exit(1)
    }

    if (state.worktree && state.worktreeDir) {
      const { existsSync } = await import('fs')
      if (!existsSync(state.worktreeDir)) {
        console.log('')
        console.log(`Cannot restart "${state.worktreeName}": worktree directory no longer exists at ${state.worktreeDir}.`)
        console.log('')
        process.exit(1)
      }
    }

    if (state.active && !argv.force) {
      console.log('')
      console.log(`Loop to Force Restart:`)
      console.log(`  Worktree:  ${state.worktreeName}`)
      console.log(`  Session:   ${state.sessionId}`)
      console.log(`  Iteration: ${state.iteration}/${state.maxIterations}`)
      console.log(`  Phase:     ${state.phase}`)
      console.log('')

      const shouldProceed = await confirm(`Force restart active loop '${state.worktreeName}'`)

      if (!shouldProceed) {
        console.log('Cancelled.')
        return
      }
    }

    const serverUrl = argv.server ?? 'http://localhost:5551'
    const directory = state.worktreeDir

    const client = createStatusClient(serverUrl, directory)

    if (state.active) {
      try {
        await client.session.abort({ sessionID: state.sessionId })
        console.log(`Aborted old session: ${state.sessionId}`)
      } catch {
        console.log(`Warning: could not abort old session ${state.sessionId}`)
      }
    }

    const createResult = await client.session.create({
      title: state.worktreeName,
      directory,
      permission: LOOP_PERMISSION_RULESET,
    })

    if (createResult.error || !createResult.data) {
      console.error(`Failed to create new session: ${createResult.error}`)
      process.exit(1)
    }

    const newSessionId = createResult.data.id

    const sessionKey = `loop-session:${newSessionId}`
    db.prepare('INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      row.project_id,
      sessionKey,
      JSON.stringify(state.worktreeName),
      now + 30 * 24 * 60 * 60 * 1000,
      now,
    )

    const newState: LoopState = {
      ...state,
      active: true,
      sessionId: newSessionId,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      terminationReason: undefined,
    }
    db.prepare('UPDATE project_kv SET data = ?, updated_at = ? WHERE project_id = ? AND key = ?').run(
      JSON.stringify(newState),
      now,
      row.project_id,
      row.key,
    )

    let promptText = state.prompt ?? ''
    if (state.completionSignal) {
      promptText += buildCompletionSignalInstructions(state.completionSignal)
    }

    try {
      await client.session.promptAsync({
        sessionID: newSessionId,
        directory,
        parts: [{ type: 'text', text: promptText }],
        agent: 'code',
      })
    } catch (err) {
      console.error(`Failed to send prompt: ${err}`)
      process.exit(1)
    }

    console.log('')
    console.log(`Restarted loop "${state.worktreeName}"`)
    console.log('')
    console.log(`New session: ${newSessionId}`)
    console.log(`Continuing from iteration: ${state.iteration}`)
    console.log(`Previous termination: ${state.terminationReason ?? 'unknown'}`)
    console.log(`Directory: ${state.worktreeDir}`)
    console.log(`Audit: ${state.audit ? 'enabled' : 'disabled'}`)
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
  name                  Worktree name to restart (optional if only one active)

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
