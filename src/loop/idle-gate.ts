import type { Logger } from '../types'
import { processShared, projectLoopKey } from '../utils/process-shared'

type IdleGateStore = {
  sessionsAwaitingBusy: Map<string, { sessionId: string; sentAt: number }>
  queuedPrompts: Map<string, Map<string, number>>
  suppressedIdles: Set<string>
}

/**
 * Process-wide: the host instance records an enqueued inbox item and sets the awaiting-busy
 * marker, while the worktree instance that supervises the loop reads them. Awaiting-busy
 * entries are keyed by project AND loop name (loop names are only unique within a project);
 * queued prompts and suppressed-idle markers stay keyed by session because a session id is
 * already unique.
 */
const store = processShared<IdleGateStore>('idle-gate.v2', () => ({
  sessionsAwaitingBusy: new Map(),
  queuedPrompts: new Map(),
  suppressedIdles: new Set(),
}))

const sessionsAwaitingBusy = store.sessionsAwaitingBusy

export const AWAITING_BUSY_TIMEOUT_MS = 10000

/**
 * Upper bound on how long a queued inbox item may suppress an idle. A missed
 * `session.inbox.delivered` event must never hang a loop forever, so entries older
 * than this are pruned when checked or when a new item is enqueued.
 */
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

/**
 * Records that an idle was dropped while a prompt was still queued, so a later
 * `session.inbox.cancelled` that empties the queue can replay it exactly once.
 */
export function recordSuppressedIdle(sessionId: string): void {
  suppressedIdles.add(sessionId)
}

export function hasSuppressedIdle(sessionId: string): boolean {
  return suppressedIdles.has(sessionId)
}

export function clearSuppressedIdle(sessionId: string): void {
  suppressedIdles.delete(sessionId)
}

/** Consumes a recorded suppressed idle, returning true exactly once per suppression. */
export function consumeSuppressedIdle(sessionId: string): boolean {
  return suppressedIdles.delete(sessionId)
}

/**
 * Drops all idle-gate state for a deleted session. Safe to call in every instance:
 * the store is process-shared and deletion is idempotent.
 */
export function clearIdleGateForSession(sessionId: string): void {
  queuedPrompts.delete(sessionId)
  suppressedIdles.delete(sessionId)
}

/** Test-only: clear every idle-gate map so tests start from a clean store. */
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
