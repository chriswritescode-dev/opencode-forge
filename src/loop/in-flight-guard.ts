import type { Logger } from '../types'
import { deleteLoopLaneEntries, processShared, projectLoopLaneKey } from '../utils/process-shared'
import type { LoopLane } from './section-run'

export type PromptAgent = 'code' | 'auditor-loop'

export class ConcurrentPromptError extends Error {
  readonly code = 'concurrent_prompt'
  constructor(
    public readonly loopName: string,
    public readonly priorSessionId: string,
    public readonly priorAgent: PromptAgent,
    public readonly attemptedSessionId: string,
    public readonly attemptedAgent: PromptAgent,
  ) {
    super(
      `Concurrent agent prompt rejected for loop=${loopName}: ` +
      `prior ${priorAgent} on session=${priorSessionId} still in-flight, ` +
      `attempted ${attemptedAgent} on session=${attemptedSessionId}`,
    )
    this.name = 'ConcurrentPromptError'
  }
}

interface InFlightEntry {
  sessionId: string
  agent: PromptAgent
  startedAt: number
}

const inFlight = processShared('prompt-in-flight.v3', () => new Map<string, InFlightEntry>())

export function markPromptInFlight(projectId: string, lane: LoopLane, sessionId: string, agent: PromptAgent): void {
  inFlight.set(projectLoopLaneKey(projectId, lane), { sessionId, agent, startedAt: Date.now() })
}

export function clearPromptInFlight(projectId: string, lane: LoopLane): void {
  inFlight.delete(projectLoopLaneKey(projectId, lane))
}

export function clearPromptInFlightBySession(projectId: string, lane: LoopLane, sessionId: string): boolean {
  const key = projectLoopLaneKey(projectId, lane)
  const entry = inFlight.get(key)
  if (!entry) return false
  if (entry.sessionId === sessionId) {
    inFlight.delete(key)
    return true
  }
  return false
}

export function clearPromptInFlightIfMatches(
  projectId: string,
  lane: LoopLane,
  sessionId: string,
  agent: PromptAgent,
): boolean {
  const key = projectLoopLaneKey(projectId, lane)
  const entry = inFlight.get(key)
  if (!entry) return false
  if (entry.sessionId === sessionId && entry.agent === agent) {
    inFlight.delete(key)
    return true
  }
  return false
}

export function getPromptInFlight(projectId: string, lane: LoopLane): InFlightEntry | undefined {
  return inFlight.get(projectLoopLaneKey(projectId, lane))
}

/** Clears the in-flight entry of every section run of one loop. */
export function clearLoopPromptInFlight(projectId: string, loopName: string): void {
  deleteLoopLaneEntries(inFlight, projectId, loopName)
}

export function assertNoPromptInFlight(
  projectId: string,
  lane: LoopLane,
  attemptedSessionId: string,
  attemptedAgent: PromptAgent,
  logger: Logger,
): void {
  const prior = inFlight.get(projectLoopLaneKey(projectId, lane))
  if (!prior) return
  logger.error(
    `[in-flight-guard] concurrent prompt rejected loop=${lane.loopName} ` +
    `prior=${prior.agent}: ${prior.sessionId} attempted=${attemptedAgent}: ${attemptedSessionId}`,
  )
  throw new ConcurrentPromptError(lane.loopName, prior.sessionId, prior.agent, attemptedSessionId, attemptedAgent)
}

export async function withInFlightGuard<T>(
  projectId: string,
  lane: LoopLane,
  sessionId: string,
  agent: PromptAgent,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  assertNoPromptInFlight(projectId, lane, sessionId, agent, logger)
  markPromptInFlight(projectId, lane, sessionId, agent)
  try {
    return await fn()
  } finally {
    clearPromptInFlightIfMatches(projectId, lane, sessionId, agent)
  }
}

// Test-only: clear all state.
export function __resetInFlightGuard(): void {
  inFlight.clear()
}
