import type { ForgeClient } from '../client/port'
import type { LoopChangeNotifier, TerminationReason } from '../loop'
import { createLoop, isWorkspaceNotFoundError } from '../loop'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { createSandboxManager } from '../sandbox/manager'
export { isWorkspaceNotFoundError }
import type { LoopWatchdogStallInfo } from './watchdog'
import { performTerminationSideEffects } from './host-side-effects'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopEventsRepo } from '../storage/repos/loop-events-repo'
import type { LoopRunsRepo } from '../storage/repos/loop-runs-repo'
import type { PendingTeardownRegistry } from '../workspace/pending-teardown'

export interface LoopEventHandler {
  onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void>
  terminateAll(): void
  clearAllRetryTimeouts(): void
  startWatchdog(loopName: string): void
  getStallInfo(loopName: string): LoopWatchdogStallInfo | null
  cancelBySessionId(sessionId: string): Promise<boolean>
  terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean>
  runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T>
  clearLoopTimers(loopName: string): Promise<void>
  /**
   * Capture the active loop's current run usage + termination metrics before a
   * restart replaces started_at. See {@link Loop.finalizeRunForRestart}.
   */
  finalizeRunForRestart(loopName: string, reason: TerminationReason): Promise<void>
  recordActivity(loopName: string, source?: string): void
  loop: import('../loop/runtime').Loop
}

/**
 * Thin adapter that translates host events → `LoopEvent` and delegates
 * all runtime behavior to the Loop created by createLoop().
 *
 * The existing `LoopEventHandler` interface is preserved as-is.
 */
export function createLoopEventHandler(
  loopsRepo: LoopsRepo,
  plansRepo: PlansRepo,
  reviewFindingsRepo: ReviewFindingsRepo,
  projectId: string,
  forgeClient: ForgeClient,
  logger: Logger,
  getConfig: () => PluginConfig,
  sandboxManager?: ReturnType<typeof createSandboxManager>,
  dataDir?: string,
  loopConfig?: LoopConfig,
  sectionPlansRepo?: SectionPlansRepo,
  notify?: LoopChangeNotifier,
  pendingTeardowns?: PendingTeardownRegistry,
  loopSessionUsageRepo?: LoopSessionUsageRepo,
  loopEventsRepo?: LoopEventsRepo,
  loopRunsRepo?: LoopRunsRepo,
): LoopEventHandler {
  const loop = createLoop({
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    projectId,
    client: forgeClient,
    logger,
    getConfig,
    sandboxManager,
    dataDir,
    loopConfig,
    sectionPlansRepo,
    notify,
    loopSessionUsageRepo,
    loopEventsRepo,
    loopRunsRepo,
    onTerminated: async (state, reason) => {
      await performTerminationSideEffects(state, reason, state.sessionId, {
        client: forgeClient,
        logger,
        getConfig,
        sandboxManager,
        dataDir,
        getPlanText: loop.service.getPlanText,
        pendingTeardowns,
        loopsRepo,
        projectId,
        loopSessionUsageRepo,
      })
    },
  })

  return {
    onEvent: (input) => loop.tick(input.event),
    terminateAll: () => { void loop.terminateAll() },
    clearAllRetryTimeouts: () => loop.clearAllRetryTimeouts(),
    startWatchdog: (name) => loop.startWatchdog(name),
    getStallInfo: (name) => loop.getStallInfo(name),
    cancelBySessionId: (sessionId) => loop.cancelBySessionId(sessionId),
    terminateLoopByName: (name, reason) => loop.terminate(name, reason),
    runExclusive: <T>(loopName: string, fn: () => Promise<T>) => loop.runExclusive(loopName, fn),
    clearLoopTimers: (name) => loop.clearLoopTimers(name),
    finalizeRunForRestart: (name, reason) => loop.finalizeRunForRestart(name, reason),
    recordActivity: (name, source?) => loop.recordActivity(name, source),
    loop,
  }
}