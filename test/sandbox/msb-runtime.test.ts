import { describe, test, expect, vi } from 'vitest'
import {
  sanitizeMsbName,
  sandboxContainerName,
  buildMsbExecArgs,
  parseMsbCpus,
  normalizeMsbSize,
  buildMsbCreateArgs,
  buildNetworkAllow,
  egressRestrictionRequested,
  dockerDataVolumeName,
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
      '--quiet',
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
      '--quiet',
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

  test('omits flags whose option is unset', () => {
    expect(buildMsbExecArgs('forge-c', 'ls', {})).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '--quiet',
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
    expect(buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], { image: 'oc-forge-sandbox:latest' })).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-v',
      '/a:/a',
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
    ])
  })

  test('never emits the allow@dns rule that msb 0.6.8 rejects', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], { image: 'oc-forge-sandbox:latest' })
    expect(args).not.toContain('allow@dns')
    expect(args.join(' ')).not.toContain('allow@dns')
  })

  test('suffixes read-only workspaces with :ro and leaves read-write bare', () => {
    expect(
      buildMsbCreateArgs(
        'forge-c',
        [{ hostDir: '/a', containerDir: '/a' }, { hostDir: '/b', containerDir: '/b', readOnly: true }],
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
    ])
  })

  test('includes cpus and memory flags when present', () => {
    expect(
      buildMsbCreateArgs('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
    ])
  })

  test('emits deny-by-default network flags plus one allow rule per non-blank host', () => {
    expect(
      buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--net-default',
      'deny',
      '--net-rule',
      'allow@github.com',
    ])
  })

  test('emits bare -e flags for env names and never inlines a value', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '-e',
      'GITHUB_TOKEN',
      '-e',
      'CI',
    ])
    expect(args.join(' ')).not.toContain('GITHUB_TOKEN=')
  })

  test('drops env entries that are blank or contain an equals sign so no value enters argv', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '-e',
      'KEEP',
    ])
    expect(args.join(' ')).not.toContain('secret')
    expect(args.join(' ')).not.toContain('value')
    expect(args.join(' ')).not.toContain('GITHUB_TOKEN=')
    expect(args.join(' ')).not.toContain('LEAK=')
  })

  test('trims whitespace around env names before emitting -e', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: [' GITHUB_TOKEN '],
    })
    expect(args).toContain('-e')
    expect(args).toContain('GITHUB_TOKEN')
    expect(args).not.toContain(' GITHUB_TOKEN ')
  })

  test('emits one --secret env@hosts flag per secret with hosts joined by commas', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--secret',
      'GITHUB_TOKEN@api.github.com,*.githubusercontent.com',
    ])
    expect(args.join(' ')).not.toContain('GITHUB_TOKEN=')
  })

  test('drops secrets with a blank env name, a value-bearing env name, or an empty host list', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--secret',
      'KEEP@api.example.com',
    ])
    expect(args.join(' ')).not.toContain('super-secret')
  })

  test('normalizes padded secret env names and hosts into the reference form', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: ' TOKEN ', hosts: [' api.example.com ', '*.github.com'] }],
    })
    expect(args).toContain('--secret')
    expect(args).toContain('TOKEN@api.example.com,*.github.com')
    expect(args).not.toContain(' TOKEN ')
  })

  test('no credential value appears in any argument vector produced by buildMsbCreateArgs', () => {
    const vector = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['GITHUB_TOKEN'],
      secrets: [{ env: 'NPM_TOKEN', hosts: ['registry.npmjs.org'] }],
    })
    // The bare `-e NAME` and `--secret ENV@HOST` reference forms never inline a value, so no
    // `NAME=VALUE` fragment can appear in the vector.
    expect(vector.join(' ')).not.toContain('GITHUB_TOKEN=')
    expect(vector.join(' ')).not.toContain('NPM_TOKEN=')
  })

  test('throws on an empty workspace array', () => {
    expect(() => buildMsbCreateArgs('forge-c', [], { image: 'x' })).toThrow(
      'requires at least one workspace',
    )
  })

  test('a host shared by allow and secrets emits exactly one matching --net-rule allow@host', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
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

  test('emits no net flags at all when no egress hosts are configured', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: [],
    })
    expect(args).not.toContain('--net-default')
    expect(args).not.toContain('--net-rule')
    expect(args.join(' ')).not.toContain('deny')
  })

  test('an all-invalid allow list keeps deny with no allow rules instead of silently widening to allow-all', () => {
    const log = vi.fn()
    const effective = buildNetworkAllow(['localhost', '*.com'], undefined, { ...logger, log })
    expect(effective).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: every configured egress host was rejected as invalid; sandbox egress is fully denied',
    )
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: effective,
      restrictEgress: true,
    })
    expect(args).toContain('--net-default')
    expect(args).toContain('deny')
    expect(args.filter((a) => a.startsWith('--net-rule'))).toHaveLength(0)
  })

  test('an allow-all wildcard emits no net flags at all', () => {
    const effective = buildNetworkAllow(['**'], undefined, logger)
    expect(effective).toEqual([])
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: effective,
      restrictEgress: egressRestrictionRequested(['**'], undefined),
    })
    expect(args).not.toContain('--net-default')
    expect(args.filter((a) => a.startsWith('--net-rule'))).toHaveLength(0)
    expect(args.join(' ')).not.toContain('deny')
  })

  test('a concrete allow-list entry still flips the sandbox to deny-by-default', () => {
    const effective = buildNetworkAllow(['api.github.com'], undefined, logger)
    expect(effective).toEqual(['api.github.com'])
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: effective,
      restrictEgress: egressRestrictionRequested(['api.github.com'], undefined),
    })
    expect(args).toContain('--net-default')
    expect(args).toContain('deny')
    expect(args).toContain('allow@api.github.com')
  })

  test('emits the docker data volume mount with a deterministic per-sandbox name', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
    })
    expect(args).toContain('--mount-named')
    expect(args).toContain('forge-c-docker-data:/var/lib/docker:kind=disk,size=16g')

    const other = buildMsbCreateArgs('forge-other', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
    })
    expect(other).toContain('forge-other-docker-data:/var/lib/docker:kind=disk,size=16g')
    expect(other).not.toContain('forge-c-docker-data:')
  })

  test('uses the configured docker disk size when provided', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      dockerDisk: '32g',
    })
    expect(args).toContain('forge-c-docker-data:/var/lib/docker:kind=disk,size=32g')
  })

  test('dockerDataVolumeName derives a stable per-container volume name', () => {
    expect(dockerDataVolumeName('forge-my-worktree')).toBe('forge-my-worktree-docker-data')
    expect(dockerDataVolumeName('Forge/C!')).toBe('forge-c-docker-data')
    expect(dockerDataVolumeName('forge-a')).not.toBe(dockerDataVolumeName('forge-b'))
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

  test('rejects a comma-laden host because a comma separates whole rule tokens', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['a.com,b.com'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "a.com,b.com": commas separate rule tokens, not hosts',
    )
  })

  test('rejects a port-qualified host that lacks the tcp/udp rule form', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['example.com:443'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "example.com:443": port-qualified hosts need the tcp/udp rule form',
    )
  })

  test('rejects a host containing the @ target separator', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['user@example.com'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "user@example.com": the @ character is reserved for rule targets',
    )
  })

  test('a bare * wildcard leaves egress unrestricted instead of being rejected as an invalid host', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['*'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith('Sandbox: wildcard allow-list leaves sandbox egress unrestricted')
    expect(log).not.toHaveBeenCalledWith(
      'Sandbox: skipping egress host "*": the bare wildcard is not a valid egress host',
    )
  })

  test('rejects a wildcard suffix with fewer than two labels', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['*.com'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "*.com": wildcard suffixes need at least two labels',
    )
  })

  test('rejects a bare single-label host that msb requires to be domain=-prefixed', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['barehost'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "barehost": bare single-label hosts are ambiguous; use domain=name',
    )
  })

  test('rejects a suffix= domain with fewer than two labels', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['suffix=com'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'Sandbox: skipping egress host "suffix=com": suffix= domains need at least two labels',
    )
  })

  test('applies the same rejection rules to secret destination hosts', () => {
    const log = vi.fn()
    expect(
      buildNetworkAllow(
        undefined,
        [{ env: 'KEEP', hosts: ['api.example.com', '*.com', 'bad,host'] }],
        { ...logger, log },
      ),
    ).toEqual(['api.example.com'])
    expect(log).toHaveBeenCalledTimes(2)
  })

  test('accepts a multi-label wildcard and the domain=/suffix= forms unchanged', () => {
    expect(
      buildNetworkAllow(['*.example.com', 'domain=myhost', 'suffix=example.com'], undefined, logger),
    ).toEqual(['*.example.com', 'domain=myhost', 'suffix=example.com'])
  })

  test('still unions, trims, and deduplicates when no logger is supplied', () => {
    expect(
      buildNetworkAllow(
        ['*.github.com', ' github.com ', '*.com'],
        [{ env: 'T', hosts: ['github.com', '*.com'] }],
      ),
    ).toEqual(['*.github.com', 'github.com'])
  })

  test('an allow-all wildcard short-circuits validation and leaves egress unrestricted', () => {
    const log = vi.fn()
    expect(buildNetworkAllow(['**'], undefined, { ...logger, log })).toEqual([])
    expect(log).toHaveBeenCalledWith('Sandbox: wildcard allow-list leaves sandbox egress unrestricted')
    expect(log).not.toHaveBeenCalledWith(
      'Sandbox: every configured egress host was rejected as invalid; sandbox egress is fully denied',
    )
  })

  test('an allow-all wildcard beats narrower entries in the same allow list', () => {
    expect(buildNetworkAllow(['*', 'api.github.com'], undefined, logger)).toEqual([])
  })

  test('a wildcard suffix stays a normal restricted allow-list entry', () => {
    expect(buildNetworkAllow(['*.github.com'], undefined, logger)).toEqual(['*.github.com'])
  })

  test('egressRestrictionRequested is false for an allow-all wildcard even with secret hosts', () => {
    expect(egressRestrictionRequested(['**'], undefined)).toBe(false)
    expect(egressRestrictionRequested(['**'], [{ env: 'TOKEN', hosts: ['api.github.com'] }])).toBe(false)
  })

  test('egressRestrictionRequested is false only when no host token is configured at all', () => {
    expect(egressRestrictionRequested(undefined, undefined)).toBe(false)
    expect(egressRestrictionRequested([], [])).toBe(false)
    expect(egressRestrictionRequested(['  ', ''], undefined)).toBe(false)
    expect(egressRestrictionRequested(undefined, [{ env: 'NO_HOSTS', hosts: [] }])).toBe(false)
  })

  test('egressRestrictionRequested is true for any configured token, valid or not', () => {
    expect(egressRestrictionRequested(['github.com'], undefined)).toBe(true)
    expect(egressRestrictionRequested(['localhost'], undefined)).toBe(true)
    expect(egressRestrictionRequested(undefined, [{ env: 'T', hosts: ['bad,host'] }])).toBe(true)
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

  test('normalizeMsbSize passes lowercased value without trailing b', () => {
    expect(normalizeMsbSize('8g', logger)).toBe('8g')
    expect(normalizeMsbSize('8GB', logger)).toBe('8g')
    expect(normalizeMsbSize('1024m', logger)).toBe('1024m')
  })

  test('normalizeMsbSize returns undefined for unrecognized input', () => {
    expect(normalizeMsbSize('lots', logger)).toBeUndefined()
    expect(normalizeMsbSize(undefined, logger)).toBeUndefined()
  })

  test('normalizeMsbSize applies to the docker disk size string as well', () => {
    expect(normalizeMsbSize('16g', logger)).toBe('16g')
    expect(normalizeMsbSize('32GB', logger)).toBe('32g')
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

  test('mapMsbStatus classifies all seven upstream msb variants', () => {
    expect(mapMsbStatus('Created')).toBe('transient')
    expect(mapMsbStatus('Starting')).toBe('transient')
    expect(mapMsbStatus('Running')).toBe('running')
    expect(mapMsbStatus('Draining')).toBe('transient')
    expect(mapMsbStatus('Paused')).toBe('transient')
    expect(mapMsbStatus('Stopped')).toBe('stopped')
    expect(mapMsbStatus('Crashed')).toBe('stopped')
  })

  test('mapMsbStatus keeps unrecognized statuses on the fail-closed unknown path', () => {
    expect(mapMsbStatus('Suspended')).toBe('unknown')
    expect(mapMsbStatus('')).toBe('unknown')
    expect(mapMsbStatus('Quarantined')).toBe('unknown')
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

  const alreadyExistsStderr =
    "error: sandbox already exists: sandbox 'forge-x' already exists; remove it, start the stopped sandbox, or recreate with .replace()"

  test('exec maps cwd and default timeout into native flags with no cd prefix', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.exec('forge-c', 'ls', { cwd: '/w' })
    expect(calls[0].args).toEqual([
      'exec',
      'forge-c',
      '--no-tty',
      '--quiet',
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
      '--quiet',
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
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
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
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
    ])
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('createSandbox forwards coerced boot ceilings as --max-cpus and --max-memory', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      resources: { memory: '2g', maxMemory: '16GB', cpus: '2', maxCpus: '8.5' },
    })
    expect(calls[0].args).toEqual([
      'create',
      'oc-forge-sandbox:latest',
      '--name',
      'forge-c',
      '--quiet',
      '-c',
      '2',
      '--max-cpus',
      '8',
      '-m',
      '2g',
      '--max-memory',
      '16g',
      '-v',
      '/work:/work',
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
    ])
  })

  test('createSandbox omits the boot ceilings when only one of them is configured', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      resources: { memory: '2g', maxMemory: '16g', cpus: '2' },
    })
    expect(calls[0].args).toContain('--max-memory')
    expect(calls[0].args).not.toContain('--max-cpus')
  })

  test('createSandbox drops unparsable boot ceilings instead of passing them to msb', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      resources: { memory: '2g', maxMemory: 'lots', cpus: '2', maxCpus: 'many' },
    })
    expect(calls[0].args).not.toContain('--max-memory')
    expect(calls[0].args).not.toContain('--max-cpus')
  })

  test('createSandbox forwards networkAllow into the create args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      networkAllow: ['github.com', ' '],
    })
    expect(calls[0].args).toContain('--net-default')
    expect(calls[0].args).toContain('allow@github.com')
    expect(calls[0].args).not.toContain('allow@ ')
  })

  test('createSandbox forwards restrictEgress and the docker disk size into the create args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      restrictEgress: true,
      resources: { dockerDisk: '32g' },
    })
    expect(calls[0].args).toContain('--net-default')
    expect(calls[0].args).toContain('deny')
    expect(calls[0].args).toContain('--mount-named')
    expect(calls[0].args).toContain('forge-c-docker-data:/var/lib/docker:kind=disk,size=32g')
  })

  test('createSandbox forwards env and secrets into the create args', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['GITHUB_TOKEN'],
      secrets: [{ env: 'API_KEY', hosts: ['api.example.com'] }],
    })
    expect(calls[0].args).toContain('-e')
    expect(calls[0].args).toContain('GITHUB_TOKEN')
    expect(calls[0].args).toContain('--secret')
    expect(calls[0].args).toContain('API_KEY@api.example.com')
    expect(calls[0].args.join(' ')).not.toContain('GITHUB_TOKEN=')
    expect(calls[0].args.join(' ')).not.toContain('API_KEY=')
  })

  test('createSandbox throws on non-zero exit', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).rejects.toThrow('Failed to create sandbox: boom')
  })

  test('createSandbox on success performs exactly one invocation and never appends --replace', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).not.toContain('--replace')
  })

  test('createSandbox retries once with a trailing --replace when an already-exists failure hides an orphaned directory', async () => {
    const { calls, runner } = recordingRunner((rec) =>
      rec.args.includes('--replace')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: alreadyExistsStderr, exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual([...calls[0].args, '--replace'])
  })

  test('createSandbox surfaces the second --replace failure rather than the first already-exists error', async () => {
    const { calls, runner } = recordingRunner((rec) =>
      rec.args.includes('--replace')
        ? { stdout: '', stderr: 'disk corrupt', exitCode: 2 }
        : { stdout: '', stderr: alreadyExistsStderr, exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    const err = await rt
      .createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    if (err instanceof Error) {
      expect(err.message).toContain('Failed to create sandbox: disk corrupt')
      expect(err.message).not.toContain('remove it, start the stopped sandbox')
    }
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual([...calls[0].args, '--replace'])
  })

  test('createSandbox does not retry with --replace on an unrelated failure', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'no space left on device', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).rejects.toThrow('Failed to create sandbox: no space left on device')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).not.toContain('--replace')
  })

  test('createSandbox retries when the already-exists wording differs in capitalization', async () => {
    const { calls, runner } = recordingRunner((rec) =>
      rec.args.includes('--replace')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'Sandbox Already Exists: duplicate', exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual([...calls[0].args, '--replace'])
  })

  test('createSandbox logs the orphaned-state recovery naming the sandbox and --replace', async () => {
    const log = vi.fn()
    const { runner } = recordingRunner((rec) =>
      rec.args.includes('--replace')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: alreadyExistsStderr, exitCode: 1 },
    )
    const rt = createMsbRuntime({ ...logger, log }, { run: runner })
    await expect(
      rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' }),
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forge-x'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--replace'))
  })

  test('removeSandbox removes the sandbox and then its derived docker data volume', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.removeSandbox('forge-a')
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a', '--quiet'])
    expect(calls[1].args).toEqual(['volume', 'rm', 'forge-a-docker-data'])
  })

  test('removeSandbox tolerates a not-found failure', async () => {
    const { runner } = recordingRunner((rec) =>
      rec.args[0] === 'rm'
        ? { stdout: '', stderr: 'no such sandbox forge-a', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
  })

  test('removeSandbox treats an already-removed docker data volume as success', async () => {
    const { runner } = recordingRunner((rec) =>
      rec.args[0] === 'rm'
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'volume forge-a-docker-data not found', exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
  })

  test('a docker data volume removal failure is logged but does not fail sandbox removal', async () => {
    const log = vi.fn()
    const rt = createMsbRuntime({ ...logger, log }, {
      run: async (args) =>
        args[0] === 'rm'
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'permission denied', exitCode: 1 },
    })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to remove docker data volume'))
  })

  test('removeSandbox throws on an unexpected failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
  })

  test('a failed sandbox removal leaves the docker data volume untouched', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a', '--quiet'])
  })

  test('getSandboxState reports running, reusable stopped, transient for known non-executable states, and missing for an absent name', async () => {
    const stdout = JSON.stringify([
      { name: 'forge-a', status: 'Running' },
      { name: 'forge-b', status: 'Crashed' },
      { name: 'forge-c', status: 'Created' },
      { name: 'forge-d', status: 'Starting' },
      { name: 'forge-e', status: 'Draining' },
      { name: 'forge-f', status: 'Paused' },
    ])
    const { runner } = recordingRunner(() => ({ stdout, stderr: '', exitCode: 0 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.getSandboxState('forge-a')).resolves.toBe('running')
    await expect(rt.getSandboxState('forge-b')).resolves.toBe('stopped')
    // `Created`/`Starting`/`Draining`/`Paused` are real msb states, so they report transient
    // rather than a query failure: the sandbox exists even though it is not directly executable.
    await expect(rt.getSandboxState('forge-c')).resolves.toBe('transient')
    await expect(rt.getSandboxState('forge-d')).resolves.toBe('transient')
    await expect(rt.getSandboxState('forge-e')).resolves.toBe('transient')
    await expect(rt.getSandboxState('forge-f')).resolves.toBe('transient')
    await expect(rt.getSandboxState('forge-x')).resolves.toBe('missing')
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
