import { z } from 'zod'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { isIP } from 'net'
import { join } from 'path'
import type { Logger } from '../types'
import { egressAllowsAll } from './msb'
import { isProcessAlive, spawnDetached } from './process'

export const NETGW_CONFIG_FILE = 'netgw.json'
export const NETGW_RULES_FILE = 'netgw-rules.json'
export const NETGW_EVENTS_FILE = 'network-events.jsonl'
export const NETGW_PID_FILE = 'netgw.pid'
export const NETGW_SOCKET_FILE = 'net.sock'

export interface NetgwRule {
  net: string
  accept: true
  reason: 'allow-list'
}

export interface NetgwRules {
  version: 1
  rules: NetgwRule[]
  default_accept: boolean
  block_host_addrs: true
  domains: { allow: string[] }
}

export interface NetgwConfig {
  subnet: string
  gateway_ip: string
  gateway_mac: string
  rules: string
  listen: { vfkit: string }
  events: string
  pid_file: string
}

const HOSTNAME_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

function isDottedHostname(host: string): boolean {
  const labels = host.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => HOSTNAME_LABEL_RE.test(label))
}

function isDomainName(name: string): boolean {
  return name.split('.').every((label) => HOSTNAME_LABEL_RE.test(label))
}

function isAddress(entry: string): boolean {
  const version = isIP(entry)
  return version === 4 || version === 6
}

function isCidr(entry: string): boolean {
  const slash = entry.lastIndexOf('/')
  if (slash < 0) return false
  const host = entry.slice(0, slash)
  const prefixText = entry.slice(slash + 1)
  if (!/^\d+$/.test(prefixText)) return false
  const version = isIP(host)
  const prefix = Number(prefixText)
  if (version === 4) return prefix <= 32
  if (version === 6) return prefix <= 128
  return false
}

function ruleSkipReason(entry: string): string {
  if (entry.includes('://')) return 'scheme URLs are not egress hosts'
  if (entry.includes(',')) return 'commas separate rule tokens, not hosts'
  if (entry.includes(':')) return 'port-qualified hosts need the tcp/udp rule form'
  if (entry.includes('@')) return 'the @ character is reserved for rule targets'
  if (entry === '*' || entry === '**') return 'the bare wildcard is not a valid egress host'
  if (entry.startsWith('*.')) return 'wildcard suffixes need at least two labels'
  if (entry.startsWith('suffix=')) return 'suffix= domains need at least two labels'
  if (!entry.includes('.')) return 'bare single-label hosts are ambiguous; use domain=name'
  return 'not a valid address, CIDR, or hostname'
}

export function buildNetgwRules(allow: string[] | undefined, logger: Logger): NetgwRules {
  const defaultAccept = egressAllowsAll(allow)
  const rules: NetgwRule[] = []
  const domains: string[] = []

  function addDomain(domain: string): void {
    if (!domains.includes(domain)) domains.push(domain)
  }

  if (!defaultAccept) {
    for (const raw of allow ?? []) {
      const entry = raw.trim()
      if (!entry) {
        logger.log('Sandbox: skipping empty egress rule entry')
        continue
      }
      if (isAddress(entry) || isCidr(entry)) {
        if (!rules.some((rule) => rule.net === entry)) {
          rules.push({ net: entry, accept: true, reason: 'allow-list' })
        }
        continue
      }
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(2)
        if (isDottedHostname(suffix)) addDomain(entry)
        else logger.log(`Sandbox: skipping egress entry ${JSON.stringify(entry)}: ${ruleSkipReason(entry)}`)
        continue
      }
      if (entry.startsWith('suffix=')) {
        const base = entry.slice('suffix='.length)
        if (isDottedHostname(base)) {
          addDomain(base)
          addDomain(`*.${base}`)
        } else {
          logger.log(`Sandbox: skipping egress entry ${JSON.stringify(entry)}: ${ruleSkipReason(entry)}`)
        }
        continue
      }
      if (entry.startsWith('domain=')) {
        const name = entry.slice('domain='.length)
        if (isDomainName(name)) addDomain(name)
        else logger.log(`Sandbox: skipping egress entry ${JSON.stringify(entry)}: ${ruleSkipReason(entry)}`)
        continue
      }
      if (isDottedHostname(entry)) {
        addDomain(entry)
        continue
      }
      logger.log(`Sandbox: skipping egress entry ${JSON.stringify(entry)}: ${ruleSkipReason(entry)}`)
    }
  }

  return {
    version: 1,
    rules,
    default_accept: defaultAccept,
    block_host_addrs: true,
    domains: { allow: domains },
  }
}

export function gatewaySocketPath(netDir: string): string {
  return join(netDir, NETGW_SOCKET_FILE)
}

export function buildNetgwConfig(netDir: string): NetgwConfig {
  return {
    subnet: '192.168.127.0/24',
    gateway_ip: '192.168.127.1',
    gateway_mac: '5a:94:ef:e4:0c:dd',
    rules: NETGW_RULES_FILE,
    listen: { vfkit: `unixgram://${gatewaySocketPath(netDir)}` },
    events: NETGW_EVENTS_FILE,
    pid_file: NETGW_PID_FILE,
  }
}

function serializeJson(value: NetgwConfig | NetgwRules): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writeFileAtomic(path: string, contents: string): void {
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, contents, { mode: 0o600 })
  renameSync(tempPath, path)
}

export function writeNetgwFiles(netDir: string, allow: string[] | undefined, logger: Logger): void {
  mkdirSync(netDir, { recursive: true, mode: 0o700 })
  writeFileAtomic(join(netDir, NETGW_CONFIG_FILE), serializeJson(buildNetgwConfig(netDir)))
  const rulesPath = join(netDir, NETGW_RULES_FILE)
  const serialized = serializeJson(buildNetgwRules(allow, logger))
  let current: string | undefined
  try {
    current = readFileSync(rulesPath, 'utf-8')
  } catch {
    current = undefined
  }
  if (current !== serialized) writeFileAtomic(rulesPath, serialized)
}

export interface EnsureNetgwRunningInput {
  netDir: string
  netgwPath: string
  logger: Logger
  spawn?: typeof spawnDetached
}

function readNetgwPid(pidPath: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(pidPath, 'utf-8').trim()
  } catch {
    return undefined
  }
  if (!/^\d+$/.test(raw)) return undefined
  const pid = Number(raw)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function gatewaySocketIsLive(netDir: string): boolean {
  try {
    return statSync(gatewaySocketPath(netDir)).isSocket()
  } catch {
    return false
  }
}

export function ensureNetgwRunning(input: EnsureNetgwRunningInput): void {
  const spawnImpl = input.spawn ?? spawnDetached
  const pidPath = join(input.netDir, NETGW_PID_FILE)
  const pid = readNetgwPid(pidPath)
  if (pid !== undefined && isProcessAlive(pid) && gatewaySocketIsLive(input.netDir)) return
  const spawned = spawnImpl(input.netgwPath, ['-config', join(input.netDir, NETGW_CONFIG_FILE)], {
    cwd: input.netDir,
    logger: input.logger,
    logLabel: 'netgw',
  })
  if (spawned === null) throw new Error(`Failed to start cua-netgw from ${input.netgwPath}`)
  writeFileSync(pidPath, String(spawned), { mode: 0o600 })
}

const netgwEventSchema = z.looseObject({
  t: z.string(),
  event: z.string(),
  reason: z.string(),
  proto: z.string().optional(),
  dst: z.string(),
})

export type NetgwEvent = z.infer<typeof netgwEventSchema>

export interface NetgwBlockedEvents {
  events: NetgwEvent[]
  nextOffset: number
}

export function netgwEventsEndOffset(netDir: string): number {
  try {
    const stats = statSync(join(netDir, NETGW_EVENTS_FILE))
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

function readFileRange(path: string, start: number, length: number): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read)
      if (chunk === 0) break
      read += chunk
    }
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readNetgwBlockedEvents(netDir: string, fromOffset: number): NetgwBlockedEvents {
  const eventsPath = join(netDir, NETGW_EVENTS_FILE)
  let size: number
  try {
    size = statSync(eventsPath).size
  } catch {
    return { events: [], nextOffset: 0 }
  }
  let start = Number.isFinite(fromOffset) && fromOffset > 0 ? Math.floor(fromOffset) : 0
  if (start > size) start = 0
  if (start === size) return { events: [], nextOffset: start }

  const region = readFileRange(eventsPath, start, size - start)
  if (region === null) return { events: [], nextOffset: start }

  const lastNewline = region.lastIndexOf(0x0a)
  if (lastNewline < 0) return { events: [], nextOffset: start }

  const events: NetgwEvent[] = []
  for (const line of region.subarray(0, lastNewline).toString('utf-8').split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = netgwEventSchema.safeParse(value)
    if (!parsed.success) continue
    if (parsed.data.event === 'blocked') events.push(parsed.data)
  }
  return { events, nextOffset: start + lastNewline + 1 }
}

export function formatBlockedEvent(event: NetgwEvent): string {
  const detail = event.proto === undefined ? event.reason : `${event.proto} ${event.reason}`
  return `Sandbox egress blocked: ${event.dst} (${detail}) at ${event.t}`
}
