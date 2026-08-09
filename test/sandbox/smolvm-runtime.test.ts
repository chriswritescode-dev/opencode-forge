import { describe, test, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SMOLVM_INSTALL_HINT,
  SMOLVM_DOCKER_BOOTSTRAP,
  resolveSmolvmAllowHosts,
  checkSmolvmAvailability,
  describeSmolvmUnavailable,
  normalizeSmolvmMemoryMiB,
  buildSmolvmCreateArgs,
  buildSmolvmStartArgs,
  buildSmolvmExecArgs,
  buildSmolvmDeleteArgs,
  buildEnvFilePreamble,
  smolvmImageTarPath,
  resolveSmolvmImageArg,
  createSmolvmRuntime,
} from '../../src/sandbox/smolvm'
import type { CommandRunner } from '../../src/sandbox/sbx'
import type { Logger } from '../../src/types'
import { createRecordingRunner } from '../helpers/sandbox-mocks'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('availability', () => {
  test('a --version exit 0 yields available', async () => {
    const fake: CommandRunner = async () => ({ stdout: 'smolvm 0.1.0\n', stderr: '', exitCode: 0 })
    await expect(checkSmolvmAvailability(fake)).resolves.toEqual({ available: true })
  })

  test('a missing CLI yields not-installed from an ENOENT spawn', async () => {
    const fake: CommandRunner = async () => ({ stdout: '', stderr: 'spawn smolvm ENOENT', exitCode: 1 })
    await expect(checkSmolvmAvailability(fake)).resolves.toEqual({
      available: false,
      reason: 'not-installed',
    })
  })

  test('any other non-zero exit yields unknown with trimmed detail', async () => {
    const fake: CommandRunner = async () => ({ stdout: '', stderr: 'some error\n', exitCode: 2 })
    const result = await checkSmolvmAvailability(fake)
    expect(result).toMatchObject({ available: false, reason: 'unknown' })
    if (!result.available) expect(result.detail).toBe('some error')
  })

  test('a rejecting runner yields unknown', async () => {
    const fake: CommandRunner = async () => {
      throw new Error('boom')
    }
    await expect(checkSmolvmAvailability(fake)).resolves.toEqual({ available: false, reason: 'unknown' })
  })

  test('passes --version with a 5000ms timeout to the runner', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: 'smolvm 0.1.0\n', stderr: '', exitCode: 0 }))
    await checkSmolvmAvailability(runner)
    expect(calls[0].args).toEqual(['--version'])
    expect(calls[0].opts?.timeout).toBe(5000)
  })

  test('describeSmolvmUnavailable carries the remediation strings', () => {
    expect(describeSmolvmUnavailable({ available: false, reason: 'not-installed' })).toBe(
      `The smolvm CLI is not installed. Install it with: ${SMOLVM_INSTALL_HINT}, then try again.`,
    )
    expect(describeSmolvmUnavailable({ available: false, reason: 'unknown', detail: 'x' })).toBe(
      'Could not determine smolvm availability. x',
    )
    expect(describeSmolvmUnavailable({ available: false, reason: 'unknown' })).toBe(
      'Could not determine smolvm availability. Unknown error.',
    )
    expect(describeSmolvmUnavailable({ available: false, reason: 'daemon-down' })).toBe(
      'Could not determine smolvm availability. Unknown error.',
    )
  })
})

describe('create args', () => {
  test('emits the minimal create vector for one read-write workspace', () => {
    expect(buildSmolvmCreateArgs('forge-c', [{ hostDir: '/work' }])).toEqual([
      'machine',
      'create',
      '--name',
      'forge-c',
      '--net',
      '-v',
      '/work:/work',
    ])
  })

  test('emits the fully-flagged create vector', () => {
    expect(
      buildSmolvmCreateArgs('forge-c', [{ hostDir: '/work' }, { hostDir: '/proj', readOnly: true }], {
        image: 'oc-forge-sandbox:latest',
        cpus: 4,
        memMiB: 8192,
        allowHosts: ['a.example', ' b.example ', ''],
      }),
    ).toEqual([
      'machine',
      'create',
      '--name',
      'forge-c',
      '--net',
      '--image',
      'oc-forge-sandbox:latest',
      '--allow-host',
      'a.example',
      '--allow-host',
      'b.example',
      '--cpus',
      '4',
      '--mem',
      '8192',
      '-v',
      '/work:/work',
      '-v',
      '/proj:/proj:ro',
    ])
  })

  test('suffixes read-only workspaces with :ro and leaves read-write bare', () => {
    expect(
      buildSmolvmCreateArgs('forge-c', [{ hostDir: '/work' }, { hostDir: '/proj', readOnly: true }]),
    ).toEqual([
      'machine',
      'create',
      '--name',
      'forge-c',
      '--net',
      '-v',
      '/work:/work',
      '-v',
      '/proj:/proj:ro',
    ])
  })

  test('drops empty allow-host entries and omits unset image/cpus/mem flags', () => {
    expect(
      buildSmolvmCreateArgs('forge-c', [{ hostDir: '/work' }], {
        allowHosts: ['', '  '],
      }),
    ).toEqual(['machine', 'create', '--name', 'forge-c', '--net', '-v', '/work:/work'])
  })

  test('a wildcard allow-host entry drops every --allow-host flag', () => {
    // smolvm resolves each --allow-host as a literal hostname, so sbx's allow-everything `**`
    // would fail the create; an absent list already means unrestricted egress.
    expect(resolveSmolvmAllowHosts(['**'])).toEqual([])
    expect(resolveSmolvmAllowHosts(['**', 'db.internal'])).toEqual([])
    expect(resolveSmolvmAllowHosts(['*.example.com'])).toEqual([])
    expect(resolveSmolvmAllowHosts([' db.internal ', ''])).toEqual(['db.internal'])
    expect(resolveSmolvmAllowHosts(undefined)).toEqual([])
    expect(buildSmolvmCreateArgs('forge-c', [{ hostDir: '/work' }], { allowHosts: ['**'] })).not.toContain(
      '--allow-host',
    )
  })

  test('throws on an empty workspace array', () => {
    expect(() => buildSmolvmCreateArgs('forge-c', [])).toThrow('requires at least one workspace')
  })
})

describe('start/exec/delete args', () => {
  test('buildSmolvmStartArgs emits the start vector', () => {
    expect(buildSmolvmStartArgs('forge-c')).toEqual(['machine', 'start', '--name', 'forge-c'])
  })

  test('emits the minimal exec vector', () => {
    expect(buildSmolvmExecArgs('forge-c', 'ls')).toEqual([
      'machine',
      'exec',
      '--name',
      'forge-c',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('adds -i when interactive', () => {
    expect(buildSmolvmExecArgs('forge-c', 'cat', { interactive: true })).toEqual([
      'machine',
      'exec',
      '-i',
      '--name',
      'forge-c',
      '--',
      'sh',
      '-c',
      'cat',
    ])
  })

  test('buildSmolvmDeleteArgs emits the delete vector', () => {
    expect(buildSmolvmDeleteArgs('forge-c')).toEqual(['machine', 'delete', '--name', 'forge-c', '-f'])
  })
})

describe('resource coercion', () => {
  test('normalizeSmolvmMemoryMiB converts binary units to integer MiB', () => {
    expect(normalizeSmolvmMemoryMiB('8g', logger)).toBe(8192)
    expect(normalizeSmolvmMemoryMiB('8GB', logger)).toBe(8192)
    expect(normalizeSmolvmMemoryMiB('1024m', logger)).toBe(1024)
    expect(normalizeSmolvmMemoryMiB('512k', logger)).toBe(1)
  })

  test('normalizeSmolvmMemoryMiB returns undefined for unrecognized input', () => {
    expect(normalizeSmolvmMemoryMiB('lots', logger)).toBeUndefined()
    expect(normalizeSmolvmMemoryMiB(undefined, logger)).toBeUndefined()
    expect(normalizeSmolvmMemoryMiB('', logger)).toBeUndefined()
  })

  test('normalizeSmolvmMemoryMiB logs when ignoring unrecognized input', () => {
    const log = vi.fn()
    normalizeSmolvmMemoryMiB('lots', { ...logger, log })
    expect(log).toHaveBeenCalledWith('Sandbox: unrecognized --mem value "lots" ignored')
  })
})

describe('env file preamble', () => {
  test('buildEnvFilePreamble emits the read-export loop with the path quoted', () => {
    expect(buildEnvFilePreamble('/data/sandbox-env/forge-c.env')).toBe(
      "while IFS= read -r __fe || [ -n \"$__fe\" ]; do [ -n \"$__fe\" ] && export \"$__fe\"; done < '/data/sandbox-env/forge-c.env'; ",
    )
  })

  test('buildEnvFilePreamble single-quote-escapes a path containing a quote', () => {
    expect(buildEnvFilePreamble("/data/sandbox-env/forge-o'brien.env")).toBe(
      "while IFS= read -r __fe || [ -n \"$__fe\" ]; do [ -n \"$__fe\" ] && export \"$__fe\"; done < '/data/sandbox-env/forge-o'\\''brien.env'; ",
    )
  })
})

describe('image arg resolution', () => {
  test('smolvmImageTarPath sanitizes the ref into the store file name', () => {
    expect(smolvmImageTarPath('/store', 'oc-forge-sandbox:latest')).toBe(
      '/store/oc-forge-sandbox-latest.tar',
    )
    expect(smolvmImageTarPath('/store', 'My Image!')).toBe('/store/my-image.tar')
  })

  test('resolveSmolvmImageArg returns the store tar path when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-store-'))
    try {
      writeFileSync(join(dir, 'oc-forge-sandbox-latest.tar'), 'not a tar')
      expect(resolveSmolvmImageArg(dir, 'oc-forge-sandbox:latest')).toBe(
        join(dir, 'oc-forge-sandbox-latest.tar'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('resolveSmolvmImageArg passes through a registry-qualified ref', () => {
    expect(resolveSmolvmImageArg(undefined, 'docker.io/library/oc-forge-sandbox:latest')).toBe(
      'docker.io/library/oc-forge-sandbox:latest',
    )
    expect(resolveSmolvmImageArg('/missing-store', 'docker.io/library/oc-forge-sandbox:latest')).toBe(
      'docker.io/library/oc-forge-sandbox:latest',
    )
  })

  test('resolveSmolvmImageArg returns null for an unbuilt local template', () => {
    expect(resolveSmolvmImageArg(undefined, 'oc-forge-sandbox:latest')).toBeNull()
    expect(resolveSmolvmImageArg('/missing-store', 'oc-forge-sandbox:latest')).toBeNull()
  })
})

describe('runtime', () => {
  test('checkAvailable proxies to checkSmolvmAvailability', async () => {
    const { runner } = createRecordingRunner(() => ({ stdout: 'smolvm 0.1.0\n', stderr: '', exitCode: 0 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.checkAvailable()).resolves.toEqual({ available: true })
  })

  test('describeUnavailable delegates to describeSmolvmUnavailable', () => {
    const rt = createSmolvmRuntime(logger)
    expect(rt.describeUnavailable({ available: false, reason: 'not-installed' })).toContain(
      'The smolvm CLI is not installed',
    )
  })

  test('templateExists is true when the store tar exists and false otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-data-'))
    try {
      const store = join(dir, 'smolvm-images')
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, 'oc-forge-sandbox-latest.tar'), 'tar')
      const rt = createSmolvmRuntime(logger, { dataDir: dir })
      await expect(rt.templateExists('oc-forge-sandbox:latest')).resolves.toBe(true)
      await expect(rt.templateExists('oc-forge-sandbox:other')).resolves.toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('templateExists accepts a registry-qualified ref without a dataDir', async () => {
    const rt = createSmolvmRuntime(logger)
    await expect(rt.templateExists('docker.io/library/oc-forge-sandbox:latest')).resolves.toBe(true)
  })

  test('templateLoadHint quotes the store path with a dataDir and falls back otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-data-'))
    try {
      const rt = createSmolvmRuntime(logger, { dataDir: dir })
      expect(rt.templateLoadHint('oc-forge-sandbox:latest')).toBe(
        `cp <tar> "${join(dir, 'smolvm-images', 'oc-forge-sandbox-latest.tar')}"`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(createSmolvmRuntime(logger).templateLoadHint('oc-forge-sandbox:latest')).toBe(
      'cp <tar> <forge-data-dir>/smolvm-images/',
    )
  })

  test('loadTemplate copies the tar into the store path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-data-'))
    try {
      const src = join(dir, 'src.tar')
      writeFileSync(src, 'tar-bytes')
      const rt = createSmolvmRuntime(logger, { dataDir: dir })
      await rt.loadTemplate(src, 'oc-forge-sandbox:latest')
      expect(readFileSync(join(dir, 'smolvm-images', 'oc-forge-sandbox-latest.tar'), 'utf-8')).toBe('tar-bytes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loadTemplate throws without a dataDir', async () => {
    const rt = createSmolvmRuntime(logger)
    await expect(rt.loadTemplate('/tmp/t.tar', 'oc-forge-sandbox:latest')).rejects.toThrow('no image store')
  })

  test('createSandbox emits create-then-start with --net, env-dir mount, allow-host and resolved tar image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-data-'))
    try {
      const store = join(dir, 'smolvm-images')
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, 'oc-forge-sandbox-latest.tar'), 'tar')
      const { calls, runner } = createRecordingRunner()
      const rt = createSmolvmRuntime(logger, { dataDir: dir, run: runner })
      await rt.createSandbox('forge-c', [{ hostDir: '/work' }], {
        template: 'oc-forge-sandbox:latest',
        resources: { memory: '8g', cpus: '4' },
        networkAllowHosts: ['db.internal'],
      })
      expect(calls).toHaveLength(3)
      expect(calls[0].args).toEqual([
        'machine',
        'create',
        '--name',
        'forge-c',
        '--net',
        '--image',
        join(store, 'oc-forge-sandbox-latest.tar'),
        '--allow-host',
        'db.internal',
        '--cpus',
        '4',
        '--mem',
        '8192',
        '-v',
        '/work:/work',
        '-v',
        `${join(dir, 'sandbox-env')}:${join(dir, 'sandbox-env')}:ro`,
      ])
      expect(calls[0].opts?.timeout).toBe(120000)
      expect(calls[1].args).toEqual(['machine', 'start', '--name', 'forge-c'])
      expect(calls[1].opts?.timeout).toBe(120000)
      expect(calls[2].args).toEqual(['machine', 'exec', '--name', 'forge-c', '--', 'sh', '-c', SMOLVM_DOCKER_BOOTSTRAP])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('createSandbox does not append the env mount when a workspace already covers it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolvm-data-'))
    try {
      const { calls, runner } = createRecordingRunner()
      const rt = createSmolvmRuntime(logger, { dataDir: dir, run: runner })
      await rt.createSandbox('forge-c', [{ hostDir: dir }], {
        template: 'docker.io/library/oc-forge-sandbox:latest',
      })
      expect(calls[0].args).toEqual([
        'machine',
        'create',
        '--name',
        'forge-c',
        '--net',
        '--image',
        'docker.io/library/oc-forge-sandbox:latest',
        '-v',
        `${dir}:${dir}`,
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a failed Docker bootstrap is logged but never fails the sandbox', async () => {
    const { calls, runner } = createRecordingRunner((rec) =>
      rec.args[1] === 'exec' ? { stdout: '', stderr: 'dockerd: not found', exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 },
    )
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.createSandbox('forge-c', [{ hostDir: '/work' }])).resolves.toBeUndefined()
    expect(calls[2].args[calls[2].args.length - 1]).toBe(SMOLVM_DOCKER_BOOTSTRAP)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Docker is unavailable in forge-c'))
  })

  test('the Docker bootstrap no-ops without dockerd and skips an already-running daemon', () => {
    expect(SMOLVM_DOCKER_BOOTSTRAP).toContain('command -v dockerd >/dev/null 2>&1 || exit 0')
    expect(SMOLVM_DOCKER_BOOTSTRAP).toContain('docker info >/dev/null 2>&1 && exit 0')
    // overlay2 cannot stack on the machine's overlay root, so the data root is the ext4 disk,
    // and the socket group must match the exec user's primary group.
    expect(SMOLVM_DOCKER_BOOTSTRAP).toContain('--data-root=/storage/docker')
    expect(SMOLVM_DOCKER_BOOTSTRAP).toContain('--storage-driver=overlay2')
    expect(SMOLVM_DOCKER_BOOTSTRAP).toContain('--group agent')
  })

  test('createSandbox throws when a set template resolves to null', async () => {
    const { runner } = createRecordingRunner()
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-c', [{ hostDir: '/work' }], { template: 'oc-forge-sandbox:latest' }),
    ).rejects.toThrow('Sandbox template "oc-forge-sandbox:latest" not found in the smolvm image store')
  })

  test('createSandbox failure short-circuits before start', async () => {
    const { calls, runner } = createRecordingRunner((rec) =>
      rec.args[1] === 'create' ? { stdout: '', stderr: 'disk full', exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 },
    )
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.createSandbox('forge-c', [{ hostDir: '/work' }])).rejects.toThrow(
      'Failed to create sandbox: disk full',
    )
    expect(calls).toHaveLength(1)
  })

  test('createSandbox throws on a failed start', async () => {
    const { runner } = createRecordingRunner((rec) =>
      rec.args[1] === 'start' ? { stdout: '', stderr: 'cannot boot', exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 },
    )
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.createSandbox('forge-c', [{ hostDir: '/work' }])).rejects.toThrow(
      'Failed to start sandbox: cannot boot',
    )
  })

  test('exec embeds the env preamble and cwd prefix', async () => {
    const { calls, runner } = createRecordingRunner()
    const rt = createSmolvmRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { envFile: '/data/sandbox-env/forge-c.env', cwd: '/work' })
    expect(calls[0].args).toEqual([
      'machine',
      'exec',
      '--name',
      'forge-c',
      '--',
      'sh',
      '-c',
      "while IFS= read -r __fe || [ -n \"$__fe\" ]; do [ -n \"$__fe\" ] && export \"$__fe\"; done < '/data/sandbox-env/forge-c.env'; cd '/work' && ls",
    ])
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('exec without envFile or cwd runs the bare command with a custom timeout', async () => {
    const { calls, runner } = createRecordingRunner()
    const rt = createSmolvmRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { timeout: 3000 })
    expect(calls[0].args[calls[0].args.length - 1]).toBe('ls')
    expect(calls[0].opts?.timeout).toBe(3000)
  })

  test('execPipe sets interactive, passes stdin and prefixes the env preamble', async () => {
    const { calls, runner } = createRecordingRunner()
    const rt = createSmolvmRuntime(logger, { run: runner })
    await rt.execPipe('forge-c', 'cat', 'hello', { envFile: '/e.env' })
    expect(calls[0].args.slice(0, 4)).toEqual(['machine', 'exec', '-i', '--name'])
    expect(calls[0].opts?.stdin).toBe('hello')
    expect(calls[0].args[calls[0].args.length - 1]).toMatch(/^while IFS= read -r __fe/)
  })

  test('exec transparently restarts a stopped machine and retries exactly once', async () => {
    let execCount = 0
    const { calls, runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') {
        execCount += 1
        return execCount === 1
          ? { stdout: '', stderr: 'machine forge-c is not running', exitCode: 1 }
          : { stdout: 'ok', stderr: '', exitCode: 0 }
      }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [{ name: 'forge-c', status: 'stopped' }] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.exec('forge-c', 'ls')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('ok')
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'machine exec --name forge-c -- sh -c ls',
      'machine ls --json',
      'machine start --name forge-c',
      `machine exec --name forge-c -- sh -c ${SMOLVM_DOCKER_BOOTSTRAP}`,
      'machine exec --name forge-c -- sh -c ls',
    ])
  })

  test('exec does not loop when the stopped retry keeps failing', async () => {
    const { calls, runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') return { stdout: '', stderr: 'not running', exitCode: 1 }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [{ name: 'forge-c', status: 'stopped' }] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.exec('forge-c', 'ls')
    expect(result.exitCode).toBe(1)
    const commandExecs = calls.filter(
      (c) => c.args.join(' ').startsWith('machine exec') && c.args[c.args.length - 1] === 'ls',
    )
    expect(commandExecs).toHaveLength(2)
    expect(calls.filter((c) => c.args.join(' ').startsWith('machine start')).length).toBe(1)
  })

  test('exec surfaces the original error when the failure is not a stopped machine', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.exec('forge-c', 'ls')
    expect(result.exitCode).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test('exec does not restart when the failure message matches but the machine is running', async () => {
    const { calls, runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') return { stdout: '', stderr: 'process is not running', exitCode: 1 }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [{ name: 'forge-c', status: 'running' }] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.exec('forge-c', 'ls')
    expect(result.exitCode).toBe(1)
    expect(calls.map((c) => c.args.join(' '))).toEqual(['machine exec --name forge-c -- sh -c ls', 'machine ls --json'])
  })

  test('exec surfaces the original error when the machine is missing despite a matching message', async () => {
    const { calls, runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') return { stdout: '', stderr: 'machine forge-c is not running', exitCode: 1 }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.exec('forge-c', 'ls')
    expect(result.exitCode).toBe(1)
    expect(calls.map((c) => c.args.join(' '))).toEqual(['machine exec --name forge-c -- sh -c ls', 'machine ls --json'])
  })

  test('exec throws when the restart start fails', async () => {
    const { runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') return { stdout: '', stderr: 'machine is stopped', exitCode: 1 }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [{ name: 'forge-c', status: 'stopped' }] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'cannot start', exitCode: 1 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.exec('forge-c', 'ls')).rejects.toThrow('Failed to start sandbox: cannot start')
  })

  test('execPipe restarts a stopped machine too', async () => {
    let execCount = 0
    const { calls, runner } = createRecordingRunner((rec) => {
      if (rec.args[1] === 'exec') {
        execCount += 1
        return execCount === 1
          ? { stdout: '', stderr: 'machine stopped', exitCode: 1 }
          : { stdout: 'pipe-out', stderr: '', exitCode: 0 }
      }
      if (rec.args[1] === 'ls') {
        return { stdout: JSON.stringify({ machines: [{ name: 'forge-c', status: 'stopped' }] }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createSmolvmRuntime(logger, { run: runner })
    const result = await rt.execPipe('forge-c', 'cat', 'in')
    expect(result.stdout).toBe('pipe-out')
    expect(calls.filter((c) => c.args.join(' ').startsWith('machine start')).length).toBe(1)
  })

  test('getSandboxState maps machine ls entries to running/stopped/missing', async () => {
    const stdout = JSON.stringify({
      machines: [
        { name: 'forge-a', status: 'running' },
        { name: 'forge-b', status: 'stopped' },
      ],
    })
    const { calls, runner } = createRecordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('running')
    await expect(rt.getSandboxState('forge-b')).resolves.toBe('stopped')
    await expect(rt.getSandboxState('forge-c')).resolves.toBe('missing')
    expect(calls[0].args).toEqual(['machine', 'ls', '--json'])
    expect(calls[0].opts?.timeout).toBe(5000)
  })

  test('getSandboxState reports unknown on unparseable or schema-changed output', async () => {
    for (const stdout of ['not json', '123', JSON.stringify({ error: 'down' })]) {
      const { runner } = createRecordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
      const rt = createSmolvmRuntime(logger, { run: runner })
      await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
    }
  })

  test('getSandboxState reports unknown when the ls invocation fails or throws', async () => {
    const failing = createRecordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    await expect(createSmolvmRuntime(logger, { run: failing.runner }).getSandboxState('forge-a')).resolves.toBe('unknown')
    const throwing = createRecordingRunner(() => { throw new Error('smolvm exploded') })
    await expect(createSmolvmRuntime(logger, { run: throwing.runner }).getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState treats empty output as an empty list so a missing sandbox can be created', async () => {
    const { runner } = createRecordingRunner(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('missing')
  })

  test('listSandboxesByPrefix filters parsed machine names by prefix', async () => {
    const stdout = JSON.stringify({ machines: [{ name: 'forge-a' }, { name: 'forge-b' }, { name: 'other' }] })
    const { runner } = createRecordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual(['forge-a', 'forge-b'])
  })

  test('listSandboxesByPrefix returns [] on a failing ls', async () => {
    const { runner } = createRecordingRunner(() => { throw new Error('boom') })
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual([])
  })

  test('removeSandbox runs the delete vector and tolerates a not-found failure', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: '', stderr: 'no such machine forge-a', exitCode: 1 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
    expect(calls[0].args).toEqual(['machine', 'delete', '--name', 'forge-a', '-f'])
  })

  test('removeSandbox throws on an unexpected failure', async () => {
    const { runner } = createRecordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createSmolvmRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox: permission denied')
  })

  test('allowNetworkHost logs a note and returns true (egress is applied per machine at create time)', async () => {
    const log = vi.fn()
    const rt = createSmolvmRuntime({ ...logger, log })
    await expect(rt.allowNetworkHost('db.internal')).resolves.toBe(true)
    expect(log).toHaveBeenCalled()
  })

  test('sandboxContainerName is exposed on the runtime', () => {
    const rt = createSmolvmRuntime(logger)
    expect(rt.sandboxContainerName('feature/test')).toBe('forge-feature-test')
  })
})
