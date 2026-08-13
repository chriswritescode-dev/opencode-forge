import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { Database } from 'bun:sqlite'
import { sandboxContainerName } from '../../src/sandbox/msb'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Fake `msb` that logs its argv and serves a configurable `ls` inventory, so the
// script runs end-to-end without a real CLI.
const FAKE_MSB = `#!/bin/sh
printf '%s\\n' "$@" >> "\${FAKE_MSB_LOG}"
case "$1" in
  ls)
    exit_code="\${FAKE_MSB_LS_EXIT:-0}"
    if [ "$exit_code" != "0" ]; then exit "$exit_code"; fi
    printf '%s' "\${FAKE_MSB_LS_OUT:-[]}"
    exit 0
    ;;
  rm)
    exit_code="\${FAKE_MSB_RM_EXIT:-0}"
    if [ "$exit_code" != "0" ]; then
      printf '%s' "\${FAKE_MSB_RM_ERR:-rm failed}" >&2
      exit "$exit_code"
    fi
    exit 0
    ;;
esac
exit 0
`

interface CleanupRun {
  status: number | null
  stdout: string
  stderr: string
  msbArgs: string[]
}

let binDir: string
let homeDir: string
const projectDirs: string[] = []

function runCleanup(
  loopName: string,
  opts: { lsOut?: string; lsExit?: number; rmExit?: number; rmErr?: string; args?: string[]; xdgDataHome?: string } = {},
): CleanupRun {
  const logPath = join(homeDir, 'msb.log')
  rmSync(logPath, { force: true })
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    ...(opts.xdgDataHome ? { XDG_DATA_HOME: opts.xdgDataHome } : {}),
    FAKE_MSB_LOG: logPath,
    FAKE_MSB_LS_OUT: opts.lsOut ?? '',
    FAKE_MSB_LS_EXIT: String(opts.lsExit ?? 0),
    FAKE_MSB_RM_EXIT: String(opts.rmExit ?? 0),
    FAKE_MSB_RM_ERR: opts.rmErr ?? '',
  }
  const result = spawnSync('bun', ['scripts/cleanup-loop.ts', loopName, ...(opts.args ?? [])], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  })
  let msbArgs: string[] = []
  try {
    msbArgs = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
  } catch {
    // no msb invocation happened
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    msbArgs,
  }
}

function rmTarget(run: CleanupRun): string | undefined {
  const rmIdx = run.msbArgs.indexOf('rm')
  if (rmIdx < 0) return undefined
  return run.msbArgs[rmIdx + 2]
}

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'msb-bin-'))
  homeDir = mkdtempSync(join(tmpdir(), 'msb-home-'))
  const fakeMsb = join(binDir, 'msb')
  writeFileSync(fakeMsb, FAKE_MSB, { mode: 0o755 })
  chmodSync(fakeMsb, 0o755)
})

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
  for (const dir of projectDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('cleanup-loop sandbox naming', () => {
  test('derives the sandbox name through the runtime sanitizer, not string concatenation', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Running"}]',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Cleanup complete.')
    expect(rmTarget(run)).toBe('forge-foo-bar')
    expect(rmTarget(run)).toBe(sandboxContainerName('foo_bar'))
  })

  test('truncates long loop names to the same canonical name runtime provisioning uses', () => {
    const loopName = 'x'.repeat(100)
    const canonical = sandboxContainerName(loopName)
    const run = runCleanup(loopName, {
      lsOut: JSON.stringify([{ name: canonical, status: 'Stopped' }]),
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(`present (state=stopped)`)
    expect(rmTarget(run)).toBe(canonical)
  })
})

describe('cleanup-loop inventory handling', () => {
  test('never reports absence or completion when msb ls exits non-zero', () => {
    const run = runCleanup('foo_bar', { lsExit: 1 })
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('not present')
    expect(run.stdout).not.toContain('Cleanup complete.')
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/could not be established/)
  })

  test('never reports absence or completion when msb ls emits malformed JSON', () => {
    const run = runCleanup('foo_bar', { lsOut: 'not json' })
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('not present')
    expect(run.stdout).not.toContain('Cleanup complete.')
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/could not be established/)
  })

  test('reports absence only after a valid empty inventory', () => {
    const run = runCleanup('foo_bar', { lsOut: '[]' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('not present')
    expect(run.stdout).toContain('Cleanup complete.')
  })
})

describe('cleanup-loop sandbox removal', () => {
  test('exits non-zero and never reports completion when msb rm fails', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Running"}]',
      rmExit: 1,
      rmErr: 'permission denied',
    })
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('Cleanup complete.')
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/could not be established as removed/)
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/permission denied/)
    expect(rmTarget(run)).toBe('forge-foo-bar')
  })

  test('dry run reports the removal action without invoking msb rm', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Stopped"}]',
      args: ['--dry-run'],
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Dry run complete.')
    expect(run.stdout).toContain('would: msb rm --force forge-foo-bar --quiet')
    expect(run.msbArgs).not.toContain('rm')
  })

  test('reports a transient sandbox as present and proceeds with removal', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Draining"}]',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('present (state=transient)')
    expect(run.stdout).not.toContain('inventory query failed')
    expect(run.stdout).toContain('Cleanup complete.')
    expect(rmTarget(run)).toBe('forge-foo-bar')
  })

  test('removal failure still ran the inventory query and targets the canonical name', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Running"}]',
      rmExit: 2,
    })
    expect(run.status).not.toBe(0)
    expect(rmTarget(run)).toBe(sandboxContainerName('foo_bar'))
  })
})

describe('cleanup-loop forge db cleanup', () => {
  test('resolves forge.db under XDG_DATA_HOME and deletes loop state in one pass', () => {
    const xdg = join(homeDir, 'xdg')
    const dbPath = join(xdg, 'opencode', 'forge', 'forge.db')
    mkdirSync(join(xdg, 'opencode', 'forge'), { recursive: true })
    const db = new Database(dbPath)
    db.run('CREATE TABLE loops (project_id TEXT, loop_name TEXT, status TEXT)')
    db.run('CREATE TABLE loop_large_fields (loop_name TEXT)')
    db.run('CREATE TABLE section_plans (loop_name TEXT)')
    db.run('CREATE TABLE review_findings (loop_name TEXT)')
    db.run('INSERT INTO loops (project_id, loop_name, status) VALUES (?, ?, ?)', ['p1', 'foo_bar', 'completed'])
    db.run('INSERT INTO loop_large_fields (loop_name) VALUES (?)', ['foo_bar'])
    db.close()

    const run = runCleanup('foo_bar', {
      lsOut: '[]',
      xdgDataHome: xdg,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(`forge.db (${dbPath}):`)
    expect(run.stdout).toContain('✓ delete loops row project=p1 status=completed')
    expect(run.stdout).toContain('✓ delete loop_large_fields entries for loop=foo_bar')

    const verify = new Database(dbPath)
    expect(verify.prepare('SELECT loop_name FROM loops').all()).toHaveLength(0)
    expect(verify.prepare('SELECT loop_name FROM loop_large_fields').all()).toHaveLength(0)
    verify.close()
  })

  test('rolls back every write when a deletion fails mid-transaction', () => {
    const xdg = join(homeDir, 'xdg-rollback')
    const dbPath = join(xdg, 'opencode', 'opencode.db')
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    const db = new Database(dbPath)
    db.run('CREATE TABLE workspace (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT)')
    db.run('CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT)')
    db.run('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT)')
    db.run("CREATE TRIGGER block_workspace_delete BEFORE DELETE ON workspace BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    db.run("INSERT INTO workspace (id, project_id, name, type) VALUES ('w1', 'p1', 'foo_bar', 'forge')")
    db.run("INSERT INTO session (id, workspace_id, title) VALUES ('s1', 'w1', 'first')")
    db.run("INSERT INTO session_message (id, session_id) VALUES ('m1', 's1')")
    db.close()

    const run = runCleanup('foo_bar', {
      lsOut: '[]',
      xdgDataHome: xdg,
    })
    expect(run.status).not.toBe(0)
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/blocked/)

    const verify = new Database(dbPath)
    expect(verify.prepare("SELECT id FROM session_message WHERE session_id = 's1'").all()).toHaveLength(1)
    expect(verify.prepare("SELECT id FROM session WHERE id = 's1'").all()).toHaveLength(1)
    expect(verify.prepare("SELECT id FROM workspace WHERE id = 'w1'").all()).toHaveLength(1)
    verify.close()
  })
})

describe('cleanup-loop git cleanup', () => {
  test('prunes the worktree and deletes the forge branch in --project-dir', () => {
    const xdg = join(homeDir, 'xdg-git')
    const projectDir = mkdtempSync(join(tmpdir(), 'cleanup-proj-'))
    projectDirs.push(projectDir)
    expect(spawnSync('git', ['init', '-b', 'main', projectDir], { encoding: 'utf-8' }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, encoding: 'utf-8' }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, encoding: 'utf-8' }).status).toBe(0)
    writeFileSync(join(projectDir, 'README.md'), 'hi\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf-8' }).status).toBe(0)
    expect(spawnSync('git', ['commit', '-m', 'init'], { cwd: projectDir, encoding: 'utf-8' }).status).toBe(0)

    const worktreeDir = join(xdg, 'opencode', 'forge', 'worktrees', 'foo_bar')
    mkdirSync(worktreeDir, { recursive: true })
    expect(
      spawnSync('git', ['worktree', 'add', '-b', 'forge/foo_bar', worktreeDir], { cwd: projectDir, encoding: 'utf-8' })
        .status,
    ).toBe(0)

    const run = runCleanup('foo_bar', {
      lsOut: '[]',
      xdgDataHome: xdg,
      args: [`--project-dir=${projectDir}`],
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('✓ git worktree prune')
    expect(run.stdout).toContain('✓ git branch -D forge/foo_bar')

    expect(
      spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/forge/foo_bar'], { cwd: projectDir, encoding: 'utf-8' })
        .status,
    ).not.toBe(0)
    const wtList = spawnSync('git', ['worktree', 'list'], { cwd: projectDir, encoding: 'utf-8' })
    expect(wtList.stdout).not.toContain(worktreeDir)
    expect(existsSync(worktreeDir)).toBe(false)
  })
})
