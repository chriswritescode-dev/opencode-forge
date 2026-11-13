import { z } from 'zod'
import type { SessionStatus } from '../client/port'
import type { LoopService, LoopState, TerminationReason } from '../loop'
import { classifyProviderLimit } from '../loop/provider-limit'
import { isAuditorPhase } from '../utils/loop-helpers'
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
  start(loopName: string): void
  stop(loopName: string): void
  clearAll(): void
  recordActivity(loopName: string, source?: string): void
  recordSessionContent(sessionId: string): void
  getStallInfo(loopName: string): LoopWatchdogStallInfo | null
}

export async function activeLoopSessions(
  statuses: SessionStatus,
  loopName: string,
  resolveLoop: (sessionId: string) => string | null | Promise<string | null>,
): Promise<Array<[string, SessionStatus[string]]>> {
  const active: Array<[string, SessionStatus[string]]> = []
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (status.type !== 'busy' && status.type !== 'retry') continue
    if (await resolveLoop(sessionId) === loopName) active.push([sessionId, status])
  }
  return active
}

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const text = z.string().safeParse(cause)
  if (text.success) return text.data
  try {
    return JSON.stringify(cause ?? '')
  } catch {
    return String(cause)
  }
}

export function createLoopWatchdog(input: {
  loopService: Pick<LoopService, 'getActiveState' | 'getStallTimeoutMs' | 'getMaxConsecutiveStalls' | 'getBusyStallTimeoutMs' | 'resolveLoopName'>
  client: ForgeClient
  logger: Logger
  recover(loopName: string, state: LoopState, context: LoopWatchdogRecoveryContext): Promise<void>
  nudge(loopName: string, state: LoopState, context: LoopWatchdogRecoveryContext): Promise<void>
  terminate(loopName: string, state: LoopState, reason: TerminationReason): Promise<void>
  handleAuditorProviderLimit?: (loopName: string, limitReason: string) => Promise<boolean>
  resolveSessionLoopName?: (sessionId: string) => Promise<string | null>
  isPromptQueued?: (sessionId: string) => boolean
  statusRetryAttempts?: number
  statusRetryBackoffMs?: number
}): LoopWatchdog {
  const { client } = input
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

  function resetActivity(loopName: string, source: string): void {
    lastActivityTime.set(loopName, Date.now())
    consecutiveStalls.set(loopName, 0)
    busySince.delete(loopName)
    stallDetails.delete(loopName)
    input.logger.debug(`Loop watchdog: activity for ${loopName} from ${source}, resetting timer`)
  }

  async function getStatusWithRetry(
    directory: string,
    attempts: number,
    backoffMs: number,
  ): Promise<{ ok: true; data: SessionStatus } | { ok: false; cause: unknown }> {
    for (let i = 0; i < attempts; i++) {
      try {
        return { ok: true, data: await client.session.status({ directory }) }
      } catch (cause) {
        if (i === attempts - 1) return { ok: false, cause }
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)))
      }
    }
    return { ok: false, cause: undefined }
  }

  async function handleStall(
    loopName: string,
    state: LoopState,
    contextWithoutCount: { reason: LoopWatchdogStallReason; status?: string; error?: unknown; elapsedMs: number },
  ): Promise<void> {
    const stallCount = (consecutiveStalls.get(loopName) ?? 0) + 1
    consecutiveStalls.set(loopName, stallCount)
    lastActivityTime.set(loopName, Date.now())

    const formattedError = contextWithoutCount.reason === 'status_error'
      ? formatError(contextWithoutCount.error)
      : contextWithoutCount.error === undefined
        ? undefined
        : formatError(contextWithoutCount.error)

    stallDetails.set(loopName, {
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

  function start(loopName: string): void {
    stop(loopName)
    lastActivityTime.set(loopName, Date.now())
    consecutiveStalls.set(loopName, 0)

    const stallTimeout = input.loopService.getStallTimeoutMs()
    const configuredBusyTimeout = input.loopService.getBusyStallTimeoutMs()
    const pollIntervalMs = configuredBusyTimeout > 0
      ? Math.min(stallTimeout, configuredBusyTimeout)
      : stallTimeout
    const pollBeforeStallReady = configuredBusyTimeout > 0 && configuredBusyTimeout < stallTimeout

    const interval = setInterval(async () => {
      if (watchdogRunning.get(loopName)) return
      watchdogRunning.set(loopName, true)
      try {
        const lastActivity = lastActivityTime.get(loopName)
        if (!lastActivity) return

        const elapsed = Date.now() - lastActivity
        const stallReady = elapsed >= stallTimeout
        if (!stallReady && !pollBeforeStallReady) return

        const state = input.loopService.getActiveState(loopName)
        if (!state?.active) {
          stop(loopName)
          return
        }

        const statusResult = await getStatusWithRetry(state.worktreeDir, statusRetryAttempts, statusRetryBackoffMs)

        if (!statusResult.ok) {
          if (!stallReady) return
          input.logger.error(`Loop watchdog: failed to check session status after retries for ${loopName}, treating as stall`, statusResult.cause)
          await handleStall(loopName, state, {
            reason: 'status_error',
            error: statusResult.cause,
            elapsedMs: elapsed,
          })
          return
        }

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
          }

          if (snapshot.type === 'retry') {
            const limitReason = classifyProviderLimit({ message: snapshot.message })
            if (limitReason) {
              const freshState = input.loopService.getActiveState(loopName)
              if (!freshState?.active) return
              if (input.handleAuditorProviderLimit && isAuditorPhase(freshState.phase)) {
                const absorbed = await input.handleAuditorProviderLimit(loopName, limitReason)
                if (absorbed) {
                  resetActivity(loopName, 'status:retry')
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
          const busyTimeout = input.loopService.getBusyStallTimeoutMs()
          const since = busySince.get(loopName)
          if (since === undefined) {
            busySince.set(loopName, Date.now())
          } else {
            const lastProgressAt = Math.max(since, latestContentAt)
            const busyElapsed = Date.now() - lastProgressAt
            if (busyTimeout > 0 && busyElapsed >= busyTimeout) {
              busySince.set(loopName, Date.now())
              input.logger.error(`Loop watchdog: loop ${loopName} busy with no activity for ${busyElapsed}ms (ceiling ${busyTimeout}ms), nudging session`)
              await handleStall(loopName, state, {
                reason: 'busy_no_progress',
                status: 'busy',
                elapsedMs: busyElapsed,
              })
              return
            }
          }
          lastActivityTime.set(loopName, Date.now())
          input.logger.debug(`Loop watchdog: loop ${loopName} remains busy (main or child session), awaiting activity`)
          return
        }

        if (anyRetrying) {
          resetActivity(loopName, 'status:retry')
          input.logger.debug(`Loop watchdog: provider retry in progress for ${loopName}, resetting timer`)
          return
        }

        if (!stallReady) return

        if (input.isPromptQueued?.(state.sessionId)) {
          input.logger.debug(`Loop watchdog: queued prompt pending for ${loopName}, skipping stall tick`)
          return
        }

        const status = statusResult.data[state.sessionId]?.type

        await handleStall(loopName, state, {
          reason: status === undefined ? 'missing_status' : 'non_busy_status',
          status,
          elapsedMs: elapsed,
        })
      } finally {
        watchdogRunning.set(loopName, false)
      }
    }, pollIntervalMs)

    stallWatchdogs.set(loopName, interval)
    input.logger.log(`Loop watchdog: started for loop ${loopName} (timeout: ${stallTimeout}ms, poll: ${pollIntervalMs}ms)`)
  }

  function stop(loopName: string): void {
    const interval = stallWatchdogs.get(loopName)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(loopName)
    }
    lastActivityTime.delete(loopName)
    consecutiveStalls.delete(loopName)
    busySince.delete(loopName)
    watchdogRunning.delete(loopName)
    stallDetails.delete(loopName)
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

  function recordActivity(loopName: string, source = 'external'): void {
    if (!stallWatchdogs.has(loopName)) return
    const state = input.loopService.getActiveState(loopName)
    if (!state?.active) return
    resetActivity(loopName, source)
  }

  function recordSessionContent(sessionId: string): void {
    lastContentBySession.set(sessionId, Date.now())
  }

  function getStallInfo(loopName: string): LoopWatchdogStallInfo | null {
    const lastActivity = lastActivityTime.get(loopName)
    if (lastActivity === undefined) return null
    const details = stallDetails.get(loopName)
    return {
      consecutiveStalls: consecutiveStalls.get(loopName) ?? 0,
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
    clearAll,
    recordActivity,
    recordSessionContent,
    getStallInfo,
  }
}
