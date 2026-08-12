import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
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

function runCleanup(
  loopName: string,
  opts: { lsOut?: string; lsExit?: number; rmExit?: number; rmErr?: string; args?: string[] } = {},
): CleanupRun {
  const logPath = join(homeDir, 'msb.log')
  rmSync(logPath, { force: true })
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
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

  test('removal failure still ran the inventory query and targets the canonical name', () => {
    const run = runCleanup('foo_bar', {
      lsOut: '[{"name":"forge-foo-bar","status":"Running"}]',
      rmExit: 2,
    })
    expect(run.status).not.toBe(0)
    expect(rmTarget(run)).toBe(sandboxContainerName('foo_bar'))
  })
})
