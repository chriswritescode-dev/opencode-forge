import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService, LoopState, TerminationReason } from '../loop'
import type { Logger } from '../types'

export type LoopWatchdogStallReason =
  | 'non_busy_status'
  | 'missing_status'
  | 'status_error'

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
  getStallInfo(loopName: string): LoopWatchdogStallInfo | null
}

type SessionStatusSnapshot = {
  type?: string
  attempt?: number
  message?: string
  next?: number
  [key: string]: unknown
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
  loopService: Pick<LoopService, 'getActiveState' | 'getStallTimeoutMs' | 'getMaxConsecutiveStalls' | 'resolveLoopName'>
  v2Client: OpencodeClient
  logger: Logger
  recover(loopName: string, state: LoopState, context: LoopWatchdogRecoveryContext): Promise<void>
  terminate(loopName: string, state: LoopState, reason: TerminationReason): Promise<void>
  statusRetryAttempts?: number
  statusRetryBackoffMs?: number
}): LoopWatchdog {
  const lastActivityTime = new Map<string, number>()
  const stallWatchdogs = new Map<string, NodeJS.Timeout>()
  const consecutiveStalls = new Map<string, number>()
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
    stallDetails.delete(loopName)
    input.logger.debug(`Loop watchdog: activity for ${loopName} from ${source}, resetting timer`)
  }

  async function getStatusWithRetry(
    directory: string,
    attempts: number,
    backoffMs: number,
  ): Promise<{ ok: true; data: Record<string, SessionStatusSnapshot> } | { ok: false; error: unknown }> {
    let lastErr: unknown = null
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await input.v2Client.session.status({ directory })
        return { ok: true, data: (r.data ?? {}) as Record<string, SessionStatusSnapshot> }
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

    await input.recover(loopName, state, {
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

    const interval = setInterval(async () => {
      if (watchdogRunning.get(loopName)) return
      watchdogRunning.set(loopName, true)
      try {
        const lastActivity = lastActivityTime.get(loopName)
        if (!lastActivity) return

        const elapsed = Date.now() - lastActivity
        if (elapsed < stallTimeout) return

        const state = input.loopService.getActiveState(loopName)
        if (!state?.active) {
          stop(loopName)
          return
        }

        const statusResult = await getStatusWithRetry(state.worktreeDir, statusRetryAttempts, statusRetryBackoffMs)

        if (!statusResult.ok) {
          input.logger.error(`Loop watchdog: failed to check session status after retries for ${loopName}, treating as stall`, statusResult.error)
          await handleStall(loopName, state, {
            reason: 'status_error',
            error: statusResult.error,
            elapsedMs: elapsed,
          })
          return
        }

        // Check if any session registered to this loop is busy (main session + child/subagent sessions)
        const resolvedLoopName = input.loopService.resolveLoopName(state.sessionId) ?? loopName
        let anyBusy = false
        for (const [sid, snap] of Object.entries(statusResult.data)) {
          if ((snap as SessionStatusSnapshot).type === 'busy' && input.loopService.resolveLoopName(sid) === resolvedLoopName) {
            anyBusy = true
            break
          }
        }

        if (anyBusy) {
          resetActivity(loopName, 'status:busy')
          input.logger.debug(`Loop watchdog: loop ${loopName} remains busy (main or child session), resetting timer`)
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
    }, stallTimeout)

    stallWatchdogs.set(loopName, interval)
    input.logger.log(`Loop watchdog: started for loop ${loopName} (timeout: ${stallTimeout}ms)`)
  }

  function stop(loopName: string): void {
    const interval = stallWatchdogs.get(loopName)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(loopName)
    }
    lastActivityTime.delete(loopName)
    consecutiveStalls.delete(loopName)
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
    watchdogRunning.clear()
    stallDetails.clear()
  }

  function recordActivity(loopName: string, source = 'external'): void {
    if (!stallWatchdogs.has(loopName)) return
    const state = input.loopService.getActiveState(loopName)
    if (!state?.active) return
    resetActivity(loopName, source)
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
    getStallInfo,
  }
}
