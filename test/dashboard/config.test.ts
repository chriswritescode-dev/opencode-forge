import { describe, test, expect } from 'vitest'
import {
  resolveDashboardConfig,
  isValidDashboardPort,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  isWildcardHost,
  isLoopbackHost,
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
    })
  })

  test('empty config object resolves to built-in defaults', () => {
    expect(resolveDashboardConfig({})).toEqual({
      host: 'localhost',
      port: 4747,
    })
  })

  test('dashboard config host and port are honoured', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '0.0.0.0', port: 8080 } }),
    ).toEqual({ host: '0.0.0.0', port: 8080 })
  })

  test('explicit overrides win over dashboard config', () => {
    expect(
      resolveDashboardConfig(
        { dashboard: { host: '0.0.0.0', port: 8080 } },
        { host: '127.0.0.1', port: 9000 },
      ),
    ).toEqual({ host: '127.0.0.1', port: 9000 })
  })

  test('whitespace-only override host falls through to config host', () => {
    expect(
      resolveDashboardConfig(
        { dashboard: { host: '192.168.1.5' } },
        { host: '   ' },
      ),
    ).toEqual({ host: '192.168.1.5', port: 4747 })
  })

  test('blank host in both override and config falls back to default', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '' } }, { host: '' }),
    ).toEqual({ host: 'localhost', port: 4747 })
  })

  test('host values are trimmed', () => {
    expect(
      resolveDashboardConfig({ dashboard: { host: '  0.0.0.0  ' } }),
    ).toEqual({ host: '0.0.0.0', port: 4747 })
  })

  test('NaN override port falls through to config port', () => {
    expect(
      resolveDashboardConfig({ dashboard: { port: 8080 } }, { port: Number.NaN }),
    ).toEqual({ host: 'localhost', port: 8080 })
  })

  test('fractional override port falls through to config port', () => {
    expect(
      resolveDashboardConfig({ dashboard: { port: 8080 } }, { port: 1.5 }),
    ).toEqual({ host: 'localhost', port: 8080 })
  })

  test('negative override port falls through to config port', () => {
    expect(
      resolveDashboardConfig({ dashboard: { port: 8080 } }, { port: -1 }),
    ).toEqual({ host: 'localhost', port: 8080 })
  })

  test('out-of-range override port falls through to config port', () => {
    expect(
      resolveDashboardConfig({ dashboard: { port: 8080 } }, { port: 65536 }),
    ).toEqual({ host: 'localhost', port: 8080 })
  })

  test('invalid port in both override and config falls back to default', () => {
    expect(
      resolveDashboardConfig({ dashboard: { port: -3 } }, { port: Number.NaN }),
    ).toEqual({ host: 'localhost', port: 4747 })
  })

  test('port: 0 override is honoured as ephemeral', () => {
    expect(
      resolveDashboardConfig(undefined, { port: 0 }),
    ).toEqual({ host: 'localhost', port: 0 })
  })

  test('defaults are exported', () => {
    expect(DEFAULT_DASHBOARD_HOST).toBe('localhost')
    expect(DEFAULT_DASHBOARD_PORT).toBe(4747)
  })
})

describe('isValidDashboardPort', () => {
  test.each([0, 1, 4747, 65535])('returns true for %p', (value) => {
    expect(isValidDashboardPort(value)).toBe(true)
  })

  test.each([-1, 65536, 1.5, Number.NaN, '4747', undefined, null])(
    'returns false for %p',
    (value) => {
      expect(isValidDashboardPort(value)).toBe(false)
    },
  )
})

describe('isWildcardHost', () => {
  test.each(['0.0.0.0', '::', '*', '', '  0.0.0.0  '])('returns true for %p', (host) => {
    expect(isWildcardHost(host)).toBe(true)
  })

  test.each(['localhost', '127.0.0.1', '192.168.1.20', '::1'])(
    'returns false for %p',
    (host) => {
      expect(isWildcardHost(host)).toBe(false)
    },
  )
})

describe('isLoopbackHost', () => {
  test.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '  localhost  '])(
    'returns true for %p',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true)
    },
  )

  test.each(['0.0.0.0', '192.168.1.20', '10.0.0.5', 'example.local'])(
    'returns false for %p',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false)
    },
  )
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
  test('returns null or a non-loopback non-link-local IPv4 string', () => {
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
