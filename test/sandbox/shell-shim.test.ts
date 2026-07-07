import { describe, test, expect, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureShellShim,
  buildShimScript,
  resolveHostShell,
  SHELL_SHIM_FILENAME,
  SHIM_ENV_CONTAINER,
  SHIM_ENV_HOST_SHELL,
} from '../../src/sandbox/shell-shim'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env[SHIM_ENV_CONTAINER]
  delete env[SHIM_ENV_HOST_SHELL]
  delete env.FORGE_SANDBOX_EXEC_USER
  return env
}

describe('ensureShellShim', () => {
  test('writes an executable shim and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const path = ensureShellShim(dir, logger)

    expect(path).toBe(join(dir, SHELL_SHIM_FILENAME))
    const mode = statSync(path!).mode & 0o777
    expect(mode).toBe(0o755)

    const content = readFileSync(path!, 'utf-8')
    expect(ensureShellShim(dir, logger)).toBe(path)
    expect(readFileSync(path!, 'utf-8')).toBe(content)
  })

  test('rewrites the shim when content drifts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const path = ensureShellShim(dir, logger)!
    writeFileSync(path, '#!/bin/sh\nexit 3\n')

    ensureShellShim(dir, logger)

    expect(readFileSync(path, 'utf-8')).toBe(buildShimScript(resolveHostShell()))
  })

  test('returns null and logs when the data dir is not writable', () => {
    const path = ensureShellShim('/dev/null/not-a-dir', logger)
    expect(path).toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('shim behavior (executed via sh)', () => {
  test('passthrough: runs the command with the baked host shell when no container env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })

    const result = spawnSync(shim, ['-c', 'echo hello from $0'], { env: cleanEnv(), encoding: 'utf-8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('hello from /bin/sh')
  })

  test('passthrough: FORGE_HOST_SHELL overrides the baked default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/nonexistent-shell'), { mode: 0o755 })

    const result = spawnSync(shim, ['-c', 'echo ok'], {
      env: { ...cleanEnv(), [SHIM_ENV_HOST_SHELL]: '/bin/sh' },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  test('fail-closed: when a container is set but docker is unavailable, the command never runs on the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })
    const marker = join(dir, 'escaped')
    // Empty PATH: `docker` cannot be found, so exec fails. The shim must exit
    // non-zero without falling through to the host shell.
    const result = spawnSync(shim, ['-c', `touch ${marker}`], {
      env: { ...cleanEnv(), PATH: dir, [SHIM_ENV_CONTAINER]: 'forge-some-loop' },
      encoding: 'utf-8',
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  test('routes into docker exec with cwd, container, and command when container env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })
    // Fake docker on PATH that records its argv.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const argsFile = join(dir, 'docker-args')
    writeFileSync(join(binDir, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const result = spawnSync(shim, ['-c', 'echo in-container'], {
      cwd,
      env: {
        ...cleanEnv(),
        PATH: binDir,
        [SHIM_ENV_CONTAINER]: 'forge-loop-x',
        FORGE_SANDBOX_EXEC_USER: '501:20',
      },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    const argv = readFileSync(argsFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual(['exec', '--user', '501:20', '-w', realpathSync(cwd), 'forge-loop-x', 'bash', '-c', 'echo in-container'])
  })
})

describe('resolveHostShell', () => {
  test('prefers $SHELL when it exists and is not the shim', () => {
    expect(resolveHostShell({ SHELL: '/bin/sh' })).toBe('/bin/sh')
  })

  test('ignores $SHELL pointing at a shim install', () => {
    const resolved = resolveHostShell({ SHELL: `/some/dir/${SHELL_SHIM_FILENAME}` })
    expect(resolved).not.toContain(SHELL_SHIM_FILENAME)
  })

  test('falls back to a platform default when $SHELL is unset or missing', () => {
    const resolved = resolveHostShell({ SHELL: '/definitely/not/here' })
    expect(existsSync(resolved)).toBe(true)
  })
})
