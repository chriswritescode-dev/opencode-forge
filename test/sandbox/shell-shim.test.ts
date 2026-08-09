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
  SHIM_ENV_ENV_FILE,
  SHIM_ENV_HOST_SHELL,
} from '../../src/sandbox/shell-shim'
import { buildSmolvmRootWrapper } from '../../src/sandbox/smolvm'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env[SHIM_ENV_CONTAINER]
  delete env[SHIM_ENV_ENV_FILE]
  delete env[SHIM_ENV_HOST_SHELL]
  return env
}

// Guest-side payloads baked into the smolvm routing lines. smolvm exec has no
// `-w`/`--env-file`, so the shim passes the env file and `$PWD` as `bash -c`
// positionals that the payload applies in-guest.
const SMOLVM_EXEC_ENV_PAYLOAD =
  'while IFS= read -r __fe || [ -n "$__fe" ]; do [ -n "$__fe" ] && export "$__fe"; done < "$0"; cd "$1" && shift 1 && exec bash "$@"'
const SMOLVM_EXEC_PAYLOAD = 'cd "$0" && exec bash "$@"'

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

  test('rewrites the shim when the sandbox mode changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const path = ensureShellShim(dir, logger)!
    expect(readFileSync(path, 'utf-8')).toBe(buildShimScript(resolveHostShell()))

    ensureShellShim(dir, logger, 'smolvm')

    expect(readFileSync(path, 'utf-8')).toBe(buildShimScript(resolveHostShell(), 'smolvm'))
    expect(readFileSync(path, 'utf-8')).not.toContain('sbx exec')
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

  test('fail-closed: when a container is set but sbx is unavailable, the command never runs on the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })
    const marker = join(dir, 'escaped')
    // Empty PATH: `sbx` cannot be found, so exec fails. The shim must exit
    // non-zero without falling through to the host shell.
    const result = spawnSync(shim, ['-c', `touch ${marker}`], {
      env: { ...cleanEnv(), PATH: dir, [SHIM_ENV_CONTAINER]: 'forge-some-loop' },
      encoding: 'utf-8',
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  test('routes into sbx exec with cwd, container, and command when container env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })
    // Fake sbx on PATH that records its argv.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const argsFile = join(dir, 'sbx-args')
    writeFileSync(join(binDir, 'sbx'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const result = spawnSync(shim, ['-c', 'echo in-container'], {
      cwd,
      env: {
        ...cleanEnv(),
        PATH: binDir,
        [SHIM_ENV_CONTAINER]: 'forge-loop-x',
        [SHIM_ENV_ENV_FILE]: '/data/forge/sandbox-env/forge-loop-x.env',
      },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    const argv = readFileSync(argsFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual([
      'exec',
      '--env-file',
      '/data/forge/sandbox-env/forge-loop-x.env',
      '-w',
      realpathSync(cwd),
      'forge-loop-x',
      'bash',
      '-c',
      'echo in-container',
    ])
  })

  test('routes into sbx exec without --env-file when no env file is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh'), { mode: 0o755 })
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const argsFile = join(dir, 'sbx-args')
    writeFileSync(join(binDir, 'sbx'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const result = spawnSync(shim, ['-c', 'echo in-container'], {
      cwd,
      env: { ...cleanEnv(), PATH: binDir, [SHIM_ENV_CONTAINER]: 'forge-loop-x' },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    const argv = readFileSync(argsFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual(['exec', '-w', realpathSync(cwd), 'forge-loop-x', 'bash', '-c', 'echo in-container'])
  })
})

describe('shim behavior (smolvm mode, executed via sh)', () => {
  test('routes into smolvm machine exec with env file, cwd, and command when container env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh', 'smolvm'), { mode: 0o755 })
    // Fake smolvm on PATH that records its argv. PATH is binDir-only, so the
    // real sudo can never be reached; the recorded wrapper is never executed.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const argsFile = join(dir, 'smolvm-args')
    writeFileSync(join(binDir, 'smolvm'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const result = spawnSync(shim, ['-c', 'echo in-container'], {
      cwd,
      env: {
        ...cleanEnv(),
        PATH: binDir,
        [SHIM_ENV_CONTAINER]: 'forge-loop-x',
        [SHIM_ENV_ENV_FILE]: '/data/forge/sandbox-env/forge-loop-x.env',
      },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    const argv = readFileSync(argsFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual([
      'machine',
      'exec',
      '--name',
      'forge-loop-x',
      '--',
      'bash',
      '-c',
      buildSmolvmRootWrapper('bash'),
      SMOLVM_EXEC_ENV_PAYLOAD,
      '/data/forge/sandbox-env/forge-loop-x.env',
      realpathSync(cwd),
      '-c',
      'echo in-container',
    ])
  })

  test('routes into smolvm machine exec without the env-file branch when no env file is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh', 'smolvm'), { mode: 0o755 })
    // Fake smolvm on PATH that records its argv. PATH is binDir-only, so the
    // real sudo can never be reached; the recorded wrapper is never executed.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const argsFile = join(dir, 'smolvm-args')
    writeFileSync(join(binDir, 'smolvm'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const result = spawnSync(shim, ['-c', 'echo in-container'], {
      cwd,
      env: { ...cleanEnv(), PATH: binDir, [SHIM_ENV_CONTAINER]: 'forge-loop-x' },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    const argv = readFileSync(argsFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual([
      'machine',
      'exec',
      '--name',
      'forge-loop-x',
      '--',
      'bash',
      '-c',
      buildSmolvmRootWrapper('bash'),
      SMOLVM_EXEC_PAYLOAD,
      realpathSync(cwd),
      '-c',
      'echo in-container',
    ])
  })

  test('executes the guest payload: env-file vars with spaces are exported and the command runs from $PWD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh', 'smolvm'), { mode: 0o755 })
    // Fake smolvm: drop the CLI prefix up to and including `--`, then exec the
    // remaining command vector exactly as the machine would.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'smolvm'),
      `#!/bin/sh
i=1
for a in "$@"; do
  if [ "$a" = "--" ]; then
    shift $i
    break
  fi
  i=$((i+1))
done
exec "$@"
`,
      { mode: 0o755 },
    )
    // Stub sudo that fails the passwordless probe, so the payload runs
    // unelevated. binDir is first in PATH, so the real sudo is unreachable.
    writeFileSync(join(binDir, 'sudo'), `#!/bin/sh\nexit 1\n`, { mode: 0o755 })

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const envFile = join(dir, 'loop.env')
    writeFileSync(envFile, 'FORGE_VAR=a value with spaces\nFORGE_EMPTY=\n')

    const result = spawnSync(
      shim,
      ['-c', 'printf "value=[%s] pwd=[%s]" "$FORGE_VAR" "$PWD"'],
      {
        cwd,
        env: {
          ...cleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          [SHIM_ENV_CONTAINER]: 'forge-loop-x',
          [SHIM_ENV_ENV_FILE]: envFile,
        },
        encoding: 'utf-8',
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('value=[a value with spaces]')
    expect(result.stdout).toContain(`pwd=[${realpathSync(cwd)}]`)
  })

  test('executes the guest payload via root elevation when passwordless sudo is available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh', 'smolvm'), { mode: 0o755 })
    // Fake smolvm: drop the CLI prefix up to and including `--`, then exec the
    // remaining command vector exactly as the machine would.
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'smolvm'),
      `#!/bin/sh
i=1
for a in "$@"; do
  if [ "$a" = "--" ]; then
    shift $i
    break
  fi
  i=$((i+1))
done
exec "$@"
`,
      { mode: 0o755 },
    )
    // Stub sudo that passes the passwordless probe and records each invocation
    // before execing the remaining arguments as the machine would: it drops the
    // `-nE` flag and an optional `PATH=` assignment, then execs the rest. binDir
    // is first in PATH, so the real sudo is unreachable.
    const sudoArgsFile = join(dir, 'sudo-args')
    writeFileSync(
      join(binDir, 'sudo'),
      `#!/bin/sh
printf '%s\\n' "$@" >> ${sudoArgsFile}
shift
[ "\${1#PATH=}" != "$1" ] && shift
exec "$@"
`,
      { mode: 0o755 },
    )

    const cwd = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
    const envFile = join(dir, 'loop.env')
    writeFileSync(envFile, 'FORGE_VAR=a value with spaces\nFORGE_EMPTY=\n')

    const result = spawnSync(
      shim,
      ['-c', 'printf "value=[%s] pwd=[%s]" "$FORGE_VAR" "$PWD"'],
      {
        cwd,
        env: {
          ...cleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          [SHIM_ENV_CONTAINER]: 'forge-loop-x',
          [SHIM_ENV_ENV_FILE]: envFile,
        },
        encoding: 'utf-8',
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('value=[a value with spaces]')
    expect(result.stdout).toContain(`pwd=[${realpathSync(cwd)}]`)
    // Recorded invocations: the `-nE true` probe first, then the elevation
    // `-nE PATH=<...> bash -c <payload> <envFile> <cwd> -c <command>`.
    const argv = readFileSync(sudoArgsFile, 'utf-8').trim().split('\n')
    expect(argv.slice(0, 2)).toEqual(['-nE', 'true'])
    expect(argv.some((arg) => arg.startsWith('PATH='))).toBe(true)
    const bashIdx = argv.findIndex(
      (arg, i) => arg === 'bash' && argv[i + 1] === '-c' && argv[i + 2] === SMOLVM_EXEC_ENV_PAYLOAD,
    )
    expect(bashIdx).toBeGreaterThan(0)
  })

  test('fail-closed: when a container is set but smolvm is unavailable, the command never runs on the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
    const shim = join(dir, SHELL_SHIM_FILENAME)
    writeFileSync(shim, buildShimScript('/bin/sh', 'smolvm'), { mode: 0o755 })
    const marker = join(dir, 'escaped')
    const result = spawnSync(shim, ['-c', `touch ${marker}`], {
      env: { ...cleanEnv(), PATH: dir, [SHIM_ENV_CONTAINER]: 'forge-some-loop' },
      encoding: 'utf-8',
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('shim content', () => {
  test('routes through sbx exec with no docker and no --user', () => {
    const script = buildShimScript('/bin/sh')
    expect(script).toContain('sbx exec -w "$PWD"')
    expect(script).toContain('--env-file "$FORGE_SANDBOX_ENV_FILE"')
    expect(script).not.toContain('docker')
    expect(script).not.toContain('--user')
    expect(script).toContain('exec "${FORGE_HOST_SHELL:-/bin/sh}" "$@"')
  })

  test('smolvm variant routes through smolvm machine exec with in-guest cwd and env handling', () => {
    const script = buildShimScript('/bin/sh', 'smolvm')
    expect(script).toContain('exec smolvm machine exec --name "$FORGE_SANDBOX_CONTAINER" -- bash -c')
    expect(script).toContain(buildSmolvmRootWrapper('bash'))
    expect(script).toContain(SMOLVM_EXEC_ENV_PAYLOAD)
    expect(script).toContain(SMOLVM_EXEC_PAYLOAD)
    expect(script).toContain('"$PWD" "$@"')
    expect(script).toContain('exec "${FORGE_HOST_SHELL:-/bin/sh}" "$@"')
    expect(script).not.toContain('sbx exec')
    expect(script).toContain('no `-w` or `--env-file`')
    expect(script).toContain('root')
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
