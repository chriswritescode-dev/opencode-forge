import type { Logger } from '../types'
import { randomUUID } from 'node:crypto'
import type { TuiLoopRestartAppliedState, TuiLoopRestartRepo } from '../storage'

export interface TuiLoopRestartRequest {
  loopName: string
  auditorModel: string
  auditorVariant: string
}

export type TuiLoopRestartResult = { sessionId: string } | { error: string }

export interface TuiLoopRestartControllerDeps {
  projectId: string
  repo: TuiLoopRestartRepo
  restart(request: TuiLoopRestartRequest): Promise<TuiLoopRestartResult>
  logger: Logger
  pollIntervalMs?: number
  maxRequestAgeMs?: number
  processingLeaseMs?: number
  processingHeartbeatMs?: number
}

export interface TuiLoopRestartController {
  start(): Promise<void>
  dispose(): Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_MAX_REQUEST_AGE_MS = 30_000
const DEFAULT_PROCESSING_LEASE_MS = 600_000
const DEFAULT_PROCESSING_HEARTBEAT_MS = 30_000

export function createTuiLoopRestartController(deps: TuiLoopRestartControllerDeps): TuiLoopRestartController {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxRequestAgeMs = deps.maxRequestAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS
  const processingLeaseMs = deps.processingLeaseMs ?? DEFAULT_PROCESSING_LEASE_MS
  const processingHeartbeatMs = deps.processingHeartbeatMs ?? DEFAULT_PROCESSING_HEARTBEAT_MS
  const ownerId = randomUUID()

  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false
  let disposing = false
  let inFlight: Promise<void> | null = null
  let completed: { revision: string; result: TuiLoopRestartResult; claim: TuiLoopRestartAppliedState } | null = null

  const completedState = (revision: string, sessionId: string | null, error: string | null): TuiLoopRestartAppliedState => ({
    version: 1,
    revision,
    status: 'completed',
    ownerId: null,
    sessionId,
    error,
    appliedAt: Date.now(),
  })

  const processingState = (revision: string): TuiLoopRestartAppliedState => ({
    version: 1,
    revision,
    status: 'processing',
    ownerId,
    sessionId: null,
    error: null,
    appliedAt: Date.now(),
  })

  const reconcileOnce = async (): Promise<void> => {
    if (disposed || disposing) return
    const { desired, applied } = deps.repo.getPair(deps.projectId)
    if (!desired) return

    if (completed?.revision === desired.revision) {
      const pending = completed
      const result = pending.result
      const state = 'sessionId' in result
        ? completedState(desired.revision, result.sessionId, null)
        : completedState(desired.revision, null, result.error)
      deps.repo.compareAndSetApplied(deps.projectId, pending.claim, state)
      completed = null
      return
    }
    completed = null
    if (applied && applied.revision === desired.revision) {
      if (applied.status === 'processing' && Date.now() - applied.appliedAt > processingLeaseMs) {
        deps.repo.compareAndSetApplied(
          deps.projectId,
          applied,
          completedState(desired.revision, null, 'restart outcome is unknown because its controller stopped before acknowledging completion'),
        )
      }
      return
    }

    const age = Date.now() - desired.requestedAt
    if (age > maxRequestAgeMs) {
      deps.logger.debug(`[tui-loop-restart] rejecting stale request revision=${desired.revision} age=${age}ms`)
      const claim = processingState(desired.revision)
      if (deps.repo.claim(deps.projectId, claim)) {
        deps.repo.compareAndSetApplied(
          deps.projectId,
          claim,
          completedState(desired.revision, null, 'restart request expired before it could be applied'),
        )
      }
      return
    }

    let claim = processingState(desired.revision)
    const claimed = deps.repo.claim(deps.projectId, claim)
    if (!claimed) return

    let result: TuiLoopRestartResult
    const heartbeat = setInterval(() => {
      const next = { ...claim, appliedAt: Date.now() }
      try {
        if (deps.repo.compareAndSetApplied(deps.projectId, claim, next)) claim = next
      } catch (err) {
        deps.logger.error('TUI loop restart heartbeat failed', err)
      }
    }, processingHeartbeatMs)
    try {
      result = await deps.restart({
        loopName: desired.loopName,
        auditorModel: desired.auditorModel,
        auditorVariant: desired.auditorVariant,
      })
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearInterval(heartbeat)
    }
    if (disposed) return

    const current = deps.repo.getDesired(deps.projectId)
    if (!current || current.revision !== desired.revision) return

    completed = { revision: desired.revision, result, claim }
    const state = 'sessionId' in result
      ? completedState(desired.revision, result.sessionId, null)
      : completedState(desired.revision, null, result.error)
    if (deps.repo.compareAndSetApplied(deps.projectId, claim, state)) completed = null
  }

  const reconcile = (): Promise<void> => {
    if (inFlight) return inFlight
    const run = reconcileOnce()
      .catch((err: unknown) => {
        deps.logger.error(`[tui-loop-restart] reconciliation failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (inFlight === run) inFlight = null
      })
    inFlight = run
    return run
  }

  const start = async (): Promise<void> => {
    if (disposed || disposing) return
    if (!timer) {
      timer = setInterval(() => { void reconcile() }, pollIntervalMs)
    }
    await reconcile()
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposing = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    await inFlight
    disposed = true
  }

  return { start, dispose }
}
