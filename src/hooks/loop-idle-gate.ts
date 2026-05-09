import type { Logger } from '../types'

export const sessionsAwaitingBusy = new Map<string, { sessionId: string; sentAt: number }>()

export const AWAITING_BUSY_TIMEOUT_MS = 10000

export function markPromptSent(loopName: string, sessionId: string, logger: Logger): void {
  sessionsAwaitingBusy.set(loopName, { sessionId, sentAt: Date.now() })
  logger.debug(`[idle-gate] prompt sent loop=${loopName} session=${sessionId}, awaiting busy`)
}

export function clearPromptPending(loopName: string, logger: Logger): void {
  if (sessionsAwaitingBusy.delete(loopName)) {
    logger.debug(`[idle-gate] cleared pending for loop=${loopName}`)
  }
}

export function isAwaitingBusy(loopName: string, sessionId: string): boolean {
  const pending = sessionsAwaitingBusy.get(loopName)
  return !!pending && pending.sessionId === sessionId
}

export function isAwaitingBusyExpired(loopName: string): boolean {
  const pending = sessionsAwaitingBusy.get(loopName)
  return !!pending && Date.now() - pending.sentAt > AWAITING_BUSY_TIMEOUT_MS
}
