import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { processShared, projectLoopKey } from '../utils/process-shared'

const ownerToken = processShared('start-owner.v1', () => randomUUID())
const startsInFlight = processShared('start-in-flight.v1', () => new Set<string>())

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
