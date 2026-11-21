import { describe, test, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'fs'
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
  cacheDiskVolumeName,
  SANDBOX_CACHE_DIR,
  SANDBOX_WORKSPACE_QUOTA,
  parseMsbSandboxList,
  parseMsbSandboxListOrNull,
  mapMsbStatus,
  parseMsbImageList,
  msbImageMatches,
  parseMsbInspectSecrets,
  parseMsbInspectRuntimeSettings,
  parseMsbInspectEnv,
  msbSizeToMib,
  checkMsbAvailability,
  describeMsbUnavailable,
  createMsbRuntime,
  MSB_DEFAULT_TIMEOUT,
} from '../../src/sandbox/msb'
import type { CommandRunner, SandboxRuntime } from '../../src/sandbox/msb'
import { resolveSandboxSecret } from '../../src/sandbox/secrets'
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
    ])
  })

  test('LAN access adds the private group alongside public, or to an allow-list', () => {
    const ws = [{ hostDir: '/a', containerDir: '/a' }]
    const open = buildMsbCreateArgs('forge-c', ws, { image: 'img', allowLan: true })
    expect(open.slice(open.indexOf('--net'), open.indexOf('--net') + 2)).toEqual(['--net', 'public,private'])
    expect(open).not.toContain('--net-default')

    const restricted = buildMsbCreateArgs('forge-c', ws, { image: 'img', allowLan: true, networkAllow: ['registry.npmjs.org'] })
    expect(restricted.join(' ')).toContain('--net-default deny --net-rule allow@registry.npmjs.org --net-rule allow@private')
    expect(restricted).not.toContain('--net')

    expect(buildMsbCreateArgs('forge-c', ws, { image: 'img' }).join(' ')).not.toMatch(/--net|private/)
  })

  test('never emits the allow@dns rule that msb 0.6.8 rejects', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], { image: 'oc-forge-sandbox:latest' })
    expect(args).not.toContain('allow@dns')
    expect(args.join(' ')).not.toContain('allow@dns')
  })

  test('suffixes read-only workspaces with :ro and gives read-write workspaces a guest-write quota', () => {
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '-v',
      '/b:/b:ro',
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
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
      '--root-disk',
      '6g',
      '-c',
      '4',
      '-m',
      '8g',
      '-v',
      `/work:/work:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
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

  test('emits -e NAME=VALUE for vars after the bare env names', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['CI'],
      vars: { GITEA_INSTANCE_URL: 'https://git.example.com' },
    })
    expect(args.slice(-4)).toEqual(['-e', 'CI', '-e', 'GITEA_INSTANCE_URL=https://git.example.com'])
  })

  test('emits a name present in both env and vars once, as the var assignment', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      env: ['HOME', 'CI'],
      vars: { HOME: '/guest/home' },
    })
    expect(args.filter((arg) => arg === '-e')).toHaveLength(2)
    expect(args).toContain('HOME=/guest/home')
    expect(args).toContain('CI')
    expect(args).not.toContain('HOME')
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
      '--secret',
      'GITHUB_TOKEN:headers=*@api.github.com,*.githubusercontent.com',
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
      '--root-disk',
      '6g',
      '-v',
      `/a:/a:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
      '--secret',
      'KEEP:headers=*@api.example.com',
    ])
    expect(args.join(' ')).not.toContain('super-secret')
  })

  test('normalizes padded secret env names and hosts into the reference form', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: ' TOKEN ', hosts: [' api.example.com ', '*.github.com'] }],
    })
    expect(args).toContain('--secret')
    expect(args).toContain('TOKEN:headers=*@api.example.com,*.github.com')
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

  test('renders substitution options in the documented comma-joined order', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [
        {
          env: 'API',
          hosts: ['api.example.com'],
          substitution: {
            headers: true,
            headerFields: ['authorization', 'x-api-key'],
            query: true,
            body: true,
          },
          passthrough: ['*.corp.example', 'telemetry.example'],
        },
        { env: 'PLAIN', hosts: ['plain.example'], substitution: { headers: false } },
        { env: 'QUERY_ONLY', hosts: ['q.example'], substitution: { query: true, body: true } },
      ],
    })
    expect(args).toContain(
      'API:headers=[authorization,x-api-key],query,body,passthrough=[*.corp.example,telemetry.example]@api.example.com',
    )
    expect(args).toContain('PLAIN:no-headers@plain.example')
    expect(args).toContain('QUERY_ONLY:headers=*,query,body@q.example')
  })

  test('emits --secret-conf instead of any --secret flag when a conf path is supplied', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: 'T', hosts: ['h'] }],
      secretConfPath: '/tmp/forge-msb-x/secrets.yaml',
    })
    expect(args.slice(args.indexOf('--secret-conf'), args.indexOf('--secret-conf') + 2)).toEqual([
      '--secret-conf',
      '/tmp/forge-msb-x/secrets.yaml',
    ])
    expect(args).not.toContain('--secret')
  })

  test('throws on an empty workspace array', () => {
    expect(() => buildMsbCreateArgs('forge-c', [], { image: 'x' })).toThrow(
      'requires at least one workspace',
    )
  })

  test('emits --idle-timeout only when an idle timeout is configured', () => {
    const ws = [{ hostDir: '/a', containerDir: '/a' }]
    const withTimeout = buildMsbCreateArgs('forge-c', ws, { image: 'img', idleTimeout: '30m' })
    expect(withTimeout.slice(withTimeout.indexOf('--idle-timeout'), withTimeout.indexOf('--idle-timeout') + 2))
      .toEqual(['--idle-timeout', '30m'])

    const withoutTimeout = buildMsbCreateArgs('forge-c', ws, { image: 'img' })
    expect(withoutTimeout).not.toContain('--idle-timeout')
    expect(withoutTimeout.join(' ')).not.toContain('30m')
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
    expect(args).toContain('GITHUB_TOKEN:headers=*@api.github.com,*.githubusercontent.com')
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

  test('emits the cache disk mount over the pinned cache dir by default', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
    })
    expect(args).toContain('--mount-named')
    expect(args).toContain('forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g')
  })

  test('uses the configured cache disk size when provided', () => {
    const args = buildMsbCreateArgs('forge-c', [{ hostDir: '/a', containerDir: '/a' }], {
      image: 'oc-forge-sandbox:latest',
      cacheDisk: '32g',
    })
    expect(args).toContain('forge-c-cache-data:/opt/forge/cache:kind=disk,size=32g')
  })

  test('dockerDataVolumeName derives a stable per-container volume name', () => {
    expect(dockerDataVolumeName('forge-my-worktree')).toBe('forge-my-worktree-docker-data')
    expect(dockerDataVolumeName('Forge/C!')).toBe('forge-c-docker-data')
    expect(dockerDataVolumeName('forge-a')).not.toBe(dockerDataVolumeName('forge-b'))
  })

  test('cacheDiskVolumeName derives a stable per-container volume name at the pinned cache dir', () => {
    expect(cacheDiskVolumeName('forge-my-worktree')).toBe('forge-my-worktree-cache-data')
    expect(cacheDiskVolumeName('Forge/C!')).toBe('forge-c-cache-data')
    expect(SANDBOX_CACHE_DIR).toBe('/opt/forge/cache')
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
        [{ env: 'KEEP', hosts: ['api.example.com', '*.com', 'localhost'] }],
        { ...logger, log },
      ),
    ).toEqual(['api.example.com'])
    expect(log).toHaveBeenCalledTimes(2)
  })

  test('a secret with a delimiter in a host contributes no egress hosts', () => {
    expect(
      buildNetworkAllow(undefined, [{ env: 'BAD', hosts: ['api.example.com', 'bad,host'] }], logger),
    ).toEqual([])
    expect(egressRestrictionRequested(undefined, [{ env: 'BAD', hosts: ['bad,host'] }])).toBe(false)
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
    expect(egressRestrictionRequested(undefined, [{ env: 'T', hosts: ['*.com'] }])).toBe(true)
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
    expect(parseMsbInspectSecrets(stdout)?.map((s) => s.env)).toEqual(['A_TOKEN', 'B_TOKEN'])
  })

  test('extracts the fixed per-secret policy fields with msb defaults filled in', () => {
    const stdout = JSON.stringify({
      config: {
        network: {
          secrets: {
            secrets: [
              {
                env_var: 'T',
                allowed_hosts: [{ exact: 'ai2.lab' }],
                passthrough_hosts: [{ wildcard: '*.x.org' }],
                placeholder: '$MSB_T',
                require_tls_identity: false,
                substitution: { body: false, header_fields: ['authorization'], headers: true, query: false },
                violation_action: 'block',
              },
              { env_var: 'DEFAULTS' },
              { env_var: 'NULL_ACTION', violation_action: null, require_tls_identity: true },
              { env_var: 'EMPTY_PASSTHROUGH', passthrough_hosts: [] },
              { not_env: true },
            ],
          },
        },
      },
    })
    expect(parseMsbInspectSecrets(stdout)).toEqual([
      { env: 'T', requireTlsIdentity: false, violationAction: 'block', hasPassthrough: true },
      { env: 'DEFAULTS', requireTlsIdentity: true, hasPassthrough: false },
      { env: 'NULL_ACTION', requireTlsIdentity: true, hasPassthrough: false },
      { env: 'EMPTY_PASSTHROUGH', requireTlsIdentity: true, hasPassthrough: false },
    ])
  })

  test('treats a non-boolean require_tls_identity as the default', () => {
    const stdout = JSON.stringify({
      config: { network: { secrets: { secrets: [{ env_var: 'T', require_tls_identity: 'yes' }] } } },
    })
    expect(parseMsbInspectSecrets(stdout)).toEqual([
      { env: 'T', requireTlsIdentity: true, hasPassthrough: false },
    ])
  })

  test('returns an empty list when no secrets are bound', () => {
    const stdout = JSON.stringify({ name: 'forge-c', status: 'Running', config: { network: {} } })
    expect(parseMsbInspectSecrets(stdout)).toEqual([])
  })

  test('returns null for unparseable or malformed output so callers fail closed', () => {
    expect(parseMsbInspectSecrets('not json')).toBeNull()
    expect(parseMsbInspectSecrets('[]')).toBeNull()
    expect(parseMsbInspectSecrets('{"config":{}}')).toBeNull()
    expect(
      parseMsbInspectSecrets(
        JSON.stringify({ config: { network: { secrets: { secrets: 'x' } } } }),
      ),
    ).toBeNull()
  })
})

describe('inspect env parsing', () => {
  test('parses the key and value entries into a record', () => {
    const stdout = JSON.stringify({
      name: 'forge-c',
      status: 'Running',
      config: {
        env: [
          { key: 'GITEA_INSTANCE_URL', value: 'https://git.example.com' },
          { key: 'EMPTY_VALUE', value: '' },
        ],
      },
    })
    expect(parseMsbInspectEnv(stdout)).toEqual({
      GITEA_INSTANCE_URL: 'https://git.example.com',
      EMPTY_VALUE: '',
    })
  })

  test('returns null when any entry is malformed and treats a missing env as empty', () => {
    for (const malformed of [{ key: 'NO_VALUE' }, { value: 'no-key' }, { key: '', value: 'blank-key' }, 'not-an-entry']) {
      const stdout = JSON.stringify({ config: { env: [{ key: 'KEEP', value: 'v' }, malformed] } })
      expect(parseMsbInspectEnv(stdout)).toBeNull()
    }
    expect(parseMsbInspectEnv(JSON.stringify({ config: {} }))).toEqual({})
    expect(parseMsbInspectEnv(JSON.stringify({ config: { env: null } }))).toEqual({})
  })

  test('returns null when the envelope or env list does not parse', () => {
    expect(parseMsbInspectEnv('not json')).toBeNull()
    expect(parseMsbInspectEnv('[]')).toBeNull()
    expect(parseMsbInspectEnv(JSON.stringify({ config: { env: 'x' } }))).toBeNull()
    expect(parseMsbInspectEnv(JSON.stringify({ config: { env: { KEY: 'v' } } }))).toBeNull()
    expect(parseMsbInspectEnv(JSON.stringify({ config: { env: ['KEY=v', 'OTHER=w'] } }))).toBeNull()
    expect(parseMsbInspectEnv(JSON.stringify({ config: { env: [] } }))).toEqual({})
  })
})

describe('resolveSandboxSecret', () => {
  test('preserves the exact plain shape with no extra keys', () => {
    const result = resolveSandboxSecret({ env: 'T', hosts: ['h'] })
    expect(result).toEqual({ secret: { env: 'T', hosts: ['h'] } })
  })

  test('trims env, hosts, header fields, and passthrough entries', () => {
    const result = resolveSandboxSecret({
      env: ' T ',
      hosts: [' h ', '  '],
      substitution: { headers: true, headerFields: [' authorization ', ' '], query: true },
      passthrough: [' *.x.org ', ''],
      violationAction: 'block-and-log',
      requireTlsIdentity: false,
    })
    expect(result).toEqual({
      secret: {
        env: 'T',
        hosts: ['h'],
        substitution: { headers: true, headerFields: ['authorization'], query: true },
        passthrough: ['*.x.org'],
        violationAction: 'block-and-log',
        requireTlsIdentity: false,
      },
    })
  })

  test('rejects a definition that does not match the schema', () => {
    const wrongType = { env: 'T', hosts: 'h' } as unknown as { env: string; hosts: string[] }
    expect(resolveSandboxSecret(wrongType)).toEqual({ env: 'T', reason: 'invalid definition' })
    const unknownAction = {
      env: 'T',
      hosts: ['h'],
      violationAction: 'nope',
    } as unknown as { env: string; hosts: string[] }
    expect(resolveSandboxSecret(unknownAction)).toEqual({ env: 'T', reason: 'invalid definition' })
  })

  test('reports the rejection reason for each invalid definition', () => {
    expect(resolveSandboxSecret({ env: '   ', hosts: ['h'] })).toEqual({
      env: '',
      reason: 'missing env name',
    })
    expect(resolveSandboxSecret({ env: 'A=B', hosts: ['h'] })).toEqual({
      env: 'A=B',
      reason: 'env name must not contain =',
    })
    for (const env of ['A:B', 'A@B', 'A,B', 'A B', 'A[B]']) {
      expect(resolveSandboxSecret({ env, hosts: ['h'] })).toEqual({
        env,
        reason: 'env name must not contain whitespace, commas, colons, @, or brackets',
      })
    }
    expect(resolveSandboxSecret({ env: 'T', hosts: [' ', ''] })).toEqual({
      env: 'T',
      reason: 'no allowed hosts',
    })
    for (const host of ['a.com,b.com', 'a@b.com', 'a b.com', '[a.com]']) {
      expect(resolveSandboxSecret({ env: 'T', hosts: [host] })).toEqual({
        env: 'T',
        reason: 'hosts entries must not contain whitespace, commas, @, or brackets',
      })
    }
    expect(resolveSandboxSecret({ env: 'T', hosts: ['*.example.com', 'ai2.lab'] })).toEqual({
      secret: { env: 'T', hosts: ['*.example.com', 'ai2.lab'] },
    })
    expect(
      resolveSandboxSecret({ env: 'T', hosts: ['h'], substitution: { headers: false, headerFields: ['authorization'] } }),
    ).toEqual({ env: 'T', reason: 'substitution.headerFields requires substitution.headers' })
    const entryReason =
      'substitution.headerFields and passthrough entries must not contain whitespace, commas, @, or brackets'
    expect(
      resolveSandboxSecret({ env: 'T', hosts: ['h'], substitution: { headerFields: ['a,b'] } }),
    ).toEqual({ env: 'T', reason: entryReason })
    expect(resolveSandboxSecret({ env: 'T', hosts: ['h'], substitution: { headerFields: ['a@b'] } })).toEqual({
      env: 'T',
      reason: entryReason,
    })
    expect(resolveSandboxSecret({ env: 'T', hosts: ['h'], passthrough: ['a b'] })).toEqual({
      env: 'T',
      reason: entryReason,
    })
  })
})

describe('inspect runtime settings parsing', () => {
  const resources = { cpus: 2, max_cpus: 2, memory_mib: 4096, max_memory_mib: 4096 }
  const hostDns = { action: 'allow', destination: { group: 'host' }, direction: 'egress', ports: [{ start: 53, end: 53 }], protocols: ['udp', 'tcp'] }
  const allowPrivate = { action: 'allow', destination: { group: 'private' }, direction: 'egress', ports: [], protocols: [] }

  test('a sandbox without a network policy uses msb\'s LAN-blocking default', () => {
    const stdout = JSON.stringify({ config: { resources, network: { enabled: true, ports: [] } } })
    expect(parseMsbInspectRuntimeSettings(stdout)).toEqual({ cpus: 2, memoryMib: 4096, allowLan: false })
  })

  test('an allow egress rule for the private group means LAN access (--net public,private)', () => {
    const stdout = JSON.stringify({
      config: {
        resources,
        network: { policy: { default_egress: 'deny', rules: [hostDns, { ...allowPrivate, destination: { group: 'public' } }, allowPrivate] } },
      },
    })
    expect(parseMsbInspectRuntimeSettings(stdout)).toEqual({ cpus: 2, memoryMib: 4096, allowLan: true })
  })

  test('an ingress-only or deny rule for private is not LAN egress', () => {
    const rules = [{ ...allowPrivate, direction: 'ingress' }, { ...allowPrivate, action: 'deny' }]
    const stdout = JSON.stringify({ config: { resources, network: { policy: { rules } } } })
    expect(parseMsbInspectRuntimeSettings(stdout)?.allowLan).toBe(false)
  })

  test('returns null when resources are missing or the payload is malformed', () => {
    expect(parseMsbInspectRuntimeSettings('not json')).toBeNull()
    expect(parseMsbInspectRuntimeSettings('{"config":{}}')).toBeNull()
    expect(parseMsbInspectRuntimeSettings(JSON.stringify({ config: { resources: { cpus: '2', memory_mib: 4096 } } }))).toBeNull()
  })
})

describe('msbSizeToMib', () => {
  test('reads k/m/g as binary units with an optional b suffix', () => {
    expect(msbSizeToMib('8g')).toBe(8192)
    expect(msbSizeToMib('1.5GB')).toBe(1536)
    expect(msbSizeToMib('512m')).toBe(512)
    expect(msbSizeToMib('2048k')).toBe(2)
    expect(msbSizeToMib('lots')).toBeUndefined()
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
    opts?: { timeout?: number; stdin?: string; abort?: AbortSignal; env?: Record<string, string> }
  }
  function recordingRunner(handler?: (rec: Rec) => { stdout: string; stderr: string; exitCode: number }) {
    const calls: Rec[] = []
    const runner: CommandRunner = async (args, opts) => {
      const rec = { args, opts: { timeout: opts?.timeout, stdin: opts?.stdin, abort: opts?.abort, env: opts?.env } }
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
      '--root-disk',
      '6g',
      '-c',
      '2',
      '-m',
      '8g',
      '-v',
      `/work:/work:quota=${SANDBOX_WORKSPACE_QUOTA}`,
      '--mount-named',
      'forge-c-docker-data:/var/lib/docker:kind=disk,size=16g',
      '--mount-named',
      'forge-c-cache-data:/opt/forge/cache:kind=disk,size=16g',
    ])
    expect(calls[0].opts?.timeout).toBe(120000)
  })

  test('createSandbox puts var values on argv and keeps them out of the child environment', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      vars: { GITEA_INSTANCE_URL: 'https://git.example.com' },
      secretEnv: { GITEA_TOKEN: 'secret-value' },
    })

    expect(calls[0].args).toContain('GITEA_INSTANCE_URL=https://git.example.com')
    expect(calls[0].opts?.env).toEqual({ GITEA_TOKEN: 'secret-value' })
    expect(JSON.stringify(calls[0].opts?.env)).not.toContain('https://git.example.com')
  })

  test('createSandbox drops unparsable memory and cpus instead of passing them to msb', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      resources: { memory: 'lots', cpus: 'many' },
    })
    expect(calls[0].args).not.toContain('-m')
    expect(calls[0].args).not.toContain('-c')
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
    expect(calls[0].args).toContain('API_KEY:headers=*@api.example.com')
    expect(calls[0].args.join(' ')).not.toContain('GITHUB_TOKEN=')
    expect(calls[0].args.join(' ')).not.toContain('API_KEY=')
  })

  test('createSandbox writes a secret conf file for policies the flag grammar cannot express', async () => {
    const observed: Array<{ args: string[]; fileExists: boolean; conf?: unknown }> = []
    const { calls, runner } = recordingRunner((rec) => {
      const idx = rec.args.indexOf('--secret-conf')
      const path = idx >= 0 ? rec.args[idx + 1] : undefined
      observed.push({
        args: rec.args,
        fileExists: path ? existsSync(path) : false,
        conf: path ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
      })
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [
        {
          env: 'LAN_TOKEN',
          hosts: ['ai2.lab'],
          substitution: { headers: true, headerFields: ['authorization'], query: true },
          passthrough: ['*.x.org'],
          violationAction: 'block',
          requireTlsIdentity: false,
        },
      ],
    })
    expect(observed).toHaveLength(1)
    expect(observed[0].fileExists).toBe(true)
    expect(observed[0].conf).toEqual({
      LAN_TOKEN: {
        allow: ['ai2.lab'],
        substitution: { headers: true, query: true, body: false, header_fields: ['authorization'] },
        passthrough: ['*.x.org'],
        violation_action: 'block',
        require_tls_identity: false,
      },
    })
    expect(observed[0].args).not.toContain('--secret')
    const confPath = calls[0].args[calls[0].args.indexOf('--secret-conf') + 1]
    expect(existsSync(confPath)).toBe(false)
  })

  test('createSandbox keeps the secret conf file available across the --replace retry', async () => {
    const seenOnReplace: boolean[] = []
    const { calls, runner } = recordingRunner((rec) => {
      const confPath = rec.args[rec.args.indexOf('--secret-conf') + 1]
      if (rec.args.includes('--replace')) {
        seenOnReplace.push(existsSync(confPath))
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: alreadyExistsStderr, exitCode: 1 }
    })
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: 'T', hosts: ['h'], requireTlsIdentity: false }],
    })
    expect(calls).toHaveLength(2)
    expect(seenOnReplace).toEqual([true])
    expect(existsSync(calls[1].args[calls[1].args.indexOf('--secret-conf') + 1])).toBe(false)
  })

  test('createSandbox passes secretEnv to the runner on the first attempt and the --replace retry without putting values in the args', async () => {
    const secretEnv = { API_KEY: 'super-secret-value' }
    const { calls, runner } = recordingRunner((rec) =>
      rec.args.includes('--replace')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: alreadyExistsStderr, exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-x', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [{ env: 'API_KEY', hosts: ['api.example.com'] }],
      secretEnv,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].opts?.env).toEqual(secretEnv)
    expect(calls[1].opts?.env).toEqual(secretEnv)
    expect(calls[0].args.join(' ')).not.toContain('super-secret-value')
    expect(calls[1].args.join(' ')).not.toContain('super-secret-value')
  })

  test('createSandbox passes no runner env when secretEnv is absent', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], { image: 'oc-forge-sandbox:latest' })

    expect(calls[0].opts?.env).toBeUndefined()
  })

  test('createSandbox uses plain --secret flags when no per-secret policy needs a conf file', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.createSandbox('forge-c', [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
      secrets: [
        {
          env: 'T',
          hosts: ['h'],
          substitution: { headers: true, query: true },
          passthrough: ['*.x.org'],
        },
      ],
    })
    expect(calls[0].args).not.toContain('--secret-conf')
    expect(calls[0].args).toContain('--secret')
    expect(calls[0].args).toContain('T:headers=*,query,passthrough=[*.x.org]@h')
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

  test('removeSandbox removes the sandbox and then both derived named volumes in one bulk call', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.removeSandbox('forge-a')
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a', '--quiet'])
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual(['volume', 'rm', 'forge-a-docker-data', 'forge-a-cache-data'])
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

  test('removeSandbox treats already-removed named volumes as success', async () => {
    const { runner } = recordingRunner((rec) =>
      rec.args[0] === 'rm'
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'volume forge-a-docker-data not found', exitCode: 1 },
    )
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
  })

  test('a named volume removal failure is logged but does not fail sandbox removal', async () => {
    const log = vi.fn()
    const rt = createMsbRuntime({ ...logger, log }, {
      run: async (args) =>
        args[0] === 'rm'
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'permission denied', exitCode: 1 },
    })
    await expect(rt.removeSandbox('forge-a')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('failed to remove named volumes forge-a-docker-data, forge-a-cache-data for forge-a'),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
  })

  test('removeSandbox throws on an unexpected failure', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
  })

  test('a failed sandbox removal leaves both named volumes untouched', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.removeSandbox('forge-a')).rejects.toThrow('Failed to remove sandbox')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['rm', '--force', 'forge-a', '--quiet'])
  })

  test('removeSandbox removes exactly the set of volumes buildMsbCreateArgs mounts', async () => {
    const sandboxName = 'forge-invariant'
    const createArgs = buildMsbCreateArgs(sandboxName, [{ hostDir: '/work', containerDir: '/work' }], {
      image: 'oc-forge-sandbox:latest',
    })
    const createdVolumes = createArgs
      .filter((_, i) => createArgs[i - 1] === '--mount-named')
      .map((mount) => mount.slice(0, mount.indexOf(':')))

    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })
    await rt.removeSandbox(sandboxName)
    const removedVolumes = calls
      .filter((c) => c.args[0] === 'volume' && c.args[1] === 'rm')
      .flatMap((c) => c.args.slice(2))

    expect(new Set(removedVolumes)).toEqual(new Set(createdVolumes))
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

  function inspectStdout(bound: Array<string | Record<string, unknown>>): string {
    return JSON.stringify({
      name: 'forge-c',
      status: 'Running',
      config: {
        network: {
          secrets: bound.length === 0
            ? undefined
            : { secrets: bound.map((entry) => (typeof entry === 'string' ? { env_var: entry } : entry)) },
        },
      },
    })
  }

  function refreshRunner(bound: Array<string | Record<string, unknown>>) {
    return recordingRunner((rec) =>
      rec.args[0] === 'inspect'
        ? { stdout: inspectStdout(bound), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )
  }

  test('resizeSandbox restarts the sandbox with the normalized CPUs and memory', async () => {
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })

    await rt.resizeSandbox('forge-c', { cpus: '6', memory: '12GB' })

    expect(calls[0].args).toEqual(['modify', 'forge-c', '--restart', '--cpus', '6', '--memory', '12g'])
    expect(calls[0].opts?.timeout).toBe(MSB_DEFAULT_TIMEOUT)
  })

  test('resizeSandbox rejects when msb refuses and skips an empty change', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })

    await expect(rt.resizeSandbox('forge-c', { cpus: '2' })).rejects.toThrow('Failed to resize sandbox forge-c: boom')
    await rt.resizeSandbox('forge-c', {})
    expect(calls).toHaveLength(1)
  })

  test('readSandboxSettings returns null instead of rejecting on a failed inspect', async () => {
    const failing = createMsbRuntime(logger, { run: recordingRunner(() => ({ stdout: '', stderr: 'x', exitCode: 1 })).runner })
    await expect(failing.readSandboxSettings('forge-c')).resolves.toBeNull()
    const throwing = createMsbRuntime(logger, { run: async () => { throw new Error('spawn') } })
    await expect(throwing.readSandboxSettings('forge-c')).resolves.toBeNull()
  })

  test('refreshSandboxSecrets reads the bound set and converges msb modify to the desired set', async () => {
    const { calls, runner } = refreshRunner(['STALE_TOKEN', 'KEEP'])
    const rt = createMsbRuntime(logger, { run: runner })
    const result = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
      { env: 'NPM_TOKEN', hosts: ['registry.npmjs.org'] },
    ])
    expect(result).toEqual({ ok: true })
    expect(calls[0].args).toEqual(['inspect', 'forge-c', '--format', 'json'])
    expect(calls[0].opts?.timeout).toBe(30000)
    expect(calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret-rm',
      'STALE_TOKEN',
      '--secret',
      'KEEP:headers=*@api.example.com',
      '--secret',
      'NPM_TOKEN:headers=*@registry.npmjs.org',
    ])
    expect(calls[1].opts?.timeout).toBe(MSB_DEFAULT_TIMEOUT)
  })

  test('refreshSandboxSecrets passes secretEnv to msb modify only', async () => {
    const secretEnv = { ROTATED: 'rotated-value' }
    const { calls, runner } = refreshRunner(['ROTATED'])
    const rt = createMsbRuntime(logger, { run: runner })

    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'ROTATED', hosts: ['api.example.com'] }], secretEnv),
    ).resolves.toEqual({ ok: true })

    expect(calls[0].args[0]).toBe('inspect')
    expect(calls[1].args[0]).toBe('modify')
    expect(calls[0].opts?.env).toBeUndefined()
    expect(calls[1].opts?.env).toEqual(secretEnv)
    expect(calls[1].args.join(' ')).not.toContain('rotated-value')
  })

  test('refreshSandboxSecrets passes no runner env when secretEnv is absent', async () => {
    const { calls, runner } = refreshRunner(['KEEP'])
    const rt = createMsbRuntime(logger, { run: runner })

    await rt.refreshSandboxSecrets('forge-c', [{ env: 'KEEP', hosts: ['api.example.com'] }])

    expect(calls[1].opts?.env).toBeUndefined()
  })

  test('startSandbox runs msb start and passes secretEnv only through the environment', async () => {
    const secretEnv = { ROTATED: 'rotated-value' }
    const { calls, runner } = recordingRunner()
    const rt = createMsbRuntime(logger, { run: runner })

    await rt.startSandbox('forge-c', secretEnv)

    expect(calls[0].args).toEqual(['start', 'forge-c', '--quiet'])
    expect(calls[0].opts?.timeout).toBe(MSB_DEFAULT_TIMEOUT)
    expect(calls[0].opts?.env).toEqual(secretEnv)
    expect(calls[0].args.join(' ')).not.toContain('rotated-value')
  })

  test('startSandbox omits the runner env and throws on a non-zero exit', async () => {
    const { calls, runner } = recordingRunner(() => ({ stdout: '', stderr: 'still running', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: runner })

    await expect(rt.startSandbox('forge-c')).rejects.toThrow('Failed to start sandbox forge-c: still running')
    expect(calls[0].opts?.env).toBeUndefined()
  })

  test('refreshSandboxSecrets always passes --restart so every bound change is applied', async () => {
    const rotation = refreshRunner(['KEEP'])
    const rt = createMsbRuntime(logger, { run: rotation.runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'KEEP', hosts: ['api.example.com'] }]),
    ).resolves.toEqual({ ok: true })
    expect(rotation.calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret',
      'KEEP:headers=*@api.example.com',
    ])
    expect(rotation.calls[1].opts?.timeout).toBe(MSB_DEFAULT_TIMEOUT)

    const added = refreshRunner(['KEEP'])
    const rt2 = createMsbRuntime(logger, { run: added.runner })
    await expect(
      rt2.refreshSandboxSecrets('forge-c', [
        { env: 'KEEP', hosts: ['api.example.com'] },
        { env: 'NEW_TOKEN', hosts: ['api.example.com'] },
      ]),
    ).resolves.toEqual({ ok: true })
    expect(added.calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret',
      'KEEP:headers=*@api.example.com',
      '--secret',
      'NEW_TOKEN:headers=*@api.example.com',
    ])
  })

  test('refreshSandboxSecrets removes every bound secret when the desired list is empty', async () => {
    const { calls, runner } = refreshRunner(['A_TOKEN', 'B_TOKEN'])
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.refreshSandboxSecrets('forge-c', [])).resolves.toEqual({ ok: true })
    expect(calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret-rm',
      'A_TOKEN',
      '--secret-rm',
      'B_TOKEN',
    ])
  })

  test('refreshSandboxSecrets re-issues desired secrets so a rotated host value is re-read', async () => {
    const { calls, runner } = refreshRunner(['KEEP'])
    const rt = createMsbRuntime(logger, { run: runner })
    const result = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
    ])
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[0].args[0]).toBe('inspect')
    expect(calls[1].args).toEqual(['modify', 'forge-c', '--restart', '--secret', 'KEEP:headers=*@api.example.com'])
  })

  test('refreshSandboxSecrets with an empty list and nothing bound never invokes msb modify', async () => {
    const { calls, runner } = refreshRunner([])
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(rt.refreshSandboxSecrets('forge-c', [])).resolves.toEqual({ ok: true })
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
    }
  })

  test('refreshSandboxSecrets reports a failure when the inspect query fails or is unparseable', async () => {
    const failing = recordingRunner(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const rt = createMsbRuntime(logger, { run: failing.runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toEqual({ ok: false, reason: 'could not read the bound secrets from msb inspect' })

    const malformed = recordingRunner(() => ({ stdout: 'not json', stderr: '', exitCode: 0 }))
    const rt2 = createMsbRuntime(logger, { run: malformed.runner })
    await expect(
      rt2.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toEqual({ ok: false, reason: 'could not read the bound secrets from msb inspect' })
  })

  test('refreshSandboxSecrets reports a failure when the runner throws', async () => {
    const { runner } = recordingRunner(() => { throw new Error('msb exploded') })
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toEqual({ ok: false, reason: 'could not read the bound secrets from msb inspect' })
  })

  test('refreshSandboxSecrets skips misconfigured secrets like the create builder', async () => {
    const { calls, runner } = refreshRunner([])
    const rt = createMsbRuntime(logger, { run: runner })
    const result = await rt.refreshSandboxSecrets('forge-c', [
      { env: 'KEEP', hosts: ['api.example.com'] },
      { env: ' ', hosts: ['api.example.com'] },
      { env: 'GITHUB_TOKEN=super-secret', hosts: ['api.github.com'] },
      { env: 'NO_HOSTS', hosts: [] },
    ])
    expect(result).toEqual({ ok: true })
    expect(calls[1].args).toEqual(['modify', 'forge-c', '--restart', '--secret', 'KEEP:headers=*@api.example.com'])
    expect(calls[1].args.join(' ')).not.toContain('super-secret')
  })

  test('refreshSandboxSecrets reports a reason naming the frozen secret and the recreate command', async () => {
    const cases: Array<{
      bound: Array<string | Record<string, unknown>>
      desired: Array<Record<string, unknown>>
    }> = [
      {
        bound: [],
        desired: [{ env: 'T', hosts: ['h'], requireTlsIdentity: false }],
      },
      {
        bound: [{ env_var: 'T', require_tls_identity: false }],
        desired: [{ env: 'T', hosts: ['h'] }],
      },
      {
        bound: [{ env_var: 'T', violation_action: 'block' }],
        desired: [{ env: 'T', hosts: ['h'], violationAction: 'block-and-log' }],
      },
      {
        bound: [{ env_var: 'T', passthrough_hosts: [{ wildcard: '*.x.org' }] }],
        desired: [{ env: 'T', hosts: ['h'] }],
      },
    ]
    for (const { bound, desired } of cases) {
      const { calls, runner } = refreshRunner(bound)
      const rt = createMsbRuntime(logger, { run: runner })
      const result = await rt.refreshSandboxSecrets('forge-c', desired)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('secret T')
        expect(result.reason).toContain('msb rm --force forge-c')
      }
      expect(calls.filter((c) => c.args[0] === 'modify')).toHaveLength(0)
    }
  })

  test('refreshSandboxSecrets converges when the bound fixed fields equal the configuration', async () => {
    const { calls, runner } = refreshRunner([
      { env_var: 'T', require_tls_identity: false, passthrough_hosts: [{ wildcard: '*.x.org' }], substitution: { headers: true } },
    ])
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [
        {
          env: 'T',
          hosts: ['h'],
          requireTlsIdentity: false,
          passthrough: ['*.x.org'],
          substitution: { headers: true },
        },
      ]),
    ).resolves.toEqual({ ok: true })
    expect(calls[1].args).toEqual([
      'modify',
      'forge-c',
      '--restart',
      '--secret',
      'T:headers=*,passthrough=[*.x.org]@h',
    ])
  })

  test('refreshSandboxSecrets treats an unset violationAction as the msb default block-and-log', async () => {
    const cases: Array<{ bound: Record<string, unknown>; desired: Record<string, unknown> }> = [
      { bound: { env_var: 'T' }, desired: { env: 'T', hosts: ['h'], violationAction: 'block-and-log' } },
      { bound: { env_var: 'T', violation_action: 'block-and-log' }, desired: { env: 'T', hosts: ['h'] } },
    ]
    for (const { bound, desired } of cases) {
      const { calls, runner } = refreshRunner([bound])
      const rt = createMsbRuntime(logger, { run: runner })
      await expect(rt.refreshSandboxSecrets('forge-c', [desired])).resolves.toEqual({ ok: true })
      expect(calls.filter((c) => c.args[0] === 'modify')).toHaveLength(1)
    }
  })

  test('refreshSandboxSecrets surfaces the modify failure output', async () => {
    const runner: CommandRunner = async (args) =>
      args[0] === 'inspect'
        ? { stdout: inspectStdout([]), stderr: '', exitCode: 0 }
        : { stdout: 'rejected by msb', stderr: '', exitCode: 1 }
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toEqual({ ok: false, reason: 'rejected by msb' })
  })

  test('refreshSandboxSecrets surfaces a thrown modify error', async () => {
    const runner: CommandRunner = async (args) => {
      if (args[0] === 'inspect') return { stdout: inspectStdout([]), stderr: '', exitCode: 0 }
      throw new Error('modify exploded')
    }
    const rt = createMsbRuntime(logger, { run: runner })
    await expect(
      rt.refreshSandboxSecrets('forge-c', [{ env: 'T', hosts: ['h'] }]),
    ).resolves.toEqual({ ok: false, reason: 'modify exploded' })
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
