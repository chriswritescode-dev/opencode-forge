/**
 * Forge Execution Service - Command Bus Types
 *
 * Type definitions and pure helpers shared across the execution service and
 * its handler modules. No runtime dependencies on the loop runtime, sandbox,
 * or client instances.
 */

import type { PluginConfig, Logger } from '../types'
import type { ForgeClient } from '../client/port'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import type { RestartBlockedReason } from '../loop/restartability'

// ============================================================================
// Surface Types - Identifies the caller boundary
// ============================================================================

export type ForgeExecutionSurface = 'tool' | 'approval-hook' | 'api' | 'tui'

// ============================================================================
// Request Context
// ============================================================================

export interface ForgeExecutionRequestContext {
  surface: ForgeExecutionSurface
  projectId: string
  directory: string
  sourceSessionId?: string
  requestId?: string
}

// ============================================================================
// Plan Source Types
// ============================================================================

export type PlanSource =
  | { kind: 'inline'; planText: string }
  | { kind: 'stored'; sessionId: string }
  | { kind: 'loop-state'; loopName: string }

// ============================================================================
// Loop Extra / Attach Types
// ============================================================================

export interface ForgeLoopExtra {
  hostSessionId?: string
  title?: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  planSource: 'stored' | 'inline'
  planText?: string
  initialPromptOwner?: 'server' | 'tui'
  pendingAttachStartedAt?: number
  /** Whether the loop runs sandboxed. Written by the attach hook and remote launches; read on re-attach. */
  sandboxEnabled?: boolean
  /** Docker container name when the loop runs sandboxed. */
  sandboxContainer?: string
}

export interface AttachLoopInput {
  sessionId: string
  workspaceId?: string
  worktreeDir: string
  worktreeBranch?: string
  loopName: string
  displayName: string
  executionName: string
  hostSessionId?: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  maxIterations: number
  sandboxEnabled: boolean
  sandboxContainer?: string
  planText: string
  /** Loop kind. Goal loops skip plan decomposition and prompt with the goal continuation prompt. */
  kind?: 'plan' | 'goal'
  /** Goal text for goal loops; persisted on state and used to build the initial prompt. */
  goal?: string
  /** Executor session binding for goal loops (the dedicated code session). */
  executorSessionId?: string
  selectSession?: boolean
  selectSessionTiming?: 'after-create' | 'after-prompt'
  startWatchdog?: boolean
  sendInitialPrompt?: boolean
  abortSourceSessionOnSuccess?: boolean
  onStarted?: (info: {
    sessionId: string
    loopName: string
    displayName: string
    worktreeDir?: string
    workspaceId?: string
  }) => void
}

// ============================================================================
// Loop Selector Types
// ============================================================================

export type LoopSelector =
  | { kind: 'exact'; name: string }
  | { kind: 'partial'; name: string }
  | { kind: 'only-active' }

// ============================================================================
// Command Types - Discriminated Union
// ============================================================================

export interface ExecutePlanNewSessionCommand {
  type: 'plan.execute.newSession'
  source: PlanSource
  title?: string
  executionModel?: string
  lifecycle?: {
    selectSession?: boolean
    selectSessionTiming?: 'after-create' | 'after-prompt'
    abortSourceSession?: boolean
    deleteSessionOnPromptFailure?: boolean
    returnToSourceOnPromptFailure?: boolean
  }
}

export interface ExecutePlanHereCommand {
  type: 'plan.execute.here'
  source: PlanSource
  targetSessionId: string
  title?: string
  executionModel?: string
}

export interface StartLoopCommand {
  type: 'loop.start'
  source: PlanSource
  title?: string
  loopName?: string
  maxIterations?: number
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  hostSessionId?: string
  lifecycle?: {
    selectSession?: boolean
    selectSessionTiming?: 'after-create' | 'after-prompt'
    startWatchdog?: boolean
    abortSourceSessionOnSuccess?: boolean
    onStarted?: (info: {
      sessionId: string
      loopName: string
      displayName: string
      worktreeDir?: string
      workspaceId?: string
    }) => void
  }
}

export interface BuildStartLoopCommandInput {
  source: PlanSource
  title?: string
  loopName?: string
  maxIterations?: number
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  hostSessionId?: string
  lifecycle?: StartLoopCommand['lifecycle']
}

export function buildStartLoopCommand(input: BuildStartLoopCommandInput): StartLoopCommand {
  return {
    type: 'loop.start',
    source: input.source,
    title: input.title,
    loopName: input.loopName,
    maxIterations: input.maxIterations,
    executionModel: input.executionModel,
    auditorModel: input.auditorModel,
    executionVariant: input.executionVariant,
    auditorVariant: input.auditorVariant,
    hostSessionId: input.hostSessionId,
    lifecycle: input.lifecycle,
  }
}

export interface StartGoalCommand {
  type: 'goal.start'
  /** Free-text goal that will be sent as the initial prompt to a new dedicated code session. Must be non-blank. */
  goal: string
  title?: string
  loopName?: string
  maxIterations?: number
  hostSessionId?: string
  /** The invoking session; used only as hostSessionId and must never be aborted/deleted. */
  executorSessionId: string
}

export interface RestartLoopCommand {
  type: 'loop.restart'
  selector: LoopSelector
  force?: boolean
}

export interface CancelLoopCommand {
  type: 'loop.cancel'
  selector?: LoopSelector
  cleanupWorktree?: boolean
}

export interface GetLoopStatusCommand {
  type: 'loop.status'
  selector?: LoopSelector
  includeRecent?: boolean
  includeSessionOutput?: boolean
  limit?: number
}

export type ForgeExecutionCommand =
  | ExecutePlanNewSessionCommand
  | ExecutePlanHereCommand
  | StartLoopCommand
  | StartGoalCommand
  | RestartLoopCommand
  | CancelLoopCommand
  | GetLoopStatusCommand

// ============================================================================
// Response/Error Types
// ============================================================================

export interface ForgeExecutionError {
  code: 'bad_request' | 'not_found' | 'conflict' | 'disabled' | 'prompt_failed' | 'lifecycle_failed' | 'internal_error' | 'provider_limit'
  status: number
  message: string
  candidates?: string[]
  details?: Record<string, unknown>
}

export interface ForgeExecutionWarning {
  code: string
  message: string
}

export type ForgeExecutionResponse<T> =
  | { ok: true; data: T; warnings?: ForgeExecutionWarning[] }
  | { ok: false; error: ForgeExecutionError }

// ============================================================================
// Result Types per Command
// ============================================================================

export interface PlanExecutionStartedResult {
  operation: 'plan.execute.newSession' | 'plan.execute.here'
  mode: 'new-session' | 'execute-here'
  sessionId: string
  modelUsed: string | null
  title: string
}

export interface LoopStartedResult {
  operation: 'loop.start'
  sessionId: string
  loopName: string
  displayName: string
  executionName: string
  worktreeDir?: string
  worktreeBranch?: string
  workspaceId?: string
  hostSessionId?: string
  modelUsed: string | null
  maxIterations: number
  deduped?: boolean
}

export interface GoalStartedResult {
  operation: 'goal.start'
  sessionId: string
  loopName: string
  worktreeDir?: string
  worktreeBranch?: string
  workspaceId?: string
  hostSessionId?: string
  maxIterations: number
  goal: string
}

export interface LoopRestartedResult {
  operation: 'loop.restart'
  loopName: string
  sessionId: string
  previousSessionId: string
  worktreeDir?: string
  worktreeBranch?: string
  worktree: boolean
  sandbox: boolean
  bindFailed: boolean
  iteration: number
}

export interface LoopCancelledResult {
  operation: 'loop.cancel'
  loopName: string
  sessionId: string
  iteration: number
  worktreeDir?: string
  worktreeRemoved: boolean
  worktree: boolean
  worktreeBranch?: string
}

export interface LoopStatusView {
  loopName: string
  displayName: string
  kind: 'plan' | 'goal'
  goal?: string
  status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  phase?: string
  iteration: number
  maxIterations: number
  sessionId: string
  active: boolean
  startedAt: string
  completedAt?: string
  terminationReason?: string
  completionSummary?: string
  worktree: boolean
  worktreeDir?: string
  worktreeBranch?: string
  executionModel?: string
  auditorModel?: string
  workspaceId?: string
  hostSessionId?: string
  currentSectionIndex?: number
  totalSections?: number
  finalAuditDone?: boolean
  usage?: import('../loop/token-usage').LoopUsageSummary
  restartable: boolean
  restartRequiresForce: boolean
  restartBlockedReason?: RestartBlockedReason
  restartBlockedMessage?: string
  sections?: Array<{
    index: number
    title: string
    status: string
    attempts: number
    startedAt?: number | null
    completedAt?: number | null
    summaryDone: string | null
    summaryDeviations: string | null
    summaryFollowUps: string | null
  }>
}

export interface LoopStatusResult {
  operation: 'loop.status'
  loops: LoopStatusView[]
  active: LoopStatusView[]
  recent: LoopStatusView[]
}

// Type mapping from command to result
export type ForgeExecutionResult<C extends ForgeExecutionCommand> =
  C extends ExecutePlanNewSessionCommand ? PlanExecutionStartedResult :
  C extends ExecutePlanHereCommand ? PlanExecutionStartedResult :
  C extends StartLoopCommand ? LoopStartedResult :
  C extends StartGoalCommand ? GoalStartedResult :
  C extends RestartLoopCommand ? LoopRestartedResult :
  C extends CancelLoopCommand ? LoopCancelledResult :
  C extends GetLoopStatusCommand ? LoopStatusResult :
  never

// ============================================================================
// Service Interface
// ============================================================================

export interface ForgeExecutionService {
  dispatch<C extends ForgeExecutionCommand>(
    ctx: ForgeExecutionRequestContext,
    command: C,
  ): Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface ForgeExecutionServiceDeps {
  projectId: string
  directory: string
  config: PluginConfig
  logger: Logger | Console
  dataDir: string
  client: ForgeClient
  plansRepo: PlansRepo
  loopsRepo: LoopsRepo
  loopHandler?: ReturnType<typeof createLoopEventHandler>
  loop: import('../loop/runtime').Loop
  sandboxManager?: SandboxManager | null
  sectionPlansRepo?: import('../storage/repos/section-plans-repo').SectionPlansRepo
  reviewFindingsRepo?: import('../storage/repos/review-findings-repo').ReviewFindingsRepo
  loopSessionUsageRepo?: import('../storage/repos/loop-session-usage-repo').LoopSessionUsageRepo
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
  pendingTeardowns: import('../workspace/pending-teardown').PendingTeardownRegistry
}

// ============================================================================
// Helper Functions
// ============================================================================

export function ok<T>(data: T, warnings?: ForgeExecutionWarning[]): ForgeExecutionResponse<T> {
  return { ok: true, data, warnings }
}

export function fail(
  code: ForgeExecutionError['code'],
  status: number,
  message: string,
  details?: Record<string, unknown>,
  candidates?: string[]
): ForgeExecutionResponse<never> {
  return {
    ok: false,
    error: { code, status, message, details, candidates }
  }
}
