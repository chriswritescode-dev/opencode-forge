import type { LoopService, LoopState, TerminationReason } from '../loop'
import { classifyProviderLimit } from '../loop/provider-limit'
import type { LoopLane } from '../loop/section-run'
import { isAuditorPhase } from '../utils/loop-helpers'
import { deleteLoopLaneEntries, projectLoopLaneKey } from '../utils/process-shared'
import type { Logger } from '../types'
import type { ForgeClient } from '../client/port'
import { LRUCache } from '../utils/lru-cache'

export type LoopWatchdogStallReason =
  | 'non_busy_status'
  | 'missing_status'
  | 'status_error'
  | 'busy_no_progress'

export interface LoopWatchdogStallInfo {
  consecutiveStalls: number
  lastActivityTime: number
  lastReason?: LoopWatchdogStallReason
  lastStatus?: string
  lastError?: string
  lastStallAt?: number
}

export interface LoopWatchdogRecoveryContext {
  reason: LoopWatchdogStallReason
  status?: string
  error?: unknown
  elapsedMs: number
  stallCount: number
}

export interface LoopWatchdog {
  start(lane: LoopLane): void
  stop(lane: LoopLane): void
  /** Stops the watchdog for every section run of one loop. */
  stopLoop(loopName: string): void
  clearAll(): void
  recordActivity(lane: LoopLane, source?: string): void
  /**
   * Records that streamed content (reasoning, text, tool state) arrived for a session.
   * Called per streaming delta, so it must stay O(1) and side-effect free: no loop
   * resolution and no logging. The busy check resolves sessions to loops itself.
   */
  recordSessionContent(sessionId: string): void
  getStallInfo(lane: LoopLane): LoopWatchdogStallInfo | null
}

type SessionStatusSnapshot = {
  type?: string
  attempt?: number
  message?: string
  next?: number
  [key: string]: unknown
}

export async function activeLoopSessions(
  statuses: Record<string, SessionStatusSnapshot>,
  loopName: string,
  resolveLoop: (sessionId: string) => string | null | Promise<string | null>,
): Promise<Array<[string, SessionStatusSnapshot]>> {
  const active: Array<[string, SessionStatusSnapshot]> = []
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (status.type !== 'busy' && status.type !== 'retry') continue
    if (await resolveLoop(sessionId) === loopName) active.push([sessionId, status])
  }
  return active
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err ?? '')
  } catch {
    return String(err)
  }
}

export function createLoopWatchdog(input: {
  projectId: string
  loopService: Pick<LoopService, 'getActiveState' | 'getRunState' | 'getStallTimeoutMs' | 'getMaxConsecutiveStalls' | 'getBusyStallTimeoutMs' | 'resolveLoopName'>
  client: ForgeClient
  logger: Logger
  recover(loopName: string, state: LoopState, context: LoopWatchdogRecoveryContext): Promise<void>
  /**
   * Recovery for a session wedged in `busy`: abort the stuck message and send a
   * continue prompt on the SAME session. Unlike `recover`, which re-dispatches
   * the whole phase, the session and its conversation are kept intact.
   */
  nudge(loopName: string, state: LoopState, context: LoopWatchdogRecoveryContext): Promise<void>
  terminate(loopName: string, state: LoopState, reason: TerminationReason): Promise<void>
  /** Routes an auditor provider limit into the fallback chain. Returns true when absorbed (do not terminate), false when the caller must terminate. */
  handleAuditorProviderLimit?: (loopName: string, limitReason: string, lane: LoopLane) => Promise<boolean>
  /** Ancestor-aware session→loop resolver for child/subagent sessions. Falls back to loopService.resolveLoopName when absent. */
  resolveSessionLoopName?: (sessionId: string) => Promise<string | null>
  /** True while the loop's current session has an inbox prompt that has not been delivered yet. */
  isPromptQueued?: (sessionId: string) => boolean
  statusRetryAttempts?: number
  statusRetryBackoffMs?: number
}): LoopWatchdog {
  const { client, projectId } = input
  const lastActivityTime = new Map<string, number>()
  const stallWatchdogs = new Map<string, NodeJS.Timeout>()
  const consecutiveStalls = new Map<string, number>()
  const busySince = new Map<string, number>()
  const lastContentBySession = new LRUCache<number>(500)
  const watchdogRunning = new Map<string, boolean>()
  const stallDetails = new Map<string, {
    reason: LoopWatchdogStallReason
    status?: string
    error?: string
    at: number
  }>()

  const maxStalls = input.loopService.getMaxConsecutiveStalls()
  const statusRetryAttempts = input.statusRetryAttempts ?? 3
  const statusRetryBackoffMs = input.statusRetryBackoffMs ?? 250

  function laneKey(lane: LoopLane): string {
    return projectLoopLaneKey(projectId, lane)
  }

  function resetActivity(lane: LoopLane, source: string): void {
    const key = laneKey(lane)
    lastActivityTime.set(key, Date.now())
    consecutiveStalls.set(key, 0)
    busySince.delete(key)
    stallDetails.delete(key)
    input.logger.debug(`Loop watchdog: activity for ${lane.loopName} from ${source}, resetting timer`)
  }

  async function getStatusWithRetry(
    directory: string,
    attempts: number,
    backoffMs: number,
  ): Promise<{ ok: true; data: Record<string, SessionStatusSnapshot> } | { ok: false; error: unknown }> {
    let lastErr: unknown = null
    for (let i = 0; i < attempts; i++) {
      try {
        const data = await client.session.status({ directory })
        return { ok: true, data: (data ?? {}) as Record<string, SessionStatusSnapshot> }
      } catch (err) {
        lastErr = err
        if (i < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)))
        }
      }
    }
    return { ok: false, error: lastErr }
  }

  async function handleStall(
    lane: LoopLane,
    state: LoopState,
    contextWithoutCount: { reason: LoopWatchdogStallReason; status?: string; error?: unknown; elapsedMs: number },
  ): Promise<void> {
    const key = laneKey(lane)
    const loopName = lane.loopName
    const stallCount = (consecutiveStalls.get(key) ?? 0) + 1
    consecutiveStalls.set(key, stallCount)
    lastActivityTime.set(key, Date.now())

    const formattedError = contextWithoutCount.reason === 'status_error'
      ? formatError(contextWithoutCount.error)
      : contextWithoutCount.error === undefined
        ? undefined
        : formatError(contextWithoutCount.error)

    stallDetails.set(key, {
      reason: contextWithoutCount.reason,
      status: contextWithoutCount.status,
      error: formattedError,
      at: Date.now(),
    })

    if (maxStalls > 0 && stallCount >= maxStalls) {
      input.logger.error(`Loop watchdog: loop ${loopName} exceeded max consecutive stalls (${maxStalls}), terminating`)
      await input.terminate(loopName, state, { kind: 'stall_timeout' })
      return
    }

    if (maxStalls <= 0) return

    const reason = contextWithoutCount.reason
    const status = contextWithoutCount.status
    const elapsedMs = contextWithoutCount.elapsedMs

    if (reason === 'status_error') {
      input.logger.log(`Loop watchdog: stall #${stallCount}/${maxStalls} for ${loopName} (phase=${state.phase}, reason=status_error, elapsed=${elapsedMs}ms), re-triggering`)
    } else {
      input.logger.log(`Loop watchdog: stall #${stallCount}/${maxStalls} for ${loopName} (phase=${state.phase}, reason=${reason}, status=${status ?? 'missing'}, elapsed=${elapsedMs}ms), re-triggering`)
    }

    const action = reason === 'busy_no_progress' ? input.nudge : input.recover
    await action(loopName, state, {
      reason,
      status,
      error: contextWithoutCount.error,
      elapsedMs,
      stallCount,
    })
  }

  function start(lane: LoopLane): void {
    const key = laneKey(lane)
    const loopName = lane.loopName
    stop(lane)
    lastActivityTime.set(key, Date.now())
    consecutiveStalls.set(key, 0)

    const stallTimeout = input.loopService.getStallTimeoutMs()
    // A busy ceiling below the stall timeout would otherwise only ever be evaluated once per
    // stall timeout, silently coarsening the configured value. Poll at the finer of the two and
    // keep every stall decision gated on `stallReady` so stall semantics are unchanged.
    const configuredBusyTimeout = input.loopService.getBusyStallTimeoutMs()
    const pollIntervalMs = configuredBusyTimeout > 0
      ? Math.min(stallTimeout, configuredBusyTimeout)
      : stallTimeout
    // Only a ceiling finer than the stall timeout needs polling before `stallReady`; requiring a
    // `busySince` entry first would delay the very first busy observation by a full stall timeout,
    // making the effective nudge time stallTimeout + busyTimeout. When the ceiling is coarser
    // (the default 15min vs 60s) the stall-timeout cadence already resolves it, so nothing extra
    // is polled.
    const pollBeforeStallReady = configuredBusyTimeout > 0 && configuredBusyTimeout < stallTimeout

    const interval = setInterval(async () => {
      if (watchdogRunning.get(key)) return
      watchdogRunning.set(key, true)
      try {
        const lastActivity = lastActivityTime.get(key)
        if (!lastActivity) return

        const state = input.loopService.getRunState(loopName, lane.sectionRunKey)
        if (!state?.active) {
          stop(lane)
          return
        }

        const elapsed = Date.now() - lastActivity
        const stallReady = elapsed >= stallTimeout
        if (!stallReady && !pollBeforeStallReady) return

        const statusResult = await getStatusWithRetry(state.worktreeDir, statusRetryAttempts, statusRetryBackoffMs)

        if (stallWatchdogs.get(key) !== interval) return
        const freshState = input.loopService.getRunState(loopName, lane.sectionRunKey)
        if (!freshState?.active) return

        if (!statusResult.ok) {
          if (!stallReady) return
          input.logger.error(`Loop watchdog: failed to check session status after retries for ${loopName}, treating as stall`, statusResult.error)
          await handleStall(lane, state, {
            reason: 'status_error',
            error: statusResult.error,
            elapsedMs: elapsed,
          })
          return
        }

        // Check if any session registered to this loop is busy (main session + child/subagent sessions)
        const resolvedLoopName = input.resolveSessionLoopName
          ? (await input.resolveSessionLoopName(state.sessionId) ?? loopName)
          : (input.loopService.resolveLoopName(state.sessionId) ?? loopName)
        let anyBusy = false
        let anyRetrying = false
        let latestContentAt = 0
        const activeSessions = await activeLoopSessions(statusResult.data, resolvedLoopName, input.resolveSessionLoopName ?? input.loopService.resolveLoopName)
        for (const [sid, snapshot] of activeSessions) {

          if (snapshot.type === 'busy') {
            anyBusy = true
            const contentAt = lastContentBySession.get(sid)
            if (contentAt !== undefined && contentAt > latestContentAt) latestContentAt = contentAt
            // Continue scanning: a provider-limit retry in another session takes precedence
          }

          if (snapshot.type === 'retry') {
            const limitReason = classifyProviderLimit({ message: snapshot.message })
            if (limitReason) {
              // Re-fetch active state to avoid terminating with a stale snapshot.
              // The loop may have been cancelled, restarted, or rotated during the
              // async status poll and ancestor-resolution window.
              const freshState = input.loopService.getRunState(loopName, lane.sectionRunKey)
              if (!freshState?.active) return
              if (input.handleAuditorProviderLimit && isAuditorPhase(freshState.phase)) {
                const absorbed = await input.handleAuditorProviderLimit(loopName, limitReason, lane)
                if (absorbed) {
                  resetActivity(lane, 'status:retry')
                  input.logger.debug(`Loop watchdog: auditor provider limit absorbed via fallback for ${loopName}, resetting timer`)
                  return
                }
              }
              await input.terminate(loopName, freshState, { kind: 'provider_limit', message: limitReason })
              return
            }
            anyRetrying = true
          }
        }

        if (anyBusy) {
          // `busy` only means "not finished"; it is never evidence of progress, so it
          // must not reset the stall counters here. Only real activity may clear
          // consecutiveStalls/busySince. Bound the busy stretch instead, measured from
          // the last evidence the stream was alive: either the start of the busy
          // stretch or the newest streamed content (reasoning included). A model that
          // only thinks emits no tool calls, so without the content signal a long
          // reasoning stretch would be indistinguishable from a wedged stream.
          const busyTimeout = input.loopService.getBusyStallTimeoutMs()
          const since = busySince.get(key)
          if (since === undefined) {
            busySince.set(key, Date.now())
          } else {
            const lastProgressAt = Math.max(since, latestContentAt)
            const busyElapsed = Date.now() - lastProgressAt
            if (busyTimeout > 0 && busyElapsed >= busyTimeout) {
              busySince.set(key, Date.now())
              input.logger.error(`Loop watchdog: loop ${loopName} busy with no activity for ${busyElapsed}ms (ceiling ${busyTimeout}ms), nudging session`)
              await handleStall(lane, state, {
                reason: 'busy_no_progress',
                status: 'busy',
                elapsedMs: busyElapsed,
              })
              return
            }
          }
          lastActivityTime.set(key, Date.now())
          input.logger.debug(`Loop watchdog: loop ${loopName} remains busy (main or child session), awaiting activity`)
          return
        }

        if (anyRetrying) {
          resetActivity(lane, 'status:retry')
          input.logger.debug(`Loop watchdog: provider retry in progress for ${loopName}, resetting timer`)
          return
        }

        if (!stallReady) return

        if (input.isPromptQueued?.(state.sessionId)) {
          input.logger.debug(`Loop watchdog: queued prompt pending for ${loopName}, skipping stall tick`)
          return
        }

        const status = statusResult.data[state.sessionId]?.type

        await handleStall(lane, state, {
          reason: status === undefined ? 'missing_status' : 'non_busy_status',
          status,
          elapsedMs: elapsed,
        })
      } finally {
        watchdogRunning.set(key, false)
      }
    }, pollIntervalMs)

    stallWatchdogs.set(key, interval)
    input.logger.log(`Loop watchdog: started for loop ${loopName} (timeout: ${stallTimeout}ms, poll: ${pollIntervalMs}ms)`)
  }

  function stop(lane: LoopLane): void {
    const key = laneKey(lane)
    const interval = stallWatchdogs.get(key)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(key)
    }
    lastActivityTime.delete(key)
    consecutiveStalls.delete(key)
    busySince.delete(key)
    watchdogRunning.delete(key)
    stallDetails.delete(key)
  }

  function stopLoop(loopName: string): void {
    for (const interval of deleteLoopLaneEntries(stallWatchdogs, projectId, loopName)) {
      clearInterval(interval)
    }
    deleteLoopLaneEntries(lastActivityTime, projectId, loopName)
    deleteLoopLaneEntries(consecutiveStalls, projectId, loopName)
    deleteLoopLaneEntries(busySince, projectId, loopName)
    deleteLoopLaneEntries(watchdogRunning, projectId, loopName)
    deleteLoopLaneEntries(stallDetails, projectId, loopName)
  }

  function clearAll(): void {
    for (const [, interval] of stallWatchdogs) {
      clearInterval(interval)
    }
    stallWatchdogs.clear()
    lastActivityTime.clear()
    consecutiveStalls.clear()
    busySince.clear()
    lastContentBySession.clear()
    watchdogRunning.clear()
    stallDetails.clear()
  }

  function recordActivity(lane: LoopLane, source = 'external'): void {
    if (!stallWatchdogs.has(laneKey(lane))) return
    const state = input.loopService.getRunState(lane.loopName, lane.sectionRunKey)
    if (!state?.active) return
    resetActivity(lane, source)
  }

  function recordSessionContent(sessionId: string): void {
    lastContentBySession.set(sessionId, Date.now())
  }

  function getStallInfo(lane: LoopLane): LoopWatchdogStallInfo | null {
    const key = laneKey(lane)
    const lastActivity = lastActivityTime.get(key)
    if (lastActivity === undefined) return null
    const details = stallDetails.get(key)
    return {
      consecutiveStalls: consecutiveStalls.get(key) ?? 0,
      lastActivityTime: lastActivity,
      lastReason: details?.reason,
      lastStatus: details?.status,
      lastError: details?.error,
      lastStallAt: details?.at,
    }
  }

  return {
    start,
    stop,
    stopLoop,
    clearAll,
    recordActivity,
    recordSessionContent,
    getStallInfo,
  }
}
