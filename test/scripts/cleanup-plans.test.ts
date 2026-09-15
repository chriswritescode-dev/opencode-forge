import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { Database } from 'bun:sqlite'
import { parseDurationMs } from '../../scripts/cleanup-plans'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000

interface PlanSeed {
  projectId: string
  loopName?: string | null
  sessionId?: string | null
  content?: string
  updatedAt: number
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

let homeDir: string
const dataHomes: string[] = []

function createForgeDb(plans: PlanSeed[], loops: Array<{ projectId: string; loopName: string }> = []): string {
  const xdg = mkdtempSync(join(tmpdir(), 'cleanup-plans-'))
  dataHomes.push(xdg)
  const dbPath = join(xdg, 'opencode', 'forge', 'forge.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE plans (
      project_id TEXT NOT NULL,
      loop_name  TEXT,
      session_id TEXT,
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE TABLE loops (project_id TEXT NOT NULL, loop_name TEXT NOT NULL)')
  const insertPlan = db.prepare('INSERT INTO plans (project_id, loop_name, session_id, content, updated_at) VALUES (?, ?, ?, ?, ?)')
  for (const plan of plans) {
    insertPlan.run(plan.projectId, plan.loopName ?? null, plan.sessionId ?? null, plan.content ?? 'plan body', plan.updatedAt)
  }
  const insertLoop = db.prepare('INSERT INTO loops (project_id, loop_name) VALUES (?, ?)')
  for (const loop of loops) insertLoop.run(loop.projectId, loop.loopName)
  db.close()
  return xdg
}

function runCleanup(xdgDataHome: string, args: string[] = []): Run {
  const result = spawnSync('bun', ['scripts/cleanup-plans.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CONFIG_HOME: join(homeDir, 'xdg-config'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function remainingPlanKeys(xdgDataHome: string): string[] {
  const db = new Database(join(xdgDataHome, 'opencode', 'forge', 'forge.db'))
  const rows = db.prepare('SELECT loop_name, session_id FROM plans').all() as Array<{ loop_name: string | null; session_id: string | null }>
  db.close()
  return rows.map(row => row.loop_name ?? row.session_id ?? '').sort()
}

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'cleanup-plans-home-'))
})

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true })
  for (const dir of dataHomes) rmSync(dir, { recursive: true, force: true })
})

describe('parseDurationMs', () => {
  test('parses seconds, minutes, hours, days, and weeks', () => {
    expect(parseDurationMs('30s')).toBe(30 * 1000)
    expect(parseDurationMs('90m')).toBe(90 * 60 * 1000)
    expect(parseDurationMs('12h')).toBe(12 * 60 * 60 * 1000)
    expect(parseDurationMs('30d')).toBe(30 * DAY_MS)
    expect(parseDurationMs('2w')).toBe(14 * DAY_MS)
  })

  test('rejects malformed durations', () => {
    for (const raw of ['', '30', 'd30', '30 days', '-1d', '1.5d', '30D']) {
      expect(parseDurationMs(raw), raw).toBeNull()
    }
  })
})

describe('cleanup-plans session plans', () => {
  test('dry run reports the purge without deleting anything', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', sessionId: 'old-session', updatedAt: now - 40 * DAY_MS },
      { projectId: 'p1', sessionId: 'new-session', updatedAt: now },
    ])

    const run = runCleanup(xdg, ['--dry-run'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Session plans older than 30d')
    expect(run.stdout).toContain('Session plans older than the cutoff: 1')
    expect(run.stdout).toContain('old-session')
    expect(run.stdout).toContain('Dry run complete.')
    expect(remainingPlanKeys(xdg)).toEqual(['new-session', 'old-session'])
  })

  test('deletes only session plans older than the cutoff', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', sessionId: 'old-session', updatedAt: now - 40 * DAY_MS },
      { projectId: 'p1', sessionId: 'recent-session', updatedAt: now - 2 * DAY_MS },
      { projectId: 'p1', loopName: 'live-loop', updatedAt: now - 400 * DAY_MS },
    ], [{ projectId: 'p1', loopName: 'live-loop' }])

    const run = runCleanup(xdg)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Deleted 1 session plan and 0 orphan loop plans.')
    expect(remainingPlanKeys(xdg)).toEqual(['live-loop', 'recent-session'])
  })

  test('deletes loop plans whose loop row no longer exists', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', loopName: 'deleted-loop', updatedAt: now },
      { projectId: 'p1', loopName: 'live-loop', updatedAt: now },
    ], [{ projectId: 'p1', loopName: 'live-loop' }])

    const run = runCleanup(xdg)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Deleted 0 session plans and 1 orphan loop plan.')
    expect(remainingPlanKeys(xdg)).toEqual(['live-loop'])
  })

  test('--project limits the purge to one project', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', sessionId: 'p1-old', updatedAt: now - 40 * DAY_MS },
      { projectId: 'p2', sessionId: 'p2-old', updatedAt: now - 40 * DAY_MS },
    ])

    const run = runCleanup(xdg, ['--older-than=7d', '--project=p1'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Cleanup plans: project p1')
    expect(remainingPlanKeys(xdg)).toEqual(['p2-old'])
  })

  test('an explicit threshold keeps plans newer than it', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', sessionId: 'ten-days-old', updatedAt: now - 10 * DAY_MS },
      { projectId: 'p1', sessionId: 'forty-days-old', updatedAt: now - 40 * DAY_MS },
    ])

    const run = runCleanup(xdg, ['--older-than=30d'])
    expect(run.status).toBe(0)
    expect(remainingPlanKeys(xdg)).toEqual(['ten-days-old'])
  })

  test('rejects an invalid --older-than value without touching the database', () => {
    const now = Date.now()
    const xdg = createForgeDb([
      { projectId: 'p1', sessionId: 'old-session', updatedAt: now - 400 * DAY_MS },
    ])

    const run = runCleanup(xdg, ['--older-than=forever'])
    expect(run.status).not.toBe(0)
    expect(`${run.stdout}\n${run.stderr}`).toContain('Invalid --older-than value "forever"')
    expect(remainingPlanKeys(xdg)).toEqual(['old-session'])
  })

  test('skips a missing database', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'cleanup-plans-empty-'))
    dataHomes.push(xdg)

    const run = runCleanup(xdg)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('forge.db not found')
  })
})
