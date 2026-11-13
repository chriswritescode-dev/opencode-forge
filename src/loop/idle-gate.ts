import type { Logger } from '../types'
import { processShared, projectLoopKey } from '../utils/process-shared'

export type IdleGateStore = {
  sessionsAwaitingBusy: Map<string, { sessionId: string; sentAt: number }>
  queuedPrompts: Map<string, Map<string, number>>
  suppressedIdles: Set<string>
}

const store = processShared('idle-gate.v2', () => ({
  sessionsAwaitingBusy: new Map(),
  queuedPrompts: new Map(),
  suppressedIdles: new Set(),
}))

const sessionsAwaitingBusy = store.sessionsAwaitingBusy

export const AWAITING_BUSY_TIMEOUT_MS = 10000

export const QUEUED_PROMPT_MAX_AGE_MS = 10 * 60 * 1000

const queuedPrompts = store.queuedPrompts
const suppressedIdles = store.suppressedIdles

function sweepExpiredQueuedPrompts(now: number): void {
  for (const [sessionId, items] of queuedPrompts) {
    for (const [inboxId, enqueuedAt] of items) {
      if (now - enqueuedAt > QUEUED_PROMPT_MAX_AGE_MS) items.delete(inboxId)
    }
    if (items.size === 0) queuedPrompts.delete(sessionId)
  }
}

export function recordInboxEnqueued(sessionId: string, inboxId: string, now = Date.now()): void {
  sweepExpiredQueuedPrompts(now)
  let items = queuedPrompts.get(sessionId)
  if (!items) {
    items = new Map()
    queuedPrompts.set(sessionId, items)
  }
  items.set(inboxId, now)
}

export function recordInboxSettled(sessionId: string, inboxId: string): void {
  const items = queuedPrompts.get(sessionId)
  if (!items) return
  items.delete(inboxId)
  if (items.size === 0) queuedPrompts.delete(sessionId)
}

export function isPromptQueued(sessionId: string, now = Date.now()): boolean {
  const items = queuedPrompts.get(sessionId)
  if (!items) return false
  for (const [inboxId, enqueuedAt] of items) {
    if (now - enqueuedAt > QUEUED_PROMPT_MAX_AGE_MS) items.delete(inboxId)
  }
  if (items.size === 0) {
    queuedPrompts.delete(sessionId)
    return false
  }
  return true
}

export function recordSuppressedIdle(sessionId: string): void {
  suppressedIdles.add(sessionId)
}

export function hasSuppressedIdle(sessionId: string): boolean {
  return suppressedIdles.has(sessionId)
}

export function clearSuppressedIdle(sessionId: string): void {
  suppressedIdles.delete(sessionId)
}

export function consumeSuppressedIdle(sessionId: string): boolean {
  return suppressedIdles.delete(sessionId)
}

export function clearIdleGateForSession(sessionId: string): void {
  queuedPrompts.delete(sessionId)
  suppressedIdles.delete(sessionId)
}

export function __resetIdleGate(): void {
  sessionsAwaitingBusy.clear()
  queuedPrompts.clear()
  suppressedIdles.clear()
}

export function markPromptSent(projectId: string, loopName: string, sessionId: string, logger: Logger): void {
  sessionsAwaitingBusy.set(projectLoopKey(projectId, loopName), { sessionId, sentAt: Date.now() })
  logger.debug(`[idle-gate] prompt sent loop=${loopName} session=${sessionId}, awaiting busy`)
}

export function clearPromptPending(projectId: string, loopName: string, logger: Logger): void {
  if (sessionsAwaitingBusy.delete(projectLoopKey(projectId, loopName))) {
    logger.debug(`[idle-gate] cleared pending for loop=${loopName}`)
  }
}

export function isAwaitingBusy(projectId: string, loopName: string, sessionId: string): boolean {
  const pending = sessionsAwaitingBusy.get(projectLoopKey(projectId, loopName))
  return !!pending && pending.sessionId === sessionId
}

export function isAwaitingBusyExpired(projectId: string, loopName: string): boolean {
  const pending = sessionsAwaitingBusy.get(projectLoopKey(projectId, loopName))
  return !!pending && Date.now() - pending.sentAt > AWAITING_BUSY_TIMEOUT_MS
}
