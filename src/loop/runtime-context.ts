import type { ForgeClient } from '../client/port'
import type { LoopChangeNotifier, LoopService } from './service'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
import type { createSandboxManager } from '../sandbox/manager'
import type { LoopState } from './state'
import type { LoopWatchdog } from '../hooks/watchdog'
import type { TerminationReason } from './termination'
import type { TransitionLog } from './runtime-transition-log'
import type { SessionLifecycle } from './runtime-sessions'
import type { PromptRetry } from './runtime-retry'
import type { PromptDispatch } from './runtime-prompt'
import type { WorkspaceLifecycle } from './runtime-workspace'
import type { Termination } from './runtime-termination'

export interface LoopEvent {
  type: string
  properties?: Record<string, unknown>
}

/**
 * Callback invoked after the core state-machine portion of termination completes.
 * Host-specific side-effects (teardown, toast, completion-log, sandbox-stop) live here.
 */
export type OnTerminatedCallback = (state: LoopState, reason: TerminationReason) => Promise<void>

export interface LoopRuntimeDeps {
  loopsRepo: LoopsRepo
  plansRepo: PlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
  projectId: string
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  onTerminated?: OnTerminatedCallback
  notify?: LoopChangeNotifier
  loopConfig?: LoopConfig
  sectionPlansRepo?: SectionPlansRepo
  loopSessionUsageRepo?: LoopSessionUsageRepo
  loopTransitionsRepo?: LoopTransitionsRepo
  planAmendmentsRepo?: PlanAmendmentsRepo
  /** Optional injected LoopService (test seam). Defaults to a real one built from the repos. */
  loopService?: LoopService
  /** Optional parent-session lookup for ancestor-aware session→loop resolution (child/subagent support). */
  getParentSessionId?: (sessionId: string) => Promise<string | null>
}

export interface StartLoopInput {
  state: LoopState
}

export interface RetainedSessionMeta {
  sessionId: string
  role: 'code' | 'auditor'
  fallbackModel: string | undefined
  directory: string
}

/**
 * Per-instance shared state for a single `createLoop` invocation. Each
 * `createLoop` call constructs its own `RuntimeContext` so two loops get fully
 * independent maps/sets/watchdog/terminateLoop/runPhase — no module-level state.
 *
 * `loopService`, `watchdog`, `terminateLoop`, and `runPhase` are late-bound
 * slots assigned in `createLoop` after the corresponding collaborators are
 * constructed. They are initialized with throwing placeholders so any
 * accidental use before wiring fails fast.
 */
/**
 * Bag of constructed collaborators shared by the phase-runner modules
 * (`runtime-phase-coding.ts`, `runtime-phase-audit.ts`). Built once in
 * `createLoop` and passed to both phase factories so every phase has the same
 * wiring and there is no second dispatch path.
 */
export interface PhaseRunnerCollaborators {
  logger: Logger
  client: ForgeClient
  getConfig: () => PluginConfig
  projectId: string
  loopsRepo: LoopsRepo
  transitionLog: TransitionLog
  sessions: SessionLifecycle
  promptRetry: PromptRetry
  promptDispatch: PromptDispatch
  workspace: WorkspaceLifecycle
  termination: Pick<Termination, 'terminateLoop'>
  /** Recording setPhase wrapper used by the amendment-guard revert in runFinalAuditPhase. */
  setPhase: (name: string, phase: LoopState['phase']) => void
}

export interface RuntimeContext {
  deps: LoopRuntimeDeps
  stateLocks: Map<string, Promise<void>>
  retryTimeouts: Map<string, ReturnType<typeof setTimeout>>
  idleRetryTimeouts: Map<string, ReturnType<typeof setTimeout>>
  idleRetryAttempts: Map<string, number>
  codingLaunchRecoveryAttempts: Map<string, number>
  loopRetainedSessions: Map<string, RetainedSessionMeta[]>
  sessionToLoop: Map<string, string>
  terminatingLoops: Set<string>
  withStateLock: <T>(loopName: string, fn: () => Promise<T>) => Promise<T>
  loopService: LoopService
  watchdog: LoopWatchdog
  terminateLoop: (loopName: string, state: LoopState, reason: TerminationReason, summary?: string) => Promise<void>
  runPhase: (phase: LoopState['phase'], loopName: string, state: LoopState) => Promise<void>
}

function notWired(slot: string): never {
  throw new Error(`RuntimeContext slot "${slot}" not wired`)
}

export function createRuntimeContext(deps: LoopRuntimeDeps): RuntimeContext {
  const stateLocks = new Map<string, Promise<unknown>>()
  function withStateLock<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    const prev = stateLocks.get(loopName) ?? Promise.resolve()
    const nextPromise = prev.catch(() => undefined).then(() => fn())
    stateLocks.set(loopName, nextPromise)
    void nextPromise.finally(() => {
      if (stateLocks.get(loopName) === nextPromise) {
        stateLocks.delete(loopName)
      }
    })
    return nextPromise
  }

  return {
    deps,
    stateLocks: stateLocks as Map<string, Promise<void>>,
    retryTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
    idleRetryTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
    idleRetryAttempts: new Map<string, number>(),
    codingLaunchRecoveryAttempts: new Map<string, number>(),
    loopRetainedSessions: new Map<string, RetainedSessionMeta[]>(),
    sessionToLoop: new Map<string, string>(),
    terminatingLoops: new Set<string>(),
    withStateLock,
    loopService: undefined as unknown as LoopService,
    watchdog: undefined as unknown as LoopWatchdog,
    terminateLoop: ((() => notWired('terminateLoop')) as unknown) as RuntimeContext['terminateLoop'],
    runPhase: ((() => notWired('runPhase')) as unknown) as RuntimeContext['runPhase'],
  }
}
