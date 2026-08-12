import { describe, test, expect, vi } from 'vitest'
import {
  sanitizeMsbName,
  sandboxContainerName,
  buildMsbExecArgs,
  parseMsbCpus,
  normalizeMsbMemory,
  buildMsbCreateArgs,
  buildNetworkAllow,
  parseMsbSandboxList,
  parseMsbSandboxListOrNull,
  mapMsbStatus,
  parseMsbImageList,
  msbImageMatches,
  parseMsbInspectSecretNames,
  checkMsbAvailability,
  describeMsbUnavailable,
  createMsbRuntime,
} from '../../src/sandbox/msb'
import type { CommandRunner, SandboxRuntime } from '../../src/sandbox/msb'
import { COMMAND_TIMEOUT_EXIT_CODE } from '../../src/sandbox/process'
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
    expect(sanitizeMsbName('  My_Work!  ')).toBe('my-work')
  })
})

describe('exec args', () => {
  test('emits the minimal exec vector with the -- separator', () => {
    expect(buildMsbExecArgs('forge-c', 'ls')).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('places -w and --timeout before the -- separator', () => {
    expect(buildMsbExecArgs('forge-c', 'ls', { workdir: '/w', timeoutMs: 30000 })).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '-w',
      '/w',
      '--timeout',
      '30s',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('emits -u when a user is given', () => {
    expect(buildMsbExecArgs('forge-c', 'ls', { user: '1000:1000' })).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '-u',
      '1000:1000',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('omits flags whose option is unset', () => {
    expect(buildMsbExecArgs('forge-c', 'ls', {})).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('rounds timeout milliseconds up to whole seconds', () => {
    expect(buildMsbExecArgs('forge-c', 'ls', { timeoutMs: 1500 })).toContain('--timeout')
    expect(buildMsbExecArgs('forge-c', 'ls', { timeoutMs: 1500 })).toContain('2s')
  })
})

describe('create args', () => {
  test('emits the base vector with image positional after create', () => {
    expect(buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], { image: 'oc-forge-sandbox:latest' })).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
    ])
  })

  test('suffixes read-only workspaces with :ro and leaves read-write bare', () => {
    expect(
      buildMsbCreateArgs(
        'forge-c',
        [{ hostDir: '/a' }, { hostDir: '/b', readOnly: true }],
        { image: 'oc-forge-sandbox:latest' },
      ),
    ).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '-v',
      '/b:/b:ro',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
    ])
  })

  test('includes cpus and memory flags when present', () => {
    expect(
      buildMsbCreateArgs('forge-c', [{ hostDir: '/work' }], {
        image: 'oc-forge-sandbox:latest',
        memory: '8g',
        cpus: 4,
      }),
    ).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-c',
      '4',
      '-m',
      '8g',
      '-v',
      '/work:/work',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
    ])
  })

  test('emits deny-by-default network flags plus one allow rule per non-blank host', () => {
    expect(
      buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
        image: 'oc-forge-sandbox:latest',
        networkAllow: ['github.com', ' '],
      }),
    ).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
      '--net-rule',
      'allow@github.com',
    ])
  })

  test('emits bare -e flags for env names and never inlines a value', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['GITHUB_TOKEN', 'CI'],
    })
    expect(args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
      '-e',
      'GITHUB_TOKEN',
      '-e',
      'CI',
    ])
    expect(args.join(' ')).not.toContain('GITHUB_TOKEN=')
  })

  test('drops env entries that are blank or contain an equals sign so no value enters argv', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['KEEP', 'GITHUB_TOKEN=secret', '  ', 'LEAK=value'],
    })
    expect(args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
      '-e',
      'KEEP',
    ])
    expect(args.join(' ')).not.toContain('secret')
    expect(args.join(' ')).not.toContain('value')
    expect(args.join(' ')).not.toContain('=')
  })

  test('trims whitespace around env names before emitting -e', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: [' GITHUB_TOKEN '],
    })
    expect(args).toContain('-e')
    expect(args).toContain('GITHUB_TOKEN')
    expect(args).not.toContain(' GITHUB_TOKEN ')
  })

  test('emits one --secret env@hosts flag per secret with hosts joined by commas', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: 'GITHUB_TOKEN', hosts: ['api.github.com', '*.githubusercontent.com'] }],
    })
    expect(args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
      '--secret',
      'GITHUB_TOKEN@api.github.com,*.githubusercontent.com',
    ])
    expect(args.join(' ')).not.toContain('GITHUB_TOKEN=')
  })

  test('drops secrets with a blank env name, a value-bearing env name, or an empty host list', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [
        { env: 'KEEP', hosts: ['api.example.com'] },
        { env: 'NO_HOSTS', hosts: [] },
        { env: 'BLANK_HOSTS', hosts: ['  '] },
        { env: ' ', hosts: ['api.example.com'] },
        { env: 'GITHUB_TOKEN=super-secret', hosts: ['api.github.com'] },
      ],
    })
    expect(args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
      '--secret',
      'KEEP@api.example.com',
    ])
    expect(args.join(' ')).not.toContain('super-secret')
  })

  test('normalizes padded secret env names and hosts into the reference form', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: ' TOKEN ', hosts: [' api.example.com ', '*.github.com'] }],
    })
    expect(args).toContain('--secret')
    expect(args).toContain('TOKEN@api.example.com,*.github.com')
    expect(args).not.toContain(' TOKEN ')
  })

  test('no credential value appears in any argument vector produced by buildMsbCreateArgs', () => {
    const vector = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['GITHUB_TOKEN'],
      secrets: [{ env: 'NPM_TOKEN', hosts: ['registry.npmjs.org'] }],
    })
    // The bare `-e NAME` and `--secret ENV@HOST` reference forms never inline a value, so no
    // `NAME=VALUE` fragment can appear in the vector.
    expect(vector.join(' ')).not.toContain('=')
  })

  test('throws on an empty workspace array', () => {
    expect(() => buildMsbCreateArgs('forge-c', [], { image: 'x' })).toThrow(
      'requires at least one workspace',
    )
  })

  test('a host shared by allow and secrets emits exactly one matching --net-rule allow@host', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: buildNetworkAllow(
        ['api.github.com', 'pypi.org'],
        [{ env: 'GITHUB_TOKEN', hosts: ['api.github.com', '*.githubusercontent.com'] }],
      ),
      secrets: [{ env: 'GITHUB_TOKEN', hosts: ['api.github.com', '*.githubusercontent.com'] }],
    })
    // The union (via buildNetworkAllow) deduplicates api.github.com, so it is allowed once.
    expect(args.filter((a) => a === 'allow@api.github.com')).toHaveLength(1)
    expect(args).toContain('allow@pypi.org')
    expect(args).toContain('allow@*.githubusercontent.com')
    expect(args).toContain('--secret')
    expect(args).toContain('GITHUB_TOKEN@api.github.com,*.githubusercontent.com')
  })
})

describe('network allow union', () => {
  test('unions allow hosts with secret hosts, trims, drops blanks, and deduplicates', () => {
    expect(
      buildNetworkAllow(
        ['github.com', '  ', ''],
        [{ env: 'GITHUB_TOKEN', hosts: ['api.github.com', ' github.com '] }],
      ),
    ).toEqual(['github.com', 'api.github.com'])
  })

  test('returns just the allow list when no secrets are configured', () => {
    expect(buildNetworkAllow(['registry.npmjs.org'], undefined)).toEqual(['registry.npmjs.org'])
    expect(buildNetworkAllow(undefined, undefined)).toEqual([])
  })

  test('returns just the secret hosts when no allow list is configured', () => {
    expect(
      buildNetworkAllow(undefined, [{ env: 'NPM_TOKEN', hosts: ['registry.npmjs.org'] }]),
    ).toEqual(['registry.npmjs.org'])
  })

  test('drops hosts of misconfigured secrets that msb would refuse to bind', () => {
    expect(
      buildNetworkAllow(undefined, [
        { env: 'KEEP', hosts: ['api.example.com'] },
        { env: 'NO_HOSTS', hosts: [] },
        { env: 'A=B', hosts: ['api.example.com'] },
      ]),
    ).toEqual(['api.example.com'])
  })
})

describe('resource coercion', () => {
  test('parseMsbCpus returns the floored integer for whole and fractional input', () => {
    expect(parseMsbCpus('4', logger)).toBe(4)
    expect(parseMsbCpus('2.5', logger)).toBe(2)
  })

  test('parseMsbCpus logs when rounding a fractional value', () => {
    const log = vi.fn()
    parseMsbCpus('2.5', { ...logger, log })
    expect(log).toHaveBeenCalledWith(
      'Sandbox: msb --cpus is integer-only; rounding cpus="2.5" down to 2',
    )
  })

  test('parseMsbCpus returns undefined for non-numeric input', () => {
    expect(parseMsbCpus('abc', logger)).toBeUndefined()
    expect(parseMsbCpus(undefined, logger)).toBeUndefined()
  })

  test('normalizeMsbMemory passes lowercased value without trailing b', () => {
    expect(normalizeMsbMemory('8g', logger)).toBe('8g')
    expect(normalizeMsbMemory('8GB', logger)).toBe('8g')
    expect(normalizeMsbMemory('1024m', logger)).toBe('1024m')
  })

  test('normalizeMsbMemory returns undefined for unrecognized input', () => {
    expect(normalizeMsbMemory('lots', logger)).toBeUndefined()
    expect(normalizeMsbMemory(undefined, logger)).toBeUndefined()
  })
})

describe('sandbox list', () => {
  test('maps the canonical array form into running and stopped states', () => {
    const entries = parseMsbSandboxList(
      '[{"name":"forge-a","status":"Running"},{"name":"forge-b","status":"Stopped"}]',
    )
    expect(entries.map((e) => e.name)).toEqual(['forge-a', 'forge-b'])
    expect(entries.map((e) => e.state)).toEqual(['running', 'stopped'])
    expect(entries.map((e) => e.status)).toEqual(['Running', 'Stopped'])
  })

  test('empty output is a legitimately empty list', () => {
    expect(parseMsbSandboxListOrNull('')).toEqual([])
    expect(parseMsbSandboxListOrNull('   ')).toEqual([])
  })

  test('unparseable output returns null so the caller reports unknown', () => {
    expect(parseMsbSandboxListOrNull('not json')).toBeNull()
  })

  test('valid JSON in a non-array shape returns null', () => {
    expect(parseMsbSandboxListOrNull('{"error":"x"}')).toBeNull()
    expect(parseMsbSandboxListOrNull('{"sandboxes":[]}')).toBeNull()
  })

  test('parseMsbSandboxList falls back to an empty list when parsing fails', () => {
    expect(parseMsbSandboxList('{"error":"x"}')).toEqual([])
  })

  test('drops entries without a non-empty string name', () => {
    const entries = parseMsbSandboxList(
      '[{"status":"Running"},{"name":""},{"name":"forge-c","status":"Paused"}]',
    )
    expect(entries.map((e) => e.name)).toEqual(['forge-c'])
  })

  test('mapMsbStatus classifies only msb-executable statuses as running or stopped', () => {
    expect(mapMsbStatus('Running')).toBe('running')
    expect(mapMsbStatus('Stopped')).toBe('stopped')
    expect(mapMsbStatus('Crashed')).toBe('stopped')
  })

  test('mapMsbStatus maps non-executable and unrecognized statuses to unknown', () => {
    expect(mapMsbStatus('Starting')).toBe('unknown')
    expect(mapMsbStatus('Draining')).toBe('unknown')
    expect(mapMsbStatus('Created')).toBe('unknown')
    expect(mapMsbStatus('Paused')).toBe('unknown')
    expect(mapMsbStatus('Suspended')).toBe('unknown')
    expect(mapMsbStatus('')).toBe('unknown')
  })
})

describe('image list', () => {
  test('returns the reference strings from the canonical array form', () => {
    expect(
      parseMsbImageList(
        '[{"reference":"docker.io/library/oc-forge-sandbox:latest","digest":"sha256:abc"}]',
      ),
    ).toEqual(['docker.io/library/oc-forge-sandbox:latest'])
  })

  test('returns an empty list on parse failure', () => {
    expect(parseMsbImageList('not json')).toEqual([])
  })

  test('returns an empty list for a non-array payload', () => {
    expect(parseMsbImageList('{"error":"x"}')).toEqual([])
  })

  test('drops entries without a non-empty string reference', () => {
    expect(parseMsbImageList('[{"digest":"x"},{"reference":""},{"reference":"a:latest"}]')).toEqual([
      'a:latest',
    ])
  })

  test('msbImageMatches matches a bare name against a registry-qualified reference', () => {
    expect(
      msbImageMatches(['docker.io/library/oc-forge-sandbox:latest'], 'oc-forge-sandbox:latest'),
    ).toBe(true)
  })

  test('msbImageMatches rejects a tag mismatch', () => {
    expect(msbImageMatches(['docker.io/library/oc-forge-sandbox:latest'], 'oc-forge-sandbox:v2')).toBe(
      false,
    )
  })

  test('msbImageMatches treats a tagless ref as latest and an exact repository as a match', () => {
    expect(msbImageMatches(['oc-forge-sandbox:latest'], 'oc-forge-sandbox')).toBe(true)
    expect(msbImageMatches(['oc-forge-sandbox:latest'], 'oc-forge-sandbox:v1')).toBe(false)
    expect(msbImageMatches([], 'oc-forge-sandbox:latest')).toBe(false)
  })

  test('msbImageMatches does not mistake a registry port for a tag separator', () => {
    expect(msbImageMatches(['localhost:5000/oc-forge-sandbox:latest'], 'localhost:5000/oc-forge-sandbox')).toBe(
      true,
    )
  })

  test('msbImageMatches honors explicit tags on port-qualified registries', () => {
    expect(msbImageMatches(['localhost:5000/oc-forge-sandbox:latest'], 'localhost:5000/oc-forge-sandbox:latest')).toBe(
      true,
    )
    expect(msbImageMatches(['localhost:5000/oc-forge-sandbox:latest'], 'localhost:5000/oc-forge-sandbox:v2')).toBe(
      false,
    )
  })

  test('msbImageMatches treats a port-qualified registry as part of the repository', () => {
    // The registry authority is not interchangeable: only the exact repository (or a bare
    // trailing-repository match) passes, so the port never leaks into tag comparison.
    expect(msbImageMatches(['localhost:5000/oc-forge-sandbox:latest'], 'localhost:5000/other:latest')).toBe(
      false,
    )
    expect(msbImageMatches(['localhost:5000/oc-forge-sandbox:latest'], 'other-registry.io/oc-forge-sandbox:latest')).toBe(
      false,
    )
  })
})

describe('inspect secret parsing', () => {
  test('extracts the bound secret env names from inspect output', () => {
    const stdout = JSON.stringify({
      name: 'forge-c',
      status: 'Running',
      config: { network: { secrets: { secrets: [{ env_var: 'A_TOKEN' }, { env_var: 'B_TOKEN' }] } } },
    })
    expect(parseMsbInspectSecretNames(stdout)).toEqual(['A_TOKEN', 'B_TOKEN'])
  })

  test('returns an empty list when no secrets are bound', () => {
    const stdout = JSON.stringify({ name: 'forge-c', status: 'Running', config: { network: {} } })
    expect(parseMsbInspectSecretNames(stdout)).toEqual([])
  })

  test('returns null for unparseable or malformed output so callers fail closed', () => {
    expect(parseMsbInspectSecretNames('not json')).toBeNull()
    expect(parseMsbInspectSecretNames('[]')).toBeNull()
    expect(parseMsbInspectSecretNames('{"config":{}}')).toBeNull()
    expect(
      parseMsbInspectSecretNames(
        JSON.stringify({ config: { network: { secrets: { secrets: 'x' } } } }),
      ),
    ).toBeNull()
  })
})

describe('availability', () => {
  test('a passing doctor check yields available', async () => {
    const fake: CommandRunner = async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 })
    await expect(checkMsbAvailability(fake)).resolves.toEqual({ available: true })
  })

  test('a missing CLI yields not-installed from an ENOENT spawn', async () => {
    const fake: CommandRunner = async () => ({ stdout: '', stderr: 'spawn msb ENOENT', exitCode: 1 })
    await expect(checkMsbAvailability(fake)).resolves.toEqual({
      available: false,
      reason: 'not-installed',
    })
  })

  test('a host that cannot run microVMs yields host-unsupported with trimmed detail', async () => {
    const fake: CommandRunner = async () => ({
      stdout: '',
      stderr: '/dev/kvm not found\n',
      exitCode: 1,
    })
    const result = await checkMsbAvailability(fake)
    expect(result).toMatchObject({ available: false, reason: 'host-unsupported' })
    if (!result.available) expect(result.detail).toBe('/dev/kvm not found')
  })

  test('a rejecting runner yields unknown', async () => {
    const fake: CommandRunner = async () => {
      throw new Error('boom')
    }
    await expect(checkMsbAvailability(fake)).resolves.toEqual({ available: false, reason: 'unknown' })
  })

  test('a timed-out probe yields unknown with a detail naming the bound', async () => {
    const fake: CommandRunner = async () => ({
      stdout: '',
      stderr: '',
      exitCode: COMMAND_TIMEOUT_EXIT_CODE,
    })
    const result = await checkMsbAvailability(fake)
    expect(result).toMatchObject({ available: false, reason: 'unknown' })
    if (!result.available) expect(result.detail).toMatch(/did not answer within 30000ms/)
  })

  test('passes a 30000ms timeout to the runner', async () => {
    const optsSeen: Array<{ timeout?: number }> = []
    const fake: CommandRunner = async (_args, opts) => {
      optsSeen.push(opts ?? {})
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    }
    await checkMsbAvailability(fake)
    expect(optsSeen[0]?.timeout).toBe(30000)
  })

  test('describeMsbUnavailable carries the remediation strings without a login step', () => {
    expect(describeMsbUnavailable({ available: false, reason: 'not-installed' })).toMatch(
      /install\.microsandbox\.dev/,
    )
    expect(describeMsbUnavailable({ available: false, reason: 'host-unsupported' })).toMatch(
      /msb doctor/,
    )
    expect(describeMsbUnavailable({ available: false, reason: 'unknown', detail: 'x' })).toMatch(/x/)
  })
})

describe('runtime', () => {
  interface Rec {
    args: string[]
    opts?: { timeout?: number; stdin?: string; abort?: AbortSignal }
  }
  function recordingRunner(handler?: (rec: Rec) => { stdout: string; stderr: string; exitCode: number }) {
    const calls: Rec[] = []
    const runner: CommandRunner = async (args, opts) => {
      const rec = { args, opts: { timeout: opts?.timeout, stdin: opts?.stdin, abort: opts?.abort } }
      calls.push(rec)
      const res = handler ? handler(rec) : { stdout: '', stderr: '', exitCode: 0 }
      return res
    }
    return { calls, runner }
  }

  test('exec maps cwd and default timeout into native flags with no cd prefix', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { cwd: '/w' })
    expect(calls[0].args).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '-w',
      '/w',
      '--timeout',
      '120s',
      '--',
      'sh',
      '-c',
      'ls',
    ])
    expect(calls[0].args.join(' ')).not.toContain("cd '/w' &&")
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('exec passes an explicit timeout and abort through to the runner', async () => {
    const abort = new AbortController().signal
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { timeout: 3000, cwd: '/w', abort })
    expect(calls[0].args).toContain('--timeout')
    expect(calls[0].args).toContain('3s')
    expect(calls[0].opts?.timeout).toBe(3000)
    expect(calls[0].opts?.abort).toBe(abort)
  })

  test('exec omits the -w flag when no cwd is given', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls')
    expect(calls[0].args).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '--timeout',
      '120s',
      '--',
      'sh',
      '-c',
      'ls',
    ])
  })

  test('createSandbox builds create args with the image and coerced resources', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      resources: { memory: '8GB', cpus: '2.5' },
    })
    expect(calls[0].args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-c',
      '2',
      '-m',
      '8g',
      '-v',
      '/work:/work',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@dns',
    ])
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('createSandbox forwards networkAllow into the create args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: ['github.com', ' '],
    })
    expect(calls[0].args).toContain('--net-default')
    expect(calls[0].args).toContain('allow@github.com')
    expect(calls[0].args).not.toContain('allow@ ')
  })

  test('createSandbox forwards env and secrets into the create args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['GITHUB_TOKEN'],
      secrets: [{ env: 'API_KEY', hosts: ['api.example.com'] }],
    })
    expect(calls[0].args).toContain('-e')
    expect(calls[0].args).toContain('GITHUB_TOKEN')
    expect(calls[0].args).toContain('--secret')
    expect(calls[0].args).toContain('API_KEY@api.example.com')
    expect(calls[0].args.join(' ')).not.toContain('=')
  })

  test('createSandbox throws on non-zero exit', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-c', [{ hostDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).rejects.toThrow('Failed to create sandbox: boom')
  })

  test('removeSandbox records rm --force --quiet', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.removeSandbox('forge-a')
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a', '--quiet'])
  })

  test('removeSandbox tolerates a not-found failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'no such sandbox forge-a', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
  })

  test('removeSandbox throws on an unexpected failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
  })

  test('getSandboxState reports running, stopped for a Crashed entry, unknown for a non-executable entry, and missing for an absent name', async () => {
    const stdout = JSON.stringify([
      { name: 'forge-a', status: 'Running' },
      { name: 'forge-b', status: 'Crashed' },
      { name: 'forge-d', status: 'Starting' },
      { name: 'forge-e', status: 'Draining' },
    ])
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('running')
    await expect(rt.getSandboxState('forge-b')).resolves.toBe('stopped')
    // `Starting` and `Draining` both reject new exec calls, so neither is adopted as usable.
    await expect(rt.getSandboxState('forge-d')).resolves.toBe('unknown')
    await expect(rt.getSandboxState('forge-e')).resolves.toBe('unknown')
    await expect(rt.getSandboxState('forge-c')).resolves.toBe('missing')
  })

  test('getSandboxState reports unknown on a failing ls rather than claiming missing', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown when the ls invocation throws', async () => {
    const { runner } = recordingRunner(() => { throw new Error('msb exploded') })
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown when a successful ls emits unparseable output', async () => {
    // A truncated or schema-changed payload must never be read as "the sandbox is gone",
    // or the caller would destroy or duplicate a live sandbox.
    const { runner } = recordingRunner(() => ({ stdout: '[{"name":"forge-', stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports unknown for valid JSON in a non-array shape', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '{"error":"x"}', stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('unknown')
  })

  test('getSandboxState reports missing when a successful ls returns an empty list', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '[]', stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('missing')
  })

  test('getSandboxState treats empty output as an empty list so a missing sandbox can still be created', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('missing')
  })

  test('listSandboxesByPrefix filters parsed names by prefix', async () => {
    const stdout = JSON.stringify([
      { name: 'forge-a', status: 'Running' },
      { name: 'forge-b', status: 'Stopped' },
      { name: 'other', status: 'Running' },
    ])
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual(['forge-a', 'forge-b'])
  })

  test('listSandboxesByPrefix returns [] on a failing ls', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.listSandboxesByPrefix('forge-')).resolves.toEqual([])
  })

  function inspectStdout(bound: string[]): string {
    return JSON.stringify({
      name: 'forge-c',
      status: 'Running',
      config: {
        network: {
          secrets: bound.length === 0
            ? undefined
            : { secrets: bound.map((envVar) => ({ env_var: envVar })) },
        },
      },
    })
  }

  function refreshRunner(bound: string[]) {
    return recordingRunner((rec) =>
      rec.args[0] === 'inspect'
        ? { stdout: inspectStdout(bound), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )
  }

  test('refreshSandboxSecrets reads the bound set and converges msb modify to the desired set', async () => {
    const { calls, runner } = refreshRunner(['STALE_TOKEN', 'KEEP'])
    const rt = createMsbRuntime(logger, { run: runner })
    const ok = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
      { env: 'NPM_TOKEN', hosts: ['registry.npmjs.org'] },
    ])
    expect(ok).toBe(true)
    expect(calls[0].args).toEqual(['inspect', 'forge-c', '--format', 'json'])
    expect(calls[0].opts?.timeout).toBe(30000)
    // NPM_TOKEN is a new placeholder, so the modification is restart-backed.
    expect(calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret-rm',
      'STALE_TOKEN',
      '--secret',
      'KEEP@api.example.com',
      '--secret',
      'NPM_TOKEN@registry.npmjs.org',
    ])
    expect(calls[1].opts?.timeout).toBe(30000)
  })

  test('refreshSandboxSecrets adds --restart only when introducing a new secret name', async () => {
    // Rotation of an existing name stays restart-free (msb applies it live).
    const rotation = refreshRunner(['KEEP'])
    const rt = createMsbRuntime(logger, { run: rotation.runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'KEEP', hosts: ['api.example.com'] }]),
    ).resolves.toBe(true)
    expect(rotation.calls[1].args).toEqual(['modify', 'forge-c', '--secret', 'KEEP@api.example.com'])

    // A new name is a placeholder addition, which msb classifies as restart-required.
    const added = refreshRunner(['KEEP'])
    const rt2 = createMsbRuntime(logger, { run: added.runner })
    await expect(
      rt2.refreshSandboxSecrets('forge-c', [
        { env: 'KEEP', hosts: ['api.example.com'] },
        { env: 'NEW_TOKEN', hosts: ['api.example.com'] },
      ]),
    ).resolves.toBe(true)
    expect(added.calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret',
      'KEEP@api.example.com',
      '--secret',
      'NEW_TOKEN@api.example.com',
    ])
  })

  test('refreshSandboxSecrets removes every bound secret when the desired list is empty', async () => {
    const { calls, runner } = refreshRunner(['A_TOKEN', 'B_TOKEN'])
    const rt = createMsbRuntime(logger, { run: runner })
    const ok = await rt.refreshSandboxSecrets('forge-c', [])
    expect(ok).toBe(true)
    // Removals apply live, so no --restart is needed.
    expect(calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--secret-rm',
      'A_TOKEN',
      '--secret-rm',
      'B_TOKEN',
    ])
    expect(calls[1].args).not.toContain('--restart')
  })

  test('refreshSandboxSecrets re-issues desired secrets so a rotated host value is re-read', async () => {
    const { calls, runner } = refreshRunner(['KEEP'])
    const rt = createMsbRuntime(logger, { run: runner })
    const ok = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
    ])
    expect(ok).toBe(true)
    // A matching name is not skipped: `--secret` re-binds it, picking up any rotated host value.
    expect(calls).toHaveLength(2)
    expect(calls[0].args[0]).toBe('inspect')
    expect(calls[1].args).toEqual(['modify', 'forge-c', '--secret', 'KEEP@api.example.com'])
  })

  test('refreshSandboxSecrets with an empty list and nothing bound never invokes msb modify', async () => {
    const { calls, runner } = refreshRunner([])
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.refreshSandboxSecrets('forge-c', [])).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0]).toBe('inspect')
    expect(calls.filter((c) => c.args[0] === 'modify')).toHaveLength(0)
  })

  test('refreshSandboxSecrets never inlines a secret value into any argument vector', async () => {
    const { calls, runner } = refreshRunner([])
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.refreshSandboxSecrets('forge-c', [{ env: 'GITHUB_TOKEN', hosts: ['api.github.com'] }])
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('GITHUB_TOKEN=')
      expect(call.args.join(' ')).not.toContain('=')
    }
  })

  test('refreshSandboxSecrets returns false when the inspect query fails or is unparseable', async () => {
    const failing = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: failing.runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toBe(false)

    const malformed = recordingRunner(() => ({ stdout: 'not json', stderr: '', exitCode: 0 }))
    const rt2 = createMsbRuntime(logger, { run: malformed.runner })
    await expect(
      rt2.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toBe(false)
  })

  test('refreshSandboxSecrets returns false when the runner throws', async () => {
    const { runner } = recordingRunner(() => { throw new Error('msb exploded') })
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toBe(false)
  })

  test('refreshSandboxSecrets skips misconfigured secrets like the create builder', async () => {
    const { calls, runner } = refreshRunner([])
    const rt = createMsbRuntime(logger, { run: runner })
    const ok = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
      { env: ' ', hosts: ['api.example.com'] },
      { env: 'GITHUB_TOKEN=super-secret', hosts: ['api.github.com'] },
      { env: 'NO_HOSTS', hosts: [] },
    ])
    expect(ok).toBe(true)
    // KEEP is a new name (nothing was bound), so the introduction is restart-backed.
    expect(calls[1].args).toEqual(['modify', 'forge-c', '--restart', '--secret', 'KEEP@api.example.com'])
    expect(calls[1].args.join(' ')).not.toContain('super-secret')
  })

  test('templateExists matches parsed image references', async () => {
    const stdout = JSON.stringify([{ reference: 'docker.io/library/oc-forge-sandbox:latest' }])
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.templateExists('oc-forge-sandbox:latest')).resolves.toBe(true)
    await expect(rt.templateExists('oc-forge-sandbox:other')).resolves.toBe(false)
  })

  test('templateExists returns false on a non-zero exit and on a throw', async () => {
    const failing = recordingRunner(() => ({ stdout: '', stderr: 'err', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: failing.runner })
    await expect(rt.templateExists('oc-forge-sandbox:latest')).resolves.toBe(false)

    const throwing = recordingRunner(() => { throw new Error('boom') })
    const rt2 = createMsbRuntime(logger, { run: throwing.runner })
    await expect(rt2.templateExists('oc-forge-sandbox:latest')).resolves.toBe(false)
  })

  test('loadTemplate records the input and tag flags with the load timeout', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.loadTemplate('/tmp/x.tar', 'oc-forge-sandbox:latest')
    expect(calls[0].args).toEqual(['load', '--input', '/tmp/x.tar', '--tag', 'oc-forge-sandbox:latest', '--quiet'])
    expect(calls[0].opts?.timeout).toBe(600000)
  })

  test('loadTemplate throws on non-zero exit with stderr', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'bad tar', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.loadTemplate('/tmp/x.tar', 'oc-forge-sandbox:latest')).rejects.toThrow(
      'Failed to load sandbox template: bad tar',
    )
  })

  test('checkAvailable proxies to checkMsbAvailability', async () => {
    const { runner } = recordingRunner(() => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.checkAvailable()).resolves.toEqual({ available: true })
  })

  test('sandboxContainerName is exposed on the runtime', () => {
    const rt = createMsbRuntime(logger, { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    expect(rt.sandboxContainerName('feature/test')).toBe('forge-feature-test')
  })

  test('the exported runtime interface has no execPipe or allowNetworkHost member', () => {
    const rt = createMsbRuntime(logger, { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    expect('execPipe' in rt).toBe(false)
    expect('allowNetworkHost' in rt).toBe(false)
    const contract: SandboxRuntime = rt
    expect(contract.exec).toBeInstanceOf(Function)
  })
})
