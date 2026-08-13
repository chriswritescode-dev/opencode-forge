#!/usr/bin/env bun
/**
 * Wipe all forge state for a single loop name across:
 *   - forge.db `loops` row
 *   - opencode.db `workspace` rows (and their `session` rows)
 *   - on-disk worktree directory
 *   - git worktree registration
 *   - git branch (forge/<loopName>)
 *   - running msb sandbox
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
import { join } from 'path'
import { readFlagValue } from '../src/utils/cli-flags'
import { defaultGitService } from '../src/utils/git-service'
import { loadPluginConfig } from '../src/setup'
import { resolveDataDir, resolveForgeDbPath, resolveOpencodeDataDir } from '../src/utils/opencode-paths'
import { createMsbRuntime, type SandboxRuntime } from '../src/sandbox/msb'

interface Args {
  loopName: string
  projectDir?: string
  dryRun: boolean
}

function parseArgs(): Args {
  const [, , ...rest] = process.argv
  const projectDir = readFlagValue(rest, 'project-dir')
  const dryRun = rest.includes('--dry-run')
  let loopName: string | null = null

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    // Skip a bare value flag together with the token it consumes, so a path
    // passed as `--project-dir /path` is never mistaken for the loop name.
    if (arg === '--project-dir') i++
    else if (!arg.startsWith('--') && !loopName) loopName = arg
  }

  if (!loopName) {
    console.error('Usage: bun scripts/cleanup-loop.ts <loopName> [--project-dir=/path] [--dry-run]')
    process.exit(1)
  }

  return { loopName, projectDir, dryRun }
}

async function logAction(dryRun: boolean, label: string, action: () => Promise<void> | void): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would: ${label}`)
    return
  }
  try {
    await action()
    console.log(`  ✓ ${label}`)
  } catch (err) {
    console.error(`  ✗ ${label}: ${(err as Error).message}`)
  }
}

async function cleanupForgeDb(loopName: string, dryRun: boolean, dataDir: string): Promise<void> {
  const path = resolveForgeDbPath(dataDir)
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
    const dependentTables = ['loop_large_fields', 'section_plans', 'review_findings']
    const labels = [
      ...rows.map((row) => `delete loops row project=${row.project_id} status=${row.status}`),
      ...dependentTables.map((table) => `delete ${table} entries for loop=${loopName}`),
    ]
    if (dryRun) {
      for (const label of labels) {
        await logAction(dryRun, label, () => {})
      }
      return
    }
    db.transaction(() => {
      db.run('DELETE FROM loops WHERE loop_name = ?', [loopName])
      for (const table of dependentTables) {
        try {
          db.run(`DELETE FROM ${table} WHERE loop_name = ?`, [loopName])
        } catch {
          // some tables may not exist on older schemas
        }
      }
    })()
    for (const label of labels) {
      console.log(`  ✓ ${label}`)
    }
  } finally {
    db.close()
  }
}

async function cleanupOpencodeDb(loopName: string, dryRun: boolean): Promise<void> {
  const path = join(resolveOpencodeDataDir(), 'opencode.db')
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
    const labels: string[] = []
    for (const ws of workspaces) {
      const sessions = db.query('SELECT id, title FROM session WHERE workspace_id = ?').all(ws.id) as Array<{
        id: string
        title: string
      }>
      for (const sess of sessions) {
        labels.push(`delete session ${sess.id} (title="${sess.title}") in workspace ${ws.id}`)
      }
      labels.push(`delete workspace ${ws.id} (project=${ws.project_id})`)
    }
    if (dryRun) {
      for (const label of labels) {
        await logAction(dryRun, label, () => {})
      }
      return
    }
    db.transaction(() => {
      for (const ws of workspaces) {
        db.run('DELETE FROM session_message WHERE session_id IN (SELECT id FROM session WHERE workspace_id = ?)', [ws.id])
        db.run('DELETE FROM session WHERE workspace_id = ?', [ws.id])
        db.run('DELETE FROM workspace WHERE id = ?', [ws.id])
      }
    })()
    for (const label of labels) {
      console.log(`  ✓ ${label}`)
    }
  } finally {
    db.close()
  }
}

async function cleanupWorktreeDirectory(loopName: string, dryRun: boolean, worktreesRoot: string): Promise<void> {
  const path = join(worktreesRoot, loopName)
  if (!existsSync(path)) {
    console.log(`\nworktree directory ${path} — already gone`)
    return
  }
  console.log(`\nworktree directory:`)
  await logAction(dryRun, `rm -rf ${path}`, () => {
    rmSync(path, { recursive: true, force: true })
  })
}

async function cleanupGitWorktree(
  loopName: string,
  projectDir: string | undefined,
  dryRun: boolean,
  worktreesRoot: string,
): Promise<void> {
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
  const worktreePath = join(worktreesRoot, loopName)

  await logAction(dryRun, `git worktree prune`, () => {
    const r = defaultGitService.worktreePrune(projectDir)
    if (!r.ok) throw new Error(r.stderr || 'unknown error')
  })

  const worktrees = defaultGitService.worktreeList(projectDir)
  if (!worktrees.ok) {
    console.error(`  ✗ git worktree list --porcelain: ${worktrees.stderr || 'unknown error'}`)
  } else if (worktrees.stdout.includes(worktreePath)) {
    await logAction(dryRun, `git worktree remove --force ${worktreePath}`, () => {
      const r = defaultGitService.worktreeRemove(projectDir, worktreePath)
      if (!r.ok) throw new Error(r.stderr || 'unknown error')
    })
  } else {
    console.log(`  git worktree registration for ${worktreePath} not found`)
  }

  if (defaultGitService.branchExists(projectDir, branch)) {
    await logAction(dryRun, `git branch -D ${branch}`, () => {
      const r = defaultGitService.branchDelete(projectDir, branch)
      if (!r.ok) throw new Error(r.stderr || 'unknown error')
    })
  } else {
    console.log(`  branch ${branch} not present`)
  }
}

async function cleanupSandbox(loopName: string, dryRun: boolean, runtime: SandboxRuntime): Promise<boolean> {
  // Derive the name through the same sanitization the runtime uses when provisioning,
  // so cleanup can never drift from the actual container name (e.g. `foo_bar` → `forge-foo-bar`).
  const sandboxName = runtime.sandboxContainerName(loopName)
  console.log(`\nmsb sandbox ${sandboxName}:`)
  // getSandboxState shares the runtime's own `msb ls` parsing, so this cannot drift from the
  // status interpretation the rest of forge uses. `unknown` means the query failed: absence
  // may only be proven by a parsed inventory, otherwise the sandbox may still be running.
  const state = await runtime.getSandboxState(sandboxName)
  if (state === 'unknown') {
    console.error(`  ✗ msb inventory query failed; sandbox ${sandboxName} may still be running`)
    return false
  }
  if (state === 'missing') {
    console.log(`  not present`)
    return true
  }
  console.log(`  present (state=${state})`)
  if (dryRun) {
    console.log(`[dry-run] would: msb rm --force ${sandboxName} --quiet`)
    return true
  }
  try {
    await runtime.removeSandbox(sandboxName)
    console.log(`  ✓ msb rm --force ${sandboxName} --quiet`)
    return true
  } catch (err) {
    console.error(`  ✗ msb rm --force ${sandboxName} --quiet: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  console.log(`Cleanup loop: ${args.loopName}${args.dryRun ? ' [DRY RUN]' : ''}\n`)

  const dataDir = loadPluginConfig().dataDir || resolveDataDir()
  const worktreesRoot = join(dataDir, 'worktrees')

  const runtime = createMsbRuntime({ log: console.log, error: console.error, debug: () => {} })

  await cleanupForgeDb(args.loopName, args.dryRun, dataDir)
  await cleanupOpencodeDb(args.loopName, args.dryRun)
  await cleanupWorktreeDirectory(args.loopName, args.dryRun, worktreesRoot)
  await cleanupGitWorktree(args.loopName, args.projectDir, args.dryRun, worktreesRoot)
  const sandboxClean = await cleanupSandbox(args.loopName, args.dryRun, runtime)

  if (!sandboxClean) {
    console.error('\nCleanup incomplete: the msb sandbox could not be established as removed (inventory query failed or removal failed), so it may still be running.')
    process.exit(1)
  }
  console.log(`\n${args.dryRun ? 'Dry run complete.' : 'Cleanup complete.'}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
