#!/usr/bin/env bun

import Database from 'bun:sqlite'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { readFlagValue } from '../src/utils/cli-flags'
import { defaultGitService } from '../src/utils/git-service'
import { resolveLoopBranchName } from '../src/workspace/forge-naming'
import { loadPluginConfig } from '../src/setup'
import { resolveForgeDataDir, resolveForgeDbPath, resolveOpencodeDataDir } from '../src/utils/opencode-paths'
import { createMsbRuntime, type SandboxRuntime } from '../src/sandbox/msb'
import { hasTable } from '../src/storage'
import { errorMessage } from '../src/utils/error-message'
import { z } from 'zod'

const DEPENDENT_TABLES = ['loop_large_fields', 'section_plans', 'section_dependencies', 'review_findings', 'plans']

const tableInfoRowsSchema = z.array(z.object({ name: z.string() }))

const loopRowsSchema = z.array(z.looseObject({
  project_id: z.string(),
  loop_name: z.string(),
  status: z.string(),
  worktree_branch: z.string().nullable().optional(),
}))

const workspaceRowsSchema = z.array(z.looseObject({
  id: z.string(),
  project_id: z.string(),
}))

const sessionRowsSchema = z.array(z.looseObject({
  id: z.string(),
  title: z.string(),
}))

const nonEmptyStringSchema = z.string().min(1)

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
    console.error(`  ✗ ${label}: ${errorMessage(err)}`)
  }
}

export async function cleanupForgeDb(loopName: string, dryRun: boolean, dataDir: string): Promise<string[]> {
  const path = resolveForgeDbPath(dataDir)
  if (!existsSync(path)) {
    console.log(`forge.db not found at ${path} — skipping`)
    return []
  }
  console.log(`\nforge.db (${path}):`)
  const db = new Database(path)
  try {
    const hasBranchColumn = tableInfoRowsSchema.parse(db.prepare('PRAGMA table_info(loops)').all()).some(
      column => column.name === 'worktree_branch',
    )
    const rows = loopRowsSchema.parse(db
      .prepare(
        `SELECT project_id, loop_name, status${hasBranchColumn ? ', worktree_branch' : ''} FROM loops WHERE loop_name = ?`,
      )
      .all(loopName))
    if (rows.length === 0) {
      console.log(`  no loops rows for ${loopName}`)
      return []
    }
    const branches = [
      ...new Set(
        rows
          .map(row => row.worktree_branch)
          .filter((branch): branch is string => nonEmptyStringSchema.safeParse(branch).success),
      ),
    ]
    const dependentTables = DEPENDENT_TABLES.filter(table => hasTable(db, table))
    const labels: string[] = []
    for (const row of rows) {
      labels.push(`delete loops row project=${row.project_id} status=${row.status}`)
      for (const table of dependentTables) {
        labels.push(`delete ${table} entries for project=${row.project_id} loop=${loopName}`)
      }
    }
    if (dryRun) {
      for (const label of labels) {
        await logAction(dryRun, label, () => {})
      }
      return branches
    }
    db.transaction(() => {
      for (const row of rows) {
        db.run('DELETE FROM loops WHERE project_id = ? AND loop_name = ?', [row.project_id, loopName])
        for (const table of dependentTables) {
          db.run(`DELETE FROM ${table} WHERE project_id = ? AND loop_name = ?`, [row.project_id, loopName])
        }
      }
    })()
    for (const label of labels) {
      console.log(`  ✓ ${label}`)
    }
    return branches
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
    const workspaces = workspaceRowsSchema.parse(db.query('SELECT id, project_id FROM workspace WHERE name = ? AND type = ?').all(loopName, 'forge'))
    if (workspaces.length === 0) {
      console.log(`  no forge workspaces named ${loopName}`)
      return
    }
    const labels: string[] = []
    for (const ws of workspaces) {
      const sessions = sessionRowsSchema.parse(db.query('SELECT id, title FROM session WHERE workspace_id = ?').all(ws.id))
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
  branches: string[],
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

  for (const branch of branches.length > 0 ? branches : [resolveLoopBranchName(loopName)]) {
    if (!branch.startsWith('forge/')) {
      console.log(`  kept caller branch ${branch}`)
      continue
    }
    if (!defaultGitService.branchExists(projectDir, branch)) {
      console.log(`  branch ${branch} not present`)
      continue
    }
    await logAction(dryRun, `git branch -D ${branch}`, () => {
      const r = defaultGitService.branchDelete(projectDir, branch)
      if (!r.ok) throw new Error(r.stderr || 'unknown error')
    })
  }
}

async function cleanupSandbox(loopName: string, dryRun: boolean, runtime: SandboxRuntime): Promise<boolean> {
  const sandboxName = runtime.sandboxContainerName(loopName)
  console.log(`\nmsb sandbox ${sandboxName}:`)
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

  const dataDir = resolveForgeDataDir(loadPluginConfig().dataDir)
  const worktreesRoot = join(dataDir, 'worktrees')

  const runtime = createMsbRuntime({ log: console.log, error: console.error, debug: () => {} })

  const branches = await cleanupForgeDb(args.loopName, args.dryRun, dataDir)
  await cleanupOpencodeDb(args.loopName, args.dryRun)
  await cleanupWorktreeDirectory(args.loopName, args.dryRun, worktreesRoot)
  await cleanupGitWorktree(args.loopName, branches, args.projectDir, args.dryRun, worktreesRoot)
  const sandboxClean = await cleanupSandbox(args.loopName, args.dryRun, runtime)

  if (!sandboxClean) {
    console.error('\nCleanup incomplete: the msb sandbox could not be established as removed (inventory query failed or removal failed), so it may still be running.')
    process.exit(1)
  }
  console.log(`\n${args.dryRun ? 'Dry run complete.' : 'Cleanup complete.'}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
