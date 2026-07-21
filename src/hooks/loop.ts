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
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
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
  loopTransitionsRepo?: LoopTransitionsRepo,
  planAmendmentsRepo?: PlanAmendmentsRepo,
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
    loopTransitionsRepo,
    planAmendmentsRepo,
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
    recordActivity: (name, source?) => loop.recordActivity(name, source),
    loop,
  }
}