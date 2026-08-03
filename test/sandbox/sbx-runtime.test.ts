import { describe, test, expect, vi } from 'vitest'
import {
  sanitizeSbxName,
  sandboxContainerName,
  buildSbxExecArgs,
  parseSbxCpus,
  normalizeSbxMemory,
  buildSbxCreateArgs,
  parseSbxSandboxList,
  parseSbxTemplateList,
  sbxTemplateMatches,
  checkSbxAvailability,
  describeSbxUnavailable,
  createSbxRuntime,
} from '../../src/sandbox/sbx'
import type { CommandRunner } from '../../src/sandbox/sbx'
import type { Logger } from '../../src/types'

const logger: Logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('sandbox name', () => {
  test('replaces disallowed characters like the old Docker driver rejected slashes', () => {
    expect(sandboxContainerName('feature/test-123')).toBe('forge-feature-test-123')
  })

  test('passes an already-sanitized loop name through unchanged', () => {
    expect(sandboxContainerName('my-worktree')).toBe('forge-my-worktree')
  })

  test('empty input yields forge-sandbox', () => {
    expect(sandboxContainerName('')).toBe('forge-sandbox')
  })

  test('truncates a long loop name to <= 66 chars with no trailing hyphen', () => {
    const long = 'a'.repeat(120)
    const name = sandboxContainerName(long)
    expect(name.length).toBeLessThanOrEqual(66)
    expect(name.endsWith('-')).toBe(false)
    expect(name.startsWith('forge-')).toBe(true)
  })

  test('collapses runs of disallowed characters and strips edge separators', () => {
    expect(sanitizeSbxName('  My_Work!  ')).toBe('my-work')
  })
})

describe('exec args', () => {
  test('emits the minimal exec vector', () => {
    expect(buildSbxExecArgs('forge-c', 'ls')).toEqual(['exec', 'forge-c', 'sh', '-c', 'ls'])
  })

  test('emits each flag only when its option is set', () => {
    expect(buildSbxExecArgs('forge-c', 'ls', { interactive: true, envFile: '/e.env', workdir: '/w' })).toEqual([
      'exec',
      '-i',
      '--env-file',
      '/e.env',
      '-w',
      '/w',
      'forge-c',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('omits flags whose option is undefined or empty', () => {
    expect(buildSbxExecArgs('forge-c', 'ls', { user: '', envFile: '', workdir: '' })).toEqual([
      'exec',
      'forge-c',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('includes -u when a user is given', () => {
    expect(buildSbxExecArgs('forge-c', 'ls', { user: '1000:1000' })).toEqual([
      'exec',
      '-u',
      '1000:1000',
      'forge-c',
      'sh',
      '-c',
      'ls',
    ])
  })
})

describe('create args', () => {
  test('emits the base vector for one read-write workspace', () => {
    expect(buildSbxCreateArgs('forge-c', [{ hostDir: '/work' }])).toEqual([
      'create',
      'shell',
      '--quiet',
      '--name',
      'forge-c',
      '/work',
    ])
  })

  test('suffixes read-only workspaces with :ro and leaves read-write bare', () => {
    expect(
      buildSbxCreateArgs('forge-c', [{ hostDir: '/work' }, { hostDir: '/proj', readOnly: true }]),
    ).toEqual([
      'create',
      'shell',
      '--quiet',
      '--name',
      'forge-c',
      '/work',
      '/proj:ro',
    ])
  })

  test('includes template, memory and cpus flags when present', () => {
    expect(
      buildSbxCreateArgs('forge-c', [{ hostDir: '/work' }], { template: 't1', memory: '8g', cpus: 4 }),
    ).toEqual([
      'create',
      'shell',
      '--quiet',
      '--name',
      'forge-c',
      '--template',
      't1',
      '--memory',
      '8g',
      '--cpus',
      '4',
      '/work',
    ])
  })

  test('throws on an empty workspace array', () => {
    expect(() => buildSbxCreateArgs('forge-c', [])).toThrow('requires at least one workspace')
  })
})

describe('resource coercion', () => {
  test('parseSbxCpus returns the floored integer for whole and fractional input', () => {
    expect(parseSbxCpus('4', logger)).toBe(4)
    expect(parseSbxCpus('2.5', logger)).toBe(2)
  })

  test('parseSbxCpus logs when rounding a fractional value', () => {
    const log = vi.fn()
    parseSbxCpus('2.5', { ...logger, log })
    expect(log).toHaveBeenCalledWith(
      'Sandbox: sbx --cpus is integer-only; rounding cpus="2.5" down to 2',
    )
  })

  test('parseSbxCpus returns undefined for non-numeric input', () => {
    expect(parseSbxCpus('abc', logger)).toBeUndefined()
    expect(parseSbxCpus(undefined, logger)).toBeUndefined()
  })

  test('normalizeSbxMemory passes lowercased value without trailing b', () => {
    expect(normalizeSbxMemory('8g', logger)).toBe('8g')
    expect(normalizeSbxMemory('8GB', logger)).toBe('8g')
    expect(normalizeSbxMemory('1024m', logger)).toBe('1024m')
  })

  test('normalizeSbxMemory returns undefined for unrecognized input', () => {
    expect(normalizeSbxMemory('lots', logger)).toBeUndefined()
    expect(normalizeSbxMemory(undefined, logger)).toBeUndefined()
  })
})

describe('sandbox list', () => {
  test('empty output yields an empty array without throwing', () => {
    expect(parseSbxSandboxList('')).toEqual([])
  })

  test('malformed JSON yields an empty array without throwing', () => {
    expect(parseSbxSandboxList('not json {')).toEqual([])
  })

  test('the observed {"sandboxes":[]} shape yields an empty array', () => {
    expect(parseSbxSandboxList('{"sandboxes":[]}')).toEqual([])
  })

  test('maps running status to true and stopped to false', () => {
    const stdout = JSON.stringify({
      sandboxes: [
        { name: 'forge-a', status: 'running' },
        { name: 'forge-b', status: 'stopped' },
      ],
    })
    expect(parseSbxSandboxList(stdout)).toEqual([
      { name: 'forge-a', status: 'running', running: true },
      { name: 'forge-b', status: 'stopped', running: false },
    ])
  })

  test('accepts a bare array fallback', () => {
    const stdout = JSON.stringify([
      { name: 'forge-a', status: 'running' },
      { name: 'forge-b', status: 'stopped' },
    ])
    expect(parseSbxSandboxList(stdout)).toEqual([
      { name: 'forge-a', status: 'running', running: true },
      { name: 'forge-b', status: 'stopped', running: false },
    ])
  })

  test('treats exited, creating, empty and missing status as not running', () => {
    expect(parseSbxSandboxList(JSON.stringify([{ name: 'a', status: 'exited' }]))[0].running).toBe(false)
    expect(parseSbxSandboxList(JSON.stringify([{ name: 'a', status: 'creating' }]))[0].running).toBe(false)
    expect(parseSbxSandboxList(JSON.stringify([{ name: 'a', status: '' }]))[0].running).toBe(false)
    expect(parseSbxSandboxList(JSON.stringify([{ name: 'a' }]))[0].running).toBe(false)
  })

  test('drops entries without a non-empty name', () => {
    const stdout = JSON.stringify([{ name: '', status: 'running' }, { status: 'running' }])
    expect(parseSbxSandboxList(stdout)).toEqual([])
  })
})

describe('template list', () => {
  const fixture = [
    'REPOSITORY                       TAG        IMAGE ID     FLAVOR      CREATED',
    'docker.io/docker/sandbox-templates shell-docker e0c0544e2109 shell-docker 3 months ago',
    'oc-forge-sandbox                 latest     a1b2c3d4e5f6 shell-docker 3 weeks ago',
  ].join('\n')

  const registryFixture = [
    'REPOSITORY                              TAG      IMAGE ID     FLAVOR      CREATED',
    'docker.io/library/oc-forge-sandbox      latest   a1b2c3d4e5f6 shell-docker 3 weeks ago',
  ].join('\n')

  test('never emits the header row as an entry', () => {
    const entries = parseSbxTemplateList(fixture)
    expect(entries).not.toEqual(expect.arrayContaining([{ repository: 'REPOSITORY', tag: 'TAG' }]))
    expect(entries).toHaveLength(2)
  })

  test('matches a bare repository with an explicit matching tag', () => {
    expect(sbxTemplateMatches(parseSbxTemplateList(fixture), 'oc-forge-sandbox:latest')).toBe(true)
  })

  test('matches a registry-qualified repository ending in /name', () => {
    expect(sbxTemplateMatches(parseSbxTemplateList(registryFixture), 'oc-forge-sandbox:latest')).toBe(
      true,
    )
  })

  test('does not match a different tag', () => {
    expect(sbxTemplateMatches(parseSbxTemplateList(fixture), 'oc-forge-sandbox:other')).toBe(false)
  })

  test('treats a ref with no explicit tag as :latest', () => {
    expect(sbxTemplateMatches(parseSbxTemplateList(fixture), 'oc-forge-sandbox')).toBe(true)
  })

  test('skips blank lines and lines with fewer than two fields', () => {
    const entries = parseSbxTemplateList('oc-forge-sandbox   latest\n\nREPOSITORY   TAG\n')
    expect(entries).toEqual([{ repository: 'oc-forge-sandbox', tag: 'latest' }])
  })
})

describe('availability', () => {
  test('a running daemon yields available', async () => {
    const fake: CommandRunner = async () => ({ stdout: 'Status: running\n', stderr: '', exitCode: 0 })
    await expect(checkSbxAvailability(fake)).resolves.toEqual({ available: true })
  })

  test('a missing CLI yields not-installed from an ENOENT spawn', async () => {
    const fake: CommandRunner = async () => ({ stdout: '', stderr: 'spawn sbx ENOENT', exitCode: 1 })
    await expect(checkSbxAvailability(fake)).resolves.toEqual({
      available: false,
      reason: 'not-installed',
    })
  })

  test('a stopped daemon yields daemon-down with trimmed detail', async () => {
    const fake: CommandRunner = async () => ({
      stdout: '',
      stderr: 'daemon not running\n',
      exitCode: 1,
    })
    const result = await checkSbxAvailability(fake)
    expect(result).toMatchObject({ available: false, reason: 'daemon-down' })
    if (!result.available) expect(result.detail).toBe('daemon not running')
  })

  test('a rejecting runner yields unknown', async () => {
    const fake: CommandRunner = async () => {
      throw new Error('boom')
    }
    await expect(checkSbxAvailability(fake)).resolves.toEqual({ available: false, reason: 'unknown' })
  })

  test('passes a 5000ms timeout to the runner', async () => {
    const optsSeen: Array<{ timeout?: number }> = []
    const fake: CommandRunner = async (_args, opts) => {
      optsSeen.push(opts ?? {})
      return { stdout: 'Status: running\n', stderr: '', exitCode: 0 }
    }
    await checkSbxAvailability(fake)
    expect(optsSeen[0]?.timeout).toBe(5000)
  })

  test('describeSbxUnavailable carries the remediation strings', () => {
    expect(describeSbxUnavailable({ available: false, reason: 'not-installed' })).toMatch(/sbx login/)
    expect(describeSbxUnavailable({ available: false, reason: 'daemon-down' })).toMatch(/sbx daemon start/)
    expect(describeSbxUnavailable({ available: false, reason: 'unknown', detail: 'x' })).toMatch(/x/)
  })
})

describe('runtime', () => {
  interface Rec {
    args: string[]
    opts?: { timeout?: number; stdin?: string }
  }
  function recordingRunner(handler?: (rec: Rec) => { stdout: string; stderr: string; exitCode: number }) {
    const calls: Rec[] = []
    const runner: CommandRunner = async (args, opts) => {
      const rec = { args, opts: { timeout: opts?.timeout, stdin: opts?.stdin } }
      calls.push(rec)
      const res = handler ? handler(rec) : { stdout: '', stderr: '', exitCode: 0 }
      return res
    }
    return { calls, runner }
  }

  test('exec with cwd prefixes the command with cd and records args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createSbxRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { cwd: "/w/it's" })
    expect(calls[0].args).toEqual([
      'exec',
      'forge-c',
      'sh',
      '-c',
      "cd '/w/it'\\''s' && ls",
    ])
  })

  test('exec passes envFile and timeout to the runner', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createSbxRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { envFile: '/e.env', timeout: 3000 })
    expect(calls[0].args).toContain('--env-file')
    expect(calls[0].opts?.timeout).toBe(3000)
  })

  test('execPipe sets interactive and passes stdin through', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createSbxRuntime(logger, { run: runner })
    await rt.execPipe('forge-c', 'cat', 'hello')
    expect(calls[0].args.slice(0, 3)).toEqual(['exec', '-i', 'forge-c'])
    expect(calls[0].opts?.stdin).toBe('hello')
  })

  test('createSandbox builds create args with coerced resources', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createSbxRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work' }], {
      template: 't1',
      resources: { memory: '8GB', cpus: '2.5' },
    })
    expect(calls[0].args).toEqual([
      'create', 'shell', '--quiet', '--name', 'forge-c',
      '--template', 't1', '--memory', '8g', '--cpus', '2', '/work',
    ])
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('createSandbox throws on non-zero exit', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.createSandbox('forge-c', [{ hostDir: '/work' }])).rejects.toThrow(
      'Failed to create sandbox: boom',
    )
  })

  test('removeSandbox records rm --force', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createSbxRuntime(logger, { run: runner })
    await rt.removeSandbox('forge-a')
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a'])
  })

  test('removeSandbox tolerates a not-found failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'no such sandbox forge-a', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
  })

  test('removeSandbox throws on an unexpected failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
  })

  test('getSandboxState reports running, and missing for an absent name', async () => {
    const stdout = JSON.stringify({ sandboxes: [{ name: 'forge-a', status: 'running' }] })
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('running')
    await expect(rt.getSandboxState('forge-b')).resolves.toBe('missing')
  })

  test('getSandboxState reports an idle-suspended sandbox as stopped, not missing', async () => {
    const stdout = JSON.stringify({ sandboxes: [{ name: 'forge-a', status: 'stopped' }] })
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('stopped')
  })

  test('getSandboxState reports unknown on a failing ls rather than claiming missing', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown when the ls invocation throws', async () => {
    const { runner } = recordingRunner(() => { throw new Error('sbx exploded') })
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown when a successful ls emits unparseable output', async () => {
    // A truncated or schema-changed payload must never be read as "the sandbox is gone",
    // or the caller would destroy or duplicate a live sandbox.
    const { runner } = recordingRunner(() => ({ stdout: '{"sandboxes":[{"name":"forg', stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown for valid JSON in an unrecognized shape', async () => {
    // An error object or a future nested schema is a failed inventory read, not an empty inventory
    const { runner } = recordingRunner(() => ({ stdout: JSON.stringify({ error: 'daemon down' }), stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown for a valid JSON scalar', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '123', stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports missing when a successful ls returns an empty list', async () => {
    const { runner } = recordingRunner(() => ({ stdout: JSON.stringify({ sandboxes: [] }), stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('missing')
  })

  test('getSandboxState treats empty output as an empty list so a missing sandbox can still be created', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('missing')
  })

  test('listSandboxesByPrefix filters parsed names by prefix', async () => {
    const stdout = JSON.stringify({
      sandboxes: [
        { name: 'forge-a', status: 'running' },
        { name: 'forge-b', status: 'stopped' },
        { name: 'other', status: 'running' },
      ],
    })
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual(['forge-a', 'forge-b'])
  })

  test('listSandboxesByPrefix returns [] on a failing ls', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual([])
  })

  test('templateExists matches parsed template list', async () => {
    const stdout = ['REPOSITORY TAG', 'oc-forge-sandbox latest'].join('\n')
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.templateExists('oc-forge-sandbox:latest')).resolves.toBe(true)
    await expect(rt.templateExists('oc-forge-sandbox:other')).resolves.toBe(false)
  })

  test('loadTemplate throws on non-zero exit', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'bad tar', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.loadTemplate('/tmp/t.tar')).rejects.toThrow('Failed to load sandbox template')
    expect(calls[0].args).toEqual(['template', 'load', '/tmp/t.tar'])
    expect(calls[0].opts?.timeout).toBe(600000)
  })

  test('checkAvailable proxies to checkSbxAvailability', async () => {
    const { runner } = recordingRunner(() => ({ stdout: 'Status: running\n', stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.checkAvailable()).resolves.toEqual({ available: true })
  })

  test('allowNetworkHost returns false on non-zero exit without throwing', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.allowNetworkHost('db.internal')).resolves.toBe(false)
    expect(calls[0].args).toEqual(['policy', 'allow', 'network', 'db.internal'])
  })

  test('allowNetworkHost returns true on success', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    const rt = createSbxRuntime(logger, { run: runner })
    await expect(rt.allowNetworkHost('db.internal')).resolves.toBe(true)
  })

  test('sandboxContainerName is exposed on the runtime', () => {
    const rt = createSbxRuntime(logger, { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    expect(rt.sandboxContainerName('feature/test')).toBe('forge-feature-test')
  })
})
