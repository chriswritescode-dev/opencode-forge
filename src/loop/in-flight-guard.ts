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
  if (prior.sessionId === attemptedSessionId && prior.agent === attemptedAgent) return
  logger.error(
    `[in-flight-guard] concurrent prompt rejected loop=${loopName} ` +
    `prior=${prior.agent}: ${prior.sessionId} attempted=${attemptedAgent}: ${attemptedSessionId}`,
  )
  throw new ConcurrentPromptError(loopName, prior.sessionId, prior.agent, attemptedSessionId, attemptedAgent)
}

export type InFlightResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConcurrentPromptError }

export async function withInFlightGuard<T>(
  args: { loopName: string; sessionId: string; agent: PromptAgent; logger: Logger },
  body: () => Promise<T>,
): Promise<InFlightResult<T>> {
  const { loopName, sessionId, agent, logger } = args
  try {
    assertNoPromptInFlight(loopName, sessionId, agent, logger)
  } catch (err) {
    if (err instanceof ConcurrentPromptError) return { ok: false, error: err }
    throw err
  }
  markPromptInFlight(loopName, sessionId, agent)
  try {
    const value = await body()
    return { ok: true, value }
  } catch (err) {
    clearPromptInFlight(loopName)
    throw err
  }
}

// Test-only: clear all state.
export function __resetInFlightGuard(): void {
  inFlight.clear()
}
