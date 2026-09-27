import type { Logger } from '../types'
import { processShared, projectLoopKey } from '../utils/process-shared'

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

const inFlight = processShared('prompt-in-flight.v2', () => new Map<string, InFlightEntry>())

export function markPromptInFlight(projectId: string, loopName: string, sessionId: string, agent: PromptAgent): void {
  inFlight.set(projectLoopKey(projectId, loopName), { sessionId, agent, startedAt: Date.now() })
}

export function clearPromptInFlight(projectId: string, loopName: string): void {
  inFlight.delete(projectLoopKey(projectId, loopName))
}

export function clearPromptInFlightBySession(projectId: string, loopName: string, sessionId: string): boolean {
  const key = projectLoopKey(projectId, loopName)
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
  loopName: string,
  sessionId: string,
  agent: PromptAgent,
): boolean {
  const key = projectLoopKey(projectId, loopName)
  const entry = inFlight.get(key)
  if (!entry) return false
  if (entry.sessionId === sessionId && entry.agent === agent) {
    inFlight.delete(key)
    return true
  }
  return false
}

export function getPromptInFlight(projectId: string, loopName: string): InFlightEntry | undefined {
  return inFlight.get(projectLoopKey(projectId, loopName))
}

export function assertNoPromptInFlight(
  projectId: string,
  loopName: string,
  attemptedSessionId: string,
  attemptedAgent: PromptAgent,
  logger: Logger,
): void {
  const prior = inFlight.get(projectLoopKey(projectId, loopName))
  if (!prior) return
  logger.error(
    `[in-flight-guard] concurrent prompt rejected loop=${loopName} ` +
    `prior=${prior.agent}: ${prior.sessionId} attempted=${attemptedAgent}: ${attemptedSessionId}`,
  )
  throw new ConcurrentPromptError(loopName, prior.sessionId, prior.agent, attemptedSessionId, attemptedAgent)
}

export async function withInFlightGuard<T>(
  projectId: string,
  loopName: string,
  sessionId: string,
  agent: PromptAgent,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  assertNoPromptInFlight(projectId, loopName, sessionId, agent, logger)
  markPromptInFlight(projectId, loopName, sessionId, agent)
  try {
    return await fn()
  } finally {
    clearPromptInFlightIfMatches(projectId, loopName, sessionId, agent)
  }
}

// Test-only: clear all state.
export function __resetInFlightGuard(): void {
  inFlight.clear()
}
