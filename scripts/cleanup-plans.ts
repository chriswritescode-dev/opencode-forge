#!/usr/bin/env bun

import Database from 'bun:sqlite'
import { existsSync } from 'fs'
import { readFlagValue } from '../src/utils/cli-flags'
import { loadPluginConfig } from '../src/setup'
import { resolveForgeDataDir, resolveForgeDbPath } from '../src/utils/opencode-paths'
import { z } from 'zod'

interface Args {
  olderThanMs: number
  olderThanLabel: string
  projectId?: string
  dryRun: boolean
}

const DEFAULT_OLDER_THAN = '30d'

interface DurationUnitMilliseconds {
  [unit: string]: number
}

const UNIT_MS: DurationUnitMilliseconds = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const sessionPlanRowsSchema = z.array(z.looseObject({
  project_id: z.string(),
  session_id: z.string(),
  updated_at: z.number(),
}))

const orphanPlanRowsSchema = z.array(z.looseObject({
  project_id: z.string(),
  loop_name: z.string(),
  updated_at: z.number(),
}))

export function parseDurationMs(raw: string): number | null {
  const match = /^(\d+)([smhdw])$/.exec(raw.trim())
  if (!match) return null
  return Number(match[1]) * UNIT_MS[match[2]]
}

function parseArgs(): Args {
  const [, , ...rest] = process.argv
  const olderThanLabel = readFlagValue(rest, 'older-than') ?? DEFAULT_OLDER_THAN
  const olderThanMs = parseDurationMs(olderThanLabel)
  if (olderThanMs === null) {
    console.error(`Invalid --older-than value "${olderThanLabel}". Use a duration like 30d, 12h, 90m, or 2w.`)
    process.exit(1)
  }
  const projectId = readFlagValue(rest, 'project')
  const args: Args = {
    olderThanMs,
    olderThanLabel,
    dryRun: rest.includes('--dry-run'),
  }
  if (projectId !== undefined && projectId !== '') args.projectId = projectId
  return args
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function logRows(label: string, rows: Array<{ project_id: string; name: string; updated_at: number }>): void {
  console.log(`${label}: ${rows.length}`)
  for (const row of rows.slice(0, 20)) {
    console.log(`  ${row.project_id} ${row.name} | updated ${new Date(row.updated_at).toISOString().slice(0, 10)}`)
  }
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`)
}

function main(): void {
  const args = parseArgs()
  const dataDir = resolveForgeDataDir(loadPluginConfig().dataDir)
  const dbPath = resolveForgeDbPath(dataDir)
  if (!existsSync(dbPath)) {
    console.log(`forge.db not found at ${dbPath} — skipping`)
    return
  }

  const db = new Database(dbPath)
  try {
    const cutoff = Date.now() - args.olderThanMs
    const projectClause = args.projectId ? ' AND project_id = ?' : ''
    const sessionParams: (string | number)[] = args.projectId ? [cutoff, args.projectId] : [cutoff]
    const orphanParams: string[] = args.projectId ? [args.projectId] : []

    const sessionPlans = sessionPlanRowsSchema.parse(db.prepare(`
      SELECT project_id, session_id, updated_at
      FROM plans
      WHERE loop_name IS NULL AND updated_at < ?${projectClause}
      ORDER BY updated_at DESC
    `).all(...sessionParams))

    const orphanPlans = orphanPlanRowsSchema.parse(db.prepare(`
      SELECT project_id, loop_name, updated_at
      FROM plans
      WHERE loop_name IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM loops l
          WHERE l.project_id = plans.project_id AND l.loop_name = plans.loop_name
        )${projectClause}
      ORDER BY updated_at DESC
    `).all(...orphanParams))

    console.log(`Cleanup plans: ${args.projectId ? `project ${args.projectId}` : 'all projects'}${args.dryRun ? ' [DRY RUN]' : ''}`)
    console.log(`Session plans older than ${args.olderThanLabel} (before ${new Date(cutoff).toISOString()}):\n`)
    logRows('Session plans older than the cutoff', sessionPlans.map(row => ({
      project_id: row.project_id,
      name: row.session_id,
      updated_at: row.updated_at,
    })))
    console.log()
    logRows('Loop plans with no loop row', orphanPlans.map(row => ({
      project_id: row.project_id,
      name: row.loop_name,
      updated_at: row.updated_at,
    })))

    if (args.dryRun) {
      console.log('\nDry run complete.')
      return
    }

    db.transaction(() => {
      db.prepare(`DELETE FROM plans WHERE loop_name IS NULL AND updated_at < ?${projectClause}`).run(...sessionParams)
      db.prepare(`
        DELETE FROM plans
        WHERE loop_name IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM loops l
            WHERE l.project_id = plans.project_id AND l.loop_name = plans.loop_name
          )${projectClause}
      `).run(...orphanParams)
    })()

    console.log(`\nDeleted ${plural(sessionPlans.length, 'session plan')} and ${plural(orphanPlans.length, 'orphan loop plan')}.`)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
