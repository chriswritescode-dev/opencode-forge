import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { MSB_DEFAULT_TIMEOUT } from '../sandbox/msb'
import { processShared, projectLoopKey } from '../utils/process-shared'
import { SNAPSHOT_TIMEOUT_MS } from './code-graph'

const ownerToken = processShared('start-owner.v1', () => randomUUID())
const startsInFlight = processShared('start-in-flight.v1', () => new Set<string>())

export const START_INTERRUPTED_BACKSTOP_MS = MSB_DEFAULT_TIMEOUT + SNAPSHOT_TIMEOUT_MS + 3 * 60_000

export function currentStartOwner(): string {
  return `${hostname()}:${process.pid}:${ownerToken}`
}

export function markStartInFlight(projectId: string, loopName: string): void {
  startsInFlight.add(projectLoopKey(projectId, loopName))
}

export function clearStartInFlight(projectId: string, loopName: string): void {
  startsInFlight.delete(projectLoopKey(projectId, loopName))
}

export function isStartInFlight(projectId: string, loopName: string): boolean {
  return startsInFlight.has(projectLoopKey(projectId, loopName))
}

export interface InterruptedStartRow {
  projectId: string
  loopName: string
  status: string
  firstPromptSentAt?: string | null
  startOwner?: string | null
  startedAt: string | number
}

export interface InterruptedStartOptions {
  now?: number
  isProcessAlive?: (pid: number) => boolean
}

interface ParsedStartOwner {
  host: string
  pid: number
  token: string
}

function parseStartOwner(owner: string): ParsedStartOwner | null {
  const tokenSeparator = owner.lastIndexOf(':')
  if (tokenSeparator < 0) return null
  const token = owner.slice(tokenSeparator + 1)
  const hostAndPid = owner.slice(0, tokenSeparator)
  const pidSeparator = hostAndPid.lastIndexOf(':')
  if (pidSeparator < 0) return null
  const host = hostAndPid.slice(0, pidSeparator)
  const pidText = hostAndPid.slice(pidSeparator + 1)
  if (!host || !token || !/^\d+$/.test(pidText)) return null
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { host, pid, token }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function startedAtEpochMs(startedAt: string | number): number | null {
  if (typeof startedAt === 'number') {
    return Number.isFinite(startedAt) ? startedAt : null
  }
  const parsed = Date.parse(startedAt)
  return Number.isFinite(parsed) ? parsed : null
}

export function isInterruptedStart(row: InterruptedStartRow, opts: InterruptedStartOptions = {}): boolean {
  if (row.status !== 'running') return false
  if (row.firstPromptSentAt != null) return false
  if (row.startOwner == null) return false
  const owner = parseStartOwner(row.startOwner)
  if (!owner) return false

  if (row.startOwner === currentStartOwner()) {
    return !isStartInFlight(row.projectId, row.loopName)
  }

  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
  if (owner.host === hostname() && !isProcessAlive(owner.pid)) return true

  const startedMs = startedAtEpochMs(row.startedAt)
  if (startedMs === null) return false
  const now = opts.now ?? Date.now()
  return now - startedMs > START_INTERRUPTED_BACKSTOP_MS
}
