#!/usr/bin/env bun
/**
 * Wipe all forge state for a single loop name across:
 *   - forge.db `loops` row
 *   - opencode.db `workspace` rows (and their `session` rows)
 *   - on-disk worktree directory
 *   - git worktree registration
 *   - git branch (forge/<loopName>)
 *   - running Docker sandbox container
 *
 * Usage:
 *   bun scripts/cleanup-loop.ts <loopName> [--project-dir=/path/to/project] [--dry-run]
 *
 * Example:
 *   bun scripts/cleanup-loop.ts category-nav-filter --project-dir=/Users/chris/development/supplying-demand/sd-mono
 *
 * Without --project-dir, the git worktree/branch cleanup is skipped (DB and disk cleanup still run).
 */

import Database from 'bun:sqlite'
import { existsSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

interface Args {
  loopName: string
  projectDir?: string
  dryRun: boolean
}

function parseArgs(): Args {
  const [, , ...rest] = process.argv
  let loopName: string | null = null
  let projectDir: string | undefined
  let dryRun = false

  for (const arg of rest) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--project-dir=')) projectDir = arg.split('=')[1]
    else if (!loopName) loopName = arg
  }

  if (!loopName) {
    console.error('Usage: bun scripts/cleanup-loop.ts <loopName> [--project-dir=/path] [--dry-run]')
    process.exit(1)
  }

  return { loopName, projectDir, dryRun }
}

function logAction(dryRun: boolean, label: string, action: () => void): void {
  if (dryRun) {
    console.log(`[dry-run] would: ${label}`)
    return
  }
  try {
    action()
    console.log(`  ✓ ${label}`)
  } catch (err) {
    console.error(`  ✗ ${label}: ${(err as Error).message}`)
  }
}

function cleanupForgeDb(loopName: string, dryRun: boolean): void {
  const path = join(homedir(), '.local/share/opencode/forge/forge.db')
  if (!existsSync(path)) {
    console.log(`forge.db not found at ${path} — skipping`)
    return
  }
  console.log(`\nforge.db (${path}):`)
  const db = new Database(path)
  try {
    const rows = db.query('SELECT project_id, loop_name, status FROM loops WHERE loop_name = ?').all(loopName) as Array<{
      project_id: string
      loop_name: string
      status: string
    }>
    if (rows.length === 0) {
      console.log(`  no loops rows for ${loopName}`)
      return
    }
    for (const row of rows) {
      logAction(dryRun, `delete loops row project=${row.project_id} status=${row.status}`, () => {
        db.run('DELETE FROM loops WHERE project_id = ? AND loop_name = ?', [row.project_id, loopName])
      })
    }
    // Also clean dependent tables
    for (const table of ['loop_large_fields', 'section_plans', 'review_findings']) {
      logAction(dryRun, `delete ${table} entries for loop=${loopName}`, () => {
        try {
          db.run(`DELETE FROM ${table} WHERE loop_name = ?`, [loopName])
        } catch {
          // some tables may not exist on older schemas
        }
      })
    }
  } finally {
    db.close()
  }
}

function cleanupOpencodeDb(loopName: string, dryRun: boolean): void {
  const path = join(homedir(), '.local/share/opencode/opencode.db')
  if (!existsSync(path)) {
    console.log(`\nopencode.db not found at ${path} — skipping`)
    return
  }
  console.log(`\nopencode.db (${path}):`)
  const db = new Database(path)
  try {
    const workspaces = db.query('SELECT id, project_id FROM workspace WHERE name = ? AND type = ?').all(loopName, 'forge') as Array<{
      id: string
      project_id: string
    }>
    if (workspaces.length === 0) {
      console.log(`  no forge workspaces named ${loopName}`)
      return
    }
    for (const ws of workspaces) {
      const sessions = db.query('SELECT id, title FROM session WHERE workspace_id = ?').all(ws.id) as Array<{
        id: string
        title: string
      }>
      for (const sess of sessions) {
        logAction(dryRun, `delete session ${sess.id} (title="${sess.title}") in workspace ${ws.id}`, () => {
          db.run('DELETE FROM session_message WHERE session_id = ?', [sess.id])
          db.run('DELETE FROM session WHERE id = ?', [sess.id])
        })
      }
      logAction(dryRun, `delete workspace ${ws.id} (project=${ws.project_id})`, () => {
        db.run('DELETE FROM workspace WHERE id = ?', [ws.id])
      })
    }
  } finally {
    db.close()
  }
}

function cleanupWorktreeDirectory(loopName: string, dryRun: boolean): void {
  const path = join(homedir(), '.local/share/opencode/forge/worktrees', loopName)
  if (!existsSync(path)) {
    console.log(`\nworktree directory ${path} — already gone`)
    return
  }
  console.log(`\nworktree directory:`)
  logAction(dryRun, `rm -rf ${path}`, () => {
    rmSync(path, { recursive: true, force: true })
  })
}

function cleanupGitWorktree(loopName: string, projectDir: string | undefined, dryRun: boolean): void {
  if (!projectDir) {
    console.log(`\ngit cleanup skipped — pass --project-dir=/path/to/project to enable`)
    return
  }
  if (!existsSync(projectDir)) {
    console.log(`\nproject dir ${projectDir} not found — skipping git cleanup`)
    return
  }
  console.log(`\ngit (${projectDir}):`)
  const branch = `forge/${loopName}`

  logAction(dryRun, `git worktree prune`, () => {
    const r = spawnSync('git', ['worktree', 'prune'], { cwd: projectDir, encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(r.stderr || 'unknown error')
  })

  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir, encoding: 'utf-8' })
  const worktreePath = join(homedir(), '.local/share/opencode/forge/worktrees', loopName)
  if (list.stdout.includes(worktreePath)) {
    logAction(dryRun, `git worktree remove --force ${worktreePath}`, () => {
      const r = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectDir, encoding: 'utf-8' })
      if (r.status !== 0) throw new Error(r.stderr || 'unknown error')
    })
  } else {
    console.log(`  git worktree registration for ${worktreePath} not found`)
  }

  const branchCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: projectDir,
    encoding: 'utf-8',
  })
  if (branchCheck.status === 0) {
    logAction(dryRun, `git branch -D ${branch}`, () => {
      const r = spawnSync('git', ['branch', '-D', branch], { cwd: projectDir, encoding: 'utf-8' })
      if (r.status !== 0) throw new Error(r.stderr || 'unknown error')
    })
  } else {
    console.log(`  branch ${branch} not present`)
  }
}

function cleanupSandbox(loopName: string, dryRun: boolean): void {
  const containerName = `forge-${loopName}`
  console.log(`\ndocker sandbox container ${containerName}:`)
  const inspect = spawnSync('docker', ['inspect', containerName], { encoding: 'utf-8' })
  if (inspect.status !== 0) {
    console.log(`  not present`)
    return
  }
  logAction(dryRun, `docker rm -f ${containerName}`, () => {
    const r = spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(r.stderr || 'unknown error')
  })
}

function main(): void {
  const args = parseArgs()
  console.log(`Cleanup loop: ${args.loopName}${args.dryRun ? ' [DRY RUN]' : ''}\n`)

  cleanupForgeDb(args.loopName, args.dryRun)
  cleanupOpencodeDb(args.loopName, args.dryRun)
  cleanupWorktreeDirectory(args.loopName, args.dryRun)
  cleanupGitWorktree(args.loopName, args.projectDir, args.dryRun)
  cleanupSandbox(args.loopName, args.dryRun)

  console.log(`\n${args.dryRun ? 'Dry run complete.' : 'Cleanup complete.'}`)
}

main()
