import { describe, test, expect, vi, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NETGW_EVENTS_FILE,
  NETGW_PID_FILE,
  NETGW_RULES_FILE,
  buildNetgwConfig,
  buildNetgwRules,
  ensureNetgwRunning,
  formatBlockedEvent,
  gatewaySocketPath,
  readNetgwBlockedEvents,
  writeNetgwFiles,
} from '../../src/sandbox/macos-netgw'
import { isProcessAlive, spawnDetached } from '../../src/sandbox/process'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-netgw-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function blockedEvent(dst: string) {
  return {
    t: '2026-01-01T00:00:00Z',
    event: 'blocked',
    reason: 'deny-list',
    proto: 'tcp',
    dst,
  }
}

describe('buildNetgwRules', () => {
  test('an absent allow list denies everything', () => {
    expect(buildNetgwRules(undefined, logger)).toEqual({
      version: 1,
      rules: [],
      default_accept: false,
      block_host_addrs: true,
      domains: { allow: [] },
    })
  })

  test('an empty allow list denies everything', () => {
    const rules = buildNetgwRules([], logger)
    expect(rules.default_accept).toBe(false)
    expect(rules.rules).toEqual([])
    expect(rules.domains).toEqual({ allow: [] })
  })

  test('a wildcard allow list opens egress and skips parsing', () => {
    const rules = buildNetgwRules(['*'], logger)
    expect(rules).toEqual({
      version: 1,
      rules: [],
      default_accept: true,
      block_host_addrs: true,
      domains: { allow: [] },
    })
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('domains map from wildcard, suffix, and domain forms', () => {
    expect(buildNetgwRules(['example.com'], logger).domains.allow).toEqual(['example.com'])
    expect(buildNetgwRules(['*.example.com'], logger).domains.allow).toEqual(['*.example.com'])
    expect(buildNetgwRules(['suffix=example.com'], logger).domains.allow).toEqual([
      'example.com',
      '*.example.com',
    ])
    expect(buildNetgwRules(['domain=intranet'], logger).domains.allow).toEqual(['intranet'])
  })

  test('duplicate domains keep first-seen order', () => {
    const rules = buildNetgwRules(['suffix=example.com', 'example.com', '*.example.com'], logger)
    expect(rules.domains.allow).toEqual(['example.com', '*.example.com'])
  })

  test('addresses and CIDRs become allow-list rules', () => {
    const rules = buildNetgwRules(['10.0.0.0/8', '1.2.3.4', 'fd00::/8', '::1'], logger)
    expect(rules.rules).toEqual([
      { net: '10.0.0.0/8', accept: true, reason: 'allow-list' },
      { net: '1.2.3.4', accept: true, reason: 'allow-list' },
      { net: 'fd00::/8', accept: true, reason: 'allow-list' },
      { net: '::1', accept: true, reason: 'allow-list' },
    ])
    expect(rules.domains.allow).toEqual([])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('invalid prefix lengths are skipped and logged', () => {
    const rules = buildNetgwRules(['10.0.0.0/33', 'fd00::/129', '10.0.0.0/abc'], logger)
    expect(rules.rules).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(3)
  })

  test('rejected entries produce no rule or domain and are logged', () => {
    const rules = buildNetgwRules(
      ['host:443', 'a,b', 'user@host', 'https://example.com', '*.com', 'localhost'],
      logger,
    )
    expect(rules.rules).toEqual([])
    expect(rules.domains.allow).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(6)
  })
})

describe('buildNetgwConfig', () => {
  test('builds the fixed gateway config around the net dir socket', () => {
    const netDir = '/data/macos/net'
    expect(buildNetgwConfig(netDir)).toEqual({
      subnet: '192.168.127.0/24',
      gateway_ip: '192.168.127.1',
      gateway_mac: '5a:94:ef:e4:0c:dd',
      rules: 'netgw-rules.json',
      listen: { vfkit: `unixgram://${join(netDir, 'net.sock')}` },
      events: 'network-events.jsonl',
      pid_file: 'netgw.pid',
    })
  })

  test('gatewaySocketPath points at the gateway socket', () => {
    expect(gatewaySocketPath('/data/macos/net')).toBe('/data/macos/net/net.sock')
  })
})

describe('writeNetgwFiles', () => {
  test('creates the net dir with mode 0700 and writes both files', () => {
    const root = makeTempDir()
    const netDir = join(root, 'net')

    writeNetgwFiles(netDir, ['example.com'], logger)

    expect(statSync(netDir).mode & 0o777).toBe(0o700)
    const config = JSON.parse(readFileSync(join(netDir, 'netgw.json'), 'utf-8'))
    expect(config.listen.vfkit).toBe(`unixgram://${join(netDir, 'net.sock')}`)
    const rules = JSON.parse(readFileSync(join(netDir, NETGW_RULES_FILE), 'utf-8'))
    expect(rules.domains).toEqual({ allow: ['example.com'] })
    expect(rules.default_accept).toBe(false)
  })

  test('does not rewrite an unchanged rules file', async () => {
    const netDir = makeTempDir()
    const rulesPath = join(netDir, NETGW_RULES_FILE)

    writeNetgwFiles(netDir, ['example.com'], logger)
    const before = readFileSync(rulesPath, 'utf-8')
    const mtime = statSync(rulesPath).mtimeMs
    await delay(30)
    writeNetgwFiles(netDir, ['example.com'], logger)

    expect(statSync(rulesPath).mtimeMs).toBe(mtime)
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)

    writeNetgwFiles(netDir, ['other.com'], logger)
    expect(readFileSync(rulesPath, 'utf-8')).not.toBe(before)
    expect(JSON.parse(readFileSync(rulesPath, 'utf-8')).domains).toEqual({ allow: ['other.com'] })
  })
})

describe('ensureNetgwRunning', () => {
  test('reuses a live pid from the pid file without spawning', () => {
    const netDir = makeTempDir()
    const pid = spawnDetached('sleep', ['5'], { logger, logLabel: 'netgw-test-sleep' })
    if (pid === null) throw new Error('failed to start the sleep fixture')
    const pidPath = join(netDir, NETGW_PID_FILE)
    writeFileSync(pidPath, String(pid))
    try {
      const spawn = vi.fn(() => 999)
      ensureNetgwRunning({ netDir, netgwPath: '/bin/netgw', logger, spawn })
      expect(spawn).not.toHaveBeenCalled()
      expect(readFileSync(pidPath, 'utf-8')).toBe(String(pid))
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  })

  test('spawns netgw when the pid file is absent and records the pid', () => {
    const netDir = makeTempDir()
    const calls: Array<{ command: string; args: string[] }> = []
    const spawn = (command: string, args: string[]) => {
      calls.push({ command, args })
      return 4242
    }

    ensureNetgwRunning({ netDir, netgwPath: '/bin/netgw', logger, spawn })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('/bin/netgw')
    expect(calls[0]!.args).toEqual(['-config', join(netDir, 'netgw.json')])
    expect(readFileSync(join(netDir, NETGW_PID_FILE), 'utf-8')).toBe('4242')
  })

  test('respawns when the recorded pid is no longer alive', async () => {
    const netDir = makeTempDir()
    const pid = spawnDetached('sleep', ['5'], { logger, logLabel: 'netgw-test-dead-sleep' })
    if (pid === null) throw new Error('failed to start the sleep fixture')
    writeFileSync(join(netDir, NETGW_PID_FILE), String(pid))
    try {
      process.kill(pid, 'SIGKILL')
      let alive = true
      for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
        await delay(25)
        alive = isProcessAlive(pid)
      }
      expect(alive).toBe(false)

      const calls: Array<{ command: string; args: string[] }> = []
      const spawn = (command: string, args: string[]) => {
        calls.push({ command, args })
        return 6363
      }

      ensureNetgwRunning({ netDir, netgwPath: '/bin/netgw', logger, spawn })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toEqual(['-config', join(netDir, 'netgw.json')])
      expect(readFileSync(join(netDir, NETGW_PID_FILE), 'utf-8')).toBe('6363')
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  test('treats an unparseable pid file as not running', () => {
    const netDir = makeTempDir()
    writeFileSync(join(netDir, NETGW_PID_FILE), 'not-a-pid')
    const spawn = vi.fn(() => 5252)

    ensureNetgwRunning({ netDir, netgwPath: '/bin/netgw', logger, spawn })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(netDir, NETGW_PID_FILE), 'utf-8')).toBe('5252')
  })

  test('logs a failed spawn and leaves no pid behind', () => {
    const netDir = makeTempDir()
    const spawn = vi.fn(() => null)

    ensureNetgwRunning({ netDir, netgwPath: '/bin/netgw', logger, spawn })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(existsSync(join(netDir, NETGW_PID_FILE))).toBe(false)
    expect(logger.log).toHaveBeenCalledTimes(1)
  })
})

describe('readNetgwBlockedEvents', () => {
  test('returns no events and offset zero when the events file is missing', () => {
    const netDir = makeTempDir()
    expect(readNetgwBlockedEvents(netDir, 5)).toEqual({ events: [], nextOffset: 0 })
  })

  test('reads only blocked events from complete lines', () => {
    const netDir = makeTempDir()
    const eventsPath = join(netDir, NETGW_EVENTS_FILE)
    const lines = [
      JSON.stringify(blockedEvent('10.0.0.1:443')),
      JSON.stringify({ ...blockedEvent('10.0.0.2:443'), event: 'allowed' }),
      'not json',
      JSON.stringify({ foo: 1 }),
      JSON.stringify(blockedEvent('10.0.0.3:443')),
    ]
    writeFileSync(eventsPath, `${lines.join('\n')}\n`)

    const first = readNetgwBlockedEvents(netDir, 0)

    expect(first.events.map((event) => event.dst)).toEqual(['10.0.0.1:443', '10.0.0.3:443'])
    expect(first.nextOffset).toBe(statSync(eventsPath).size)

    appendFileSync(eventsPath, `${JSON.stringify(blockedEvent('10.0.0.4:443'))}\n`)
    const second = readNetgwBlockedEvents(netDir, first.nextOffset)
    expect(second.events.map((event) => event.dst)).toEqual(['10.0.0.4:443'])
    expect(second.nextOffset).toBe(statSync(eventsPath).size)
  })

  test('leaves a partial trailing line for the next read', () => {
    const netDir = makeTempDir()
    const eventsPath = join(netDir, NETGW_EVENTS_FILE)
    const first = blockedEvent('10.0.0.1:443')
    const second = blockedEvent('10.0.0.2:443')
    writeFileSync(eventsPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}`)

    const partial = readNetgwBlockedEvents(netDir, 0)
    expect(partial.events.map((event) => event.dst)).toEqual(['10.0.0.1:443'])
    expect(partial.nextOffset).toBe(`${JSON.stringify(first)}\n`.length)

    appendFileSync(eventsPath, '\n')
    const complete = readNetgwBlockedEvents(netDir, partial.nextOffset)
    expect(complete.events.map((event) => event.dst)).toEqual(['10.0.0.2:443'])
    expect(complete.nextOffset).toBe(statSync(eventsPath).size)
  })

  test('restarts from zero when the file shrank past the offset', () => {
    const netDir = makeTempDir()
    const eventsPath = join(netDir, NETGW_EVENTS_FILE)
    writeFileSync(
      eventsPath,
      `${JSON.stringify(blockedEvent('10.0.0.1:443'))}\n${JSON.stringify(blockedEvent('10.0.0.2:443'))}\n`,
    )
    const stale = readNetgwBlockedEvents(netDir, 0)
    expect(stale.events).toHaveLength(2)

    writeFileSync(eventsPath, `${JSON.stringify(blockedEvent('10.0.0.9:443'))}\n`)
    const rotated = readNetgwBlockedEvents(netDir, stale.nextOffset)
    expect(rotated.events.map((event) => event.dst)).toEqual(['10.0.0.9:443'])
    expect(rotated.nextOffset).toBe(statSync(eventsPath).size)
  })
})

describe('formatBlockedEvent', () => {
  test('includes the protocol when present', () => {
    expect(formatBlockedEvent(blockedEvent('10.0.0.1:443'))).toBe(
      'Sandbox egress blocked: 10.0.0.1:443 (tcp deny-list) at 2026-01-01T00:00:00Z',
    )
  })

  test('omits the protocol when absent', () => {
    const { proto: _proto, ...event } = blockedEvent('10.0.0.1:443')
    expect(formatBlockedEvent(event)).toBe(
      'Sandbox egress blocked: 10.0.0.1:443 (deny-list) at 2026-01-01T00:00:00Z',
    )
  })
})
