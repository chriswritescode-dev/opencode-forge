import { describe, test, expect } from 'vitest'
import type { NetworkInterfaceInfo } from 'os'
import {
  resolveDashboardConfig,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  resolvePrimaryLanIpv4,
  buildDashboardUrls,
  describeDashboardBinding,
  DASHBOARD_EXPOSED_WARNING,
} from '../../src/dashboard/config'
import type { PluginConfig } from '../../src/types'

describe('resolveDashboardConfig', () => {
  test('no arguments resolves to built-in defaults', () => {
    expect(resolveDashboardConfig()).toEqual({
      host: 'localhost',
      port: 4747,
      warnings: [],
    })
  })

  test('empty config object resolves to built-in defaults', () => {
    expect(resolveDashboardConfig({})).toEqual({
      host: 'localhost',
      port: 4747,
      warnings: [],
    })
  })

  test('dashboard config host and port are honoured', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '0.0.0.0', port: 8080 } }),
    ).toEqual({ host: '0.0.0.0', port: 8080, warnings: [] })
  })

  test('explicit overrides win over dashboard config', () => {
    expect(
      resolveDashboardConfig(
        { dashboard: { host: '0.0.0.0', port: 8080 } },
        { host: '127.0.0.1', port: 9000 },
      ),
    ).toEqual({ host: '127.0.0.1', port: 9000, warnings: [] })
  })

  test('whitespace-only override host falls through to config host without a warning', () => {
    expect(
      resolveDashboardConfig(
        { dashboard: { host: '192.168.1.5' } },
        { host: '   ' },
      ),
    ).toEqual({ host: '192.168.1.5', port: 4747, warnings: [] })
  })

  test('blank host in both override and config falls back to default', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '' } }, { host: '' }),
    ).toEqual({ host: 'localhost', port: 4747, warnings: [] })
  })

  test('host values are trimmed', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '  0.0.0.0  ' } }),
    ).toEqual({ host: '0.0.0.0', port: 4747, warnings: [] })
  })

  test.each([
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['negative', -1],
    ['out-of-range', 65536],
  ])('%s override port falls through to config port with a warning', (_label, port) => {
    const result = resolveDashboardConfig({ dashboard: { port: 8080 } }, { port })
    expect(result.host).toBe('localhost')
    expect(result.port).toBe(8080)
    expect(result.warnings).toEqual([
      `Ignoring port override ${String(port)}: expected an integer between 0 and 65535.`,
    ])
  })

  test('invalid port in both override and config falls back to default and warns twice', () => {
    const result = resolveDashboardConfig({ dashboard: { port: -3 } }, { port: Number.NaN })
    expect(result.port).toBe(4747)
    expect(result.warnings).toEqual([
      'Ignoring port override NaN: expected an integer between 0 and 65535.',
      'Ignoring dashboard.port -3: expected an integer between 0 and 65535.',
    ])
  })

  test('a quoted config port is reported rather than silently dropped', () => {
    const result = resolveDashboardConfig({
      dashboard: { port: '4747' as unknown as number },
    })
    expect(result.port).toBe(4747)
    expect(result.warnings).toEqual([
      'Ignoring dashboard.port "4747": expected an integer between 0 and 65535.',
    ])
  })

  test('a non-string config host is reported rather than silently dropped', () => {
    const result = resolveDashboardConfig({
      dashboard: { host: 8080 as unknown as string },
    })
    expect(result.host).toBe('localhost')
    expect(result.warnings).toEqual([
      'Ignoring dashboard.host 8080: expected a hostname or IP string.',
    ])
  })

  test('port: 0 override is honoured as ephemeral', () => {
    expect(
      resolveDashboardConfig(undefined, { port: 0 }),
    ).toEqual({ host: 'localhost', port: 0, warnings: [] })
  })

  test('the upper port bound is valid', () => {
    expect(resolveDashboardConfig(undefined, { port: 65535 }).port).toBe(65535)
  })

  test('defaults are exported', () => {
    expect(DEFAULT_DASHBOARD_HOST).toBe('localhost')
    expect(DEFAULT_DASHBOARD_PORT).toBe(4747)
  })
})

describe('buildDashboardUrls', () => {
  test('loopback named host', () => {
    expect(buildDashboardUrls('localhost', 4747)).toEqual({
      url: 'http://localhost:4747',
      localUrl: 'http://localhost:4747',
      exposed: false,
    })
  })

  test('IPv4 loopback', () => {
    const result = buildDashboardUrls('127.0.0.1', 4747)
    expect(result.url).toBe('http://127.0.0.1:4747')
    expect(result.localUrl).toBe(result.url)
    expect(result.exposed).toBe(false)
  })

  test('IPv6 loopback is bracketed', () => {
    const result = buildDashboardUrls('::1', 4747)
    expect(result.url).toBe('http://[::1]:4747')
    expect(result.exposed).toBe(false)
  })

  test('wildcard IPv4 with LAN IP advertised', () => {
    expect(buildDashboardUrls('0.0.0.0', 4747, () => '192.168.1.20')).toEqual({
      url: 'http://192.168.1.20:4747',
      localUrl: 'http://localhost:4747',
      exposed: true,
    })
  })

  test('wildcard IPv4 with no LAN IP falls back to localhost but stays exposed', () => {
    const result = buildDashboardUrls('0.0.0.0', 4747, () => null)
    expect(result.url).toBe('http://localhost:4747')
    expect(result.localUrl).toBe(result.url)
    expect(result.exposed).toBe(true)
  })

  test('wildcard IPv6 is treated as wildcard', () => {
    expect(buildDashboardUrls('::', 4747, () => '192.168.1.20')).toEqual({
      url: 'http://192.168.1.20:4747',
      localUrl: 'http://localhost:4747',
      exposed: true,
    })
  })

  test('concrete non-loopback bind is exposed and not reachable via localhost', () => {
    const result = buildDashboardUrls('192.168.1.20', 4747)
    expect(result.url).toBe('http://192.168.1.20:4747')
    expect(result.localUrl).toBe(result.url)
    expect(result.exposed).toBe(true)
  })

  test('wildcard host is trimmed before detection', () => {
    expect(buildDashboardUrls('  0.0.0.0  ', 4747, () => '10.0.0.5')).toEqual({
      url: 'http://10.0.0.5:4747',
      localUrl: 'http://localhost:4747',
      exposed: true,
    })
  })

  test.each(['LOCALHOST', '  localhost  ', '127.1.2.3'])(
    '%p is recognised as loopback',
    (host) => {
      expect(buildDashboardUrls(host, 4747).exposed).toBe(false)
    },
  )

  test.each(['10.0.0.5', 'example.local'])('%p is treated as exposed', (host) => {
    expect(buildDashboardUrls(host, 4747).exposed).toBe(true)
  })

  // Verified against Bun: `''` binds loopback only and `'*'` fails to bind, so
  // neither may be advertised as a wildcard LAN address.
  test.each(['*', ''])('%p is not treated as a wildcard', (host) => {
    const result = buildDashboardUrls(host, 4747, () => '192.168.1.20')
    expect(result.url).not.toContain('192.168.1.20')
    expect(result.localUrl).toBe(result.url)
  })

  test('default lanIpResolver is used when omitted', () => {
    const result = buildDashboardUrls('0.0.0.0', 4747)
    expect(
      /^http:\/\/(\d{1,3}\.){3}\d{1,3}:4747$/.test(result.url) ||
        result.url === 'http://localhost:4747',
    ).toBe(true)
    expect(result.exposed).toBe(true)
  })
})

describe('resolvePrimaryLanIpv4', () => {
  const iface = (address: string, internal = false): NetworkInterfaceInfo[] => [
    {
      address,
      family: 'IPv4',
      internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: `${address}/24`,
    },
  ]

  test('skips loopback and link-local addresses', () => {
    expect(
      resolvePrimaryLanIpv4({
        lo0: iface('127.0.0.1', true),
        en5: iface('169.254.10.1'),
      }),
    ).toBeNull()
  })

  test('prefers a physical interface over a VPN tunnel', () => {
    expect(
      resolvePrimaryLanIpv4({
        utun3: iface('100.101.102.103'),
        en0: iface('192.168.1.88'),
      }),
    ).toBe('192.168.1.88')
  })

  test('prefers a physical interface over a container bridge', () => {
    expect(
      resolvePrimaryLanIpv4({
        docker0: iface('172.17.0.1'),
        eth0: iface('192.168.1.88'),
      }),
    ).toBe('192.168.1.88')
  })

  test('prefers an RFC1918 address over a public one on equally physical interfaces', () => {
    expect(
      resolvePrimaryLanIpv4({
        en1: iface('203.0.113.5'),
        en0: iface('192.168.1.88'),
      }),
    ).toBe('192.168.1.88')
  })

  test('ties are broken by interface name so the choice is deterministic', () => {
    const interfaces = {
      en7: iface('192.168.1.2'),
      en0: iface('192.168.1.88'),
    }
    expect(resolvePrimaryLanIpv4(interfaces)).toBe('192.168.1.88')
    expect(resolvePrimaryLanIpv4({ en0: interfaces.en0, en7: interfaces.en7 })).toBe('192.168.1.88')
  })

  test('falls back to a tunnel address when it is the only candidate', () => {
    expect(resolvePrimaryLanIpv4({ utun3: iface('100.101.102.103') })).toBe('100.101.102.103')
  })

  test('the real machine resolves to null or a routable IPv4', () => {
    const result = resolvePrimaryLanIpv4()
    if (result === null) return
    expect(result).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/)
    expect(result).not.toBe('127.0.0.1')
    expect(result.startsWith('169.254.')).toBe(false)
  })
})

describe('describeDashboardBinding', () => {
  test('loopback bind yields only url', () => {
    expect(
      describeDashboardBinding({
        url: 'http://localhost:4747',
        localUrl: 'http://localhost:4747',
        exposed: false,
      }),
    ).toEqual({ url: 'http://localhost:4747' })
  })

  test('wildcard bind yields url, localUrl, and warning', () => {
    expect(
      describeDashboardBinding({
        url: 'http://192.168.1.20:4747',
        localUrl: 'http://localhost:4747',
        exposed: true,
      }),
    ).toEqual({
      url: 'http://192.168.1.20:4747',
      localUrl: 'http://localhost:4747',
      warning: DASHBOARD_EXPOSED_WARNING,
    })
  })

  test('concrete non-loopback bind yields url and warning without localUrl', () => {
    const url = 'http://192.168.1.20:4747'
    const notice = describeDashboardBinding({ url, localUrl: url, exposed: true })
    expect(notice.url).toBe(url)
    expect(notice.warning).toBe(DASHBOARD_EXPOSED_WARNING)
    expect(notice).not.toHaveProperty('localUrl')
  })
})
