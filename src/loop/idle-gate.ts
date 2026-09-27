import type { Logger } from '../types'
import { processShared } from '../utils/process-shared'

type IdleGateStore = {
  sessionsAwaitingBusy: Map<string, { sessionId: string; sentAt: number }>
  queuedPrompts: Map<string, Map<string, number>>
}

/**
 * Process-wide: the host instance records an enqueued inbox item and sets the awaiting-busy
 * marker, while the worktree instance that supervises the loop reads them.
 */
const store = processShared<IdleGateStore>('idle-gate.v1', () => ({
  sessionsAwaitingBusy: new Map(),
  queuedPrompts: new Map(),
}))

export const sessionsAwaitingBusy = store.sessionsAwaitingBusy

export const AWAITING_BUSY_TIMEOUT_MS = 10000

/**
 * Upper bound on how long a queued inbox item may suppress an idle. A missed
 * `session.inbox.delivered` event must never hang a loop forever, so entries older
 * than this are pruned when checked.
 */
export const QUEUED_PROMPT_MAX_AGE_MS = 10 * 60 * 1000

const queuedPrompts = store.queuedPrompts

export function recordInboxEnqueued(sessionId: string, inboxId: string, now = Date.now()): void {
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

// Test-only: clear all queued-prompt state.
export function __resetQueuedPrompts(): void {
  queuedPrompts.clear()
}

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
