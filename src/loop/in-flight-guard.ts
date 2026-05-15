import type { Logger } from '../types'

export type PromptAgent = 'code' | 'auditor-loop' | 'decomposer'

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

const inFlight = new Map<string, InFlightEntry>()

export function markPromptInFlight(loopName: string, sessionId: string, agent: PromptAgent): void {
  inFlight.set(loopName, { sessionId, agent, startedAt: Date.now() })
}

export function clearPromptInFlight(loopName: string): void {
  inFlight.delete(loopName)
}

export function clearPromptInFlightIfMatches(
  loopName: string,
  sessionId: string,
  agent: PromptAgent,
): boolean {
  const entry = inFlight.get(loopName)
  if (!entry) return false
  if (entry.sessionId === sessionId && entry.agent === agent) {
    inFlight.delete(loopName)
    return true
  }
  return false
}

export function getPromptInFlight(loopName: string): InFlightEntry | undefined {
  return inFlight.get(loopName)
}

export function assertNoPromptInFlight(
  loopName: string,
  attemptedSessionId: string,
  attemptedAgent: PromptAgent,
  logger: Logger,
): void {
  const prior = inFlight.get(loopName)
  if (!prior) return
  logger.error(
    `[in-flight-guard] concurrent prompt rejected loop=${loopName} ` +
    `prior=${prior.agent}: ${prior.sessionId} attempted=${attemptedAgent}: ${attemptedSessionId}`,
  )
  throw new ConcurrentPromptError(loopName, prior.sessionId, prior.agent, attemptedSessionId, attemptedAgent)
}

// Test-only: clear all state.
export function __resetInFlightGuard(): void {
  inFlight.clear()
}
