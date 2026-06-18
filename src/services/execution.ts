/**
 * Forge Execution Service - Command Bus Interface
 * 
 * Shared execution service for plan execution and loop lifecycle.
 * Provides a unified interface for internal tools, API, and TUI surfaces.
 */

import type { PluginConfig, Logger } from '../types'
import type { ForgeClient } from '../client/port'
import { selectSessionBestEffort } from '../utils/tui-navigation'

import type { PlansRepo } from '../storage/repos/plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { parseModelString } from '../utils/model-fallback'

import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../constants/loop'
import { findPartialMatch } from '../utils/partial-match'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { aggregateToUsageSummary } from '../utils/loop-format'
import { join } from 'path'
import { existsSync } from 'fs'
import { applyPlanDecomposition } from './section-bootstrap'
import { sendLoopPrompt } from '../loop/send-loop-prompt'
import { markPromptSent, clearPromptPending, terminationStatusFor, parseTerminationReasonString, isWorkspaceNotFoundError } from '../loop'
import { ConcurrentPromptError } from '../loop/in-flight-guard'
import { getRestartability, type RestartBlockedReason } from '../loop/restartability'
import { loopBranchExists } from '../workspace/forge-naming'
import { resolveHostSessionDirectory } from '../utils/resolve-project-root'

/**
 * A freshly created + warped loop session can transiently report "Session not
 * found" (and, less often, "Workspace not found") before it is durably
 * registered — the `session.created` event lags the synchronous `create()`
 * return. Such failures are retryable; a real misconfiguration is not.
 */
function isTransientSessionError(err: unknown): boolean {
  const msg = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : (() => { try { return JSON.stringify(err ?? '') } catch { return String(err) } })()
  return /Session not found/i.test(msg) || isWorkspaceNotFoundError(err)
}

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
  | RestartLoopCommand
  | CancelLoopCommand
  | GetLoopStatusCommand

// ============================================================================
// Response/Error Types
// ============================================================================

export interface ForgeExecutionError {
  code: 'bad_request' | 'not_found' | 'conflict' | 'disabled' | 'prompt_failed' | 'lifecycle_failed' | 'internal_error'
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
  status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  phase?: string
  iteration: number
  maxIterations: number
  sessionId: string
  active: boolean
  startedAt: string
  completedAt?: string
  terminationReason?: string
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

function ok<T>(data: T, warnings?: ForgeExecutionWarning[]): ForgeExecutionResponse<T> {
  return { ok: true, data, warnings }
}

function fail(
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

// ============================================================================
// Plan Source Resolution
// ============================================================================

async function resolvePlanSource(
  ctx: ForgeExecutionRequestContext,
  source: PlanSource,
  deps: ForgeExecutionServiceDeps,
): Promise<{ ok: true; planText: string } | { ok: false; error: ForgeExecutionError }> {
  switch (source.kind) {
    case 'inline': {
      return { ok: true, planText: source.planText }
    }
    
    case 'stored': {
      const planRow = deps.plansRepo.getForSession(ctx.projectId, source.sessionId)
      if (!planRow) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            status: 404,
            message: 'Plan not found for session',
          }
        }
      }
      return { ok: true, planText: planRow.content }
    }
    
    case 'loop-state': {
      const planText = deps.loop.service.getPlanText(source.loopName, ctx.sourceSessionId ?? '')
      if (planText) {
        return { ok: true, planText }
      }

      return {
        ok: false,
        error: {
          code: 'not_found',
          status: 404,
          message: 'Plan not found in loop state',
        }
      }
    }
  }
}

// ============================================================================
// Port-based helpers
// ============================================================================

export interface SelectInitialWorktreeSessionOpts {
  selectSession: boolean | undefined
  logger: Logger | Console
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
  selectSessionFn: (selection: { sessionID: string; workspace?: string }) => Promise<void>
  /** Maximum time to wait for selectSessionFn before falling through. Defaults to 2000ms. */
  selectTimeoutMs?: number
}

export async function selectInitialWorktreeSession(
  targetSessionId: string,
  boundWorkspaceId: string | undefined,
  context: string,
  opts: SelectInitialWorktreeSessionOpts,
): Promise<void> {
  opts.logger.log(`[warp] select.entry context="${context}" targetSessionId=${targetSessionId} workspaceId=${boundWorkspaceId ?? 'none'}`)

  if (!opts.selectSession) {
    opts.logger.log(`[warp] select.exit context="${context}" reason=no-select-session`)
    return
  }

  if (!boundWorkspaceId) {
    opts.logger.log(`[warp] select.exit context="${context}" reason=no-workspace`)
    return
  }

  const totalStart = Date.now()

  try {
    const connectedResult = await opts.workspaceStatusRegistry.awaitConnected(boundWorkspaceId, {
      timeoutMs: 5000,
      logger: opts.logger as Logger,
    })

    const readyElapsedMs = Date.now() - totalStart

    if (connectedResult.connected) {
      opts.logger.log(
        `[warp] select.ready context="${context}" source=${connectedResult.source} elapsedMs=${readyElapsedMs}`,
      )
    } else {
      opts.logger.log(
        `[warp] select.degraded context="${context}" reason="${connectedResult.reason ?? 'unknown'}" lastStatus="${connectedResult.lastStatus ?? 'none'}" elapsedMs=${readyElapsedMs}`,
      )
    }

    const envTimeout = Number(process.env.FORGE_SELECT_TIMEOUT_MS)
    const SELECT_TIMEOUT_MS = opts.selectTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 2000)
    await Promise.race([
      opts.selectSessionFn({ sessionID: targetSessionId, workspace: boundWorkspaceId }),
      new Promise<void>((resolve) => setTimeout(resolve, SELECT_TIMEOUT_MS)),
    ])
    const totalMs = Date.now() - totalStart
    opts.logger.log(`[warp] select.complete context="${context}" totalMs=${totalMs}`)
  } catch (err) {
    const totalMs = Date.now() - totalStart
    opts.logger.error(
      `[warp] select.failed context="${context}" error="${err instanceof Error ? err.message : String(err)}" totalMs=${totalMs}`,
    )
  }
}

// ============================================================================
// attachLoopToSession
// ============================================================================

export async function attachLoopToSession(
  deps: ForgeExecutionServiceDeps,
  ctx: ForgeExecutionRequestContext,
  input: AttachLoopInput,
): Promise<{ ok: true; loopName: string } | { ok: false; code: 'already_attached' | 'conflict' | 'internal_error' | 'prompt_failed'; message: string }> {
  const {
    sessionId,
    workspaceId,
    worktreeDir,
    worktreeBranch,
    loopName,
    displayName,
    executionModel,
    auditorModel,
    executionVariant,
    auditorVariant,
    maxIterations,
    sandboxEnabled,
    sandboxContainer,
    planText,
    selectSession,
    selectSessionTiming,
    startWatchdog,
    sendInitialPrompt = true,
    abortSourceSessionOnSuccess,
    onStarted,
  } = input

  const loopModel = parseModelString(executionModel)

  const existing = deps.loopsRepo.get(ctx.projectId, loopName)
  if (existing) {
    if (existing.status === 'running') {
      deps.logger.log(`attachLoopToSession: loop ${loopName} already attached (running), skipping`)
      return { ok: false, code: 'already_attached', message: `Loop ${loopName} is already attached` }
    }
    deps.logger.log(`attachLoopToSession: loop ${loopName} has terminal status ${existing.status}; refusing attach`)
    return { ok: false, code: 'conflict', message: `Loop ${loopName} is terminal. Use loop restart to resume or start a new suffixed loop.` }
  }

  // Defensive purge of orphaned per-loop rows (section_plans cascade may not have fired
  // historically; plans/review_findings have no FK). Idempotent.
  try {
    const removedSections = deps.sectionPlansRepo?.deleteAll(ctx.projectId, loopName) ?? 0
    deps.plansRepo.deleteForLoop(ctx.projectId, loopName)
    deps.reviewFindingsRepo?.deleteByLoopName(ctx.projectId, loopName)
    if (removedSections > 0) {
      deps.logger.log(`attachLoopToSession: purged ${removedSections} orphaned section_plans rows for ${loopName}`)
    }
  } catch (err) {
    deps.logger.error(`attachLoopToSession: failed to purge orphaned per-loop rows for ${loopName}`, err)
    // Non-fatal — proceed.
  }

  // The plugin instance handling this tool call may be bound to a worktree
  // directory, so ctx.directory is not a reliable project root. Resolve the
  // real project directory from the host session that launched the loop, and
  // only fall back to ctx.directory when that lookup is unavailable.
  const resolvedProjectDir =
    (await resolveHostSessionDirectory(deps.client, input.hostSessionId, ctx.directory, deps.logger)) ?? ctx.directory

  try {
    // Persist loop state
    const state: import('../loop/state').LoopState = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: worktreeDir ?? ctx.directory,
      projectDir: resolvedProjectDir,
      worktreeBranch,
      iteration: 1,
      maxIterations,
      startedAt: new Date().toISOString(),
      prompt: planText,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      sandbox: sandboxEnabled,
      sandboxContainer: sandboxContainer ?? undefined,
      executionModel,
      auditorModel,
      executionVariant,
      auditorVariant,
      workspaceId,
      hostSessionId: input.hostSessionId,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    }

    deps.loop.service.setState(loopName, state)
    deps.loop.service.registerLoopSession(sessionId, loopName)

    deps.logger.log(`attachLoopToSession: state stored for loop=${loopName}`)

    onStarted?.({
      sessionId,
      loopName,
      displayName,
      worktreeDir,
      workspaceId,
    })

    // === Section extraction ===
    const { totalSections } = applyPlanDecomposition({
      projectId: ctx.projectId,
      loopName,
      planText,
      loopsRepo: deps.loopsRepo,
      sectionPlansRepo: deps.sectionPlansRepo,
    })
    let promptText: string
    if (totalSections > 0) {
      const updatedState = { ...state, phase: 'coding' as const, currentSectionIndex: 0, totalSections }
      promptText = deps.loop.service.buildSectionInitialPrompt(updatedState as import('../loop/state').LoopState)
    } else {
      promptText = planText
    }

    // Wait for sandbox readiness in worktree+sandbox mode (after persistence)
    if (sandboxEnabled && deps.sandboxManager && deps.dataDir) {
      const dbPath = join(deps.dataDir, 'forge.db')
      if (existsSync(dbPath)) {
        const { waitForSandboxReady } = await import('../utils/sandbox-ready')
        const waitResult = await waitForSandboxReady({
          projectId: ctx.projectId,
          loopName,
          dbPath,
          pollMs: 200,
          timeoutMs: 15_000,
        })

        if (!waitResult.ready) {
          deps.logger.error(`attachLoopToSession: sandbox not ready (${waitResult.reason})`)
          try {
            const { createDockerService } = await import('../sandbox/docker')
            const docker = createDockerService(deps.logger as unknown as Console)
            const cn = docker.containerName(loopName)
            if (await docker.isRunning(cn)) {
              await docker.removeContainer(cn)
            }
          } catch (cleanupErr) {
            deps.logger.error('attachLoopToSession: failed to remove sandbox container after timeout', cleanupErr)
          }
          deps.loop.service.deleteState(loopName)
          return { ok: false, code: 'internal_error', message: `Sandbox not ready: ${waitResult.reason}` }
        }

        deps.logger.log(`attachLoopToSession: sandbox ready (${waitResult.containerName})`)
      }
    }

    // Navigate TUI if requested with early timing
    if (selectSession && selectSessionTiming === 'after-create') {
      const selection = workspaceId
        ? { workspace: workspaceId, sessionID: sessionId }
        : { sessionID: sessionId }

      selectSessionBestEffort(deps.client, deps.directory, deps.logger, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI (early)', err as Error)
      })
    }

    if (!sendInitialPrompt) {
      if (startWatchdog && deps.loopHandler) {
        deps.loopHandler.startWatchdog(loopName)
      }
      deps.logger.log(`attachLoopToSession: attached loop=${loopName} without sending initial prompt`)
      return { ok: true, loopName }
    }

    // Send initial prompt with fallback
    const sessionDir = worktreeDir
    const promptParts = [{ type: 'text' as const, text: promptText }]
    const workspaceParam = workspaceId ? { workspace: workspaceId } : {}

    const promptResult = await sendLoopPrompt({
      loopName,
      sessionId,
      agent: 'code',
      logger: deps.logger,
      primaryModel: loopModel,
      useInFlightGuard: false,
      performPrompt: async (model) => {
        markPromptSent(loopName, sessionId, deps.logger)
        try {
          await deps.client.session.promptAsync({
            sessionID: sessionId,
            directory: sessionDir,
            parts: promptParts,
            agent: 'code',
            ...workspaceParam,
            ...(model ? { model } : {}),
          })
          return {}
        } catch (err) {
          return { error: err }
        }
      },
    })

    if (promptResult.result.error) {
      deps.logger.error('attachLoopToSession: failed to send prompt', promptResult.result.error)
      deps.loop.service.deleteState(loopName)
      return { ok: false, code: 'prompt_failed', message: 'Loop session created but failed to send prompt' }
    }

    // Success: start watchdog if requested
    if (startWatchdog && deps.loopHandler) {
      deps.loopHandler.startWatchdog(loopName)
    }

    // Navigate TUI if requested with default/post-prompt timing
    if (selectSession && selectSessionTiming !== 'after-create') {
      const selection = workspaceId
        ? { workspace: workspaceId, sessionID: sessionId }
        : { sessionID: sessionId }

      selectSessionBestEffort(deps.client, deps.directory, deps.logger, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI', err as Error)
      })
    }

    // Abort source session if requested
    if (abortSourceSessionOnSuccess && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to abort source session', err as Error)
      })
    }

    return { ok: true, loopName }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isAlreadyExists = msg.includes('already exists') || msg.includes('UNIQUE constraint failed')
    deps.logger.error('attachLoopToSession: unexpected error', err)
    if (!isAlreadyExists) {
      deps.loop.service.deleteState(loopName)
    } else {
      deps.logger.log(`attachLoopToSession: preserving existing loop ${loopName} despite collision`)
    }
    return {
      ok: false,
      code: isAlreadyExists ? 'already_attached' : 'internal_error',
      message: isAlreadyExists ? `Loop ${loopName} already attached` : 'Failed to attach loop to session',
    }
  }
}

// ============================================================================
// Service Implementation
// ============================================================================

export function createForgeExecutionService(deps: ForgeExecutionServiceDeps): ForgeExecutionService {
  const inFlightLoopStarts = new Map<string, Promise<ForgeExecutionResponse<LoopStartedResult>>>()
  function hashPlanForDedupe(text: string): string {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h) ^ text.charCodeAt(i)
    return (h >>> 0).toString(36)
  }

  async function handlePlanNewSession(
    ctx: ForgeExecutionRequestContext,
    command: ExecutePlanNewSessionCommand,
  ): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>> {
    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const sessionTitle = formatPlanSessionTitle(title)
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    
    // Create new session
    let sessionId: string
    try {
      const session = await deps.client.session.create({
        title: sessionTitle,
        directory: ctx.directory,
      })
      sessionId = session.id
    } catch (err) {
      deps.logger.error('handlePlanNewSession: failed to create session', err)
      return fail('internal_error', 500, 'Failed to create session')
    }
    deps.logger.log(`handlePlanNewSession: created session=${sessionId}`)
    
    // Navigate TUI if requested with early timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming === 'after-create') {
      selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI (early)', err as Error)
      })
    }
    
    // Prompt code agent
    let promptError: unknown = null
    try {
      await deps.client.session.promptAsync({
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: planText }],
        agent: 'code',
        model: parsedModel!,
      })
    } catch (err) {
      promptError = err
    }
    
    if (promptError) {
      deps.logger.error('handlePlanNewSession: failed to prompt session', promptError)
      
      // Delete created session if requested
      if (command.lifecycle?.deleteSessionOnPromptFailure) {
        await deps.client.session.delete({ sessionID: sessionId, directory: ctx.directory }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to delete failed session', err as Error)
        })
      }
      
      // Return to source session if requested
      if (command.lifecycle?.returnToSourceOnPromptFailure && ctx.sourceSessionId) {
        selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to return to source session', err as Error)
        })
      }
      
      return fail('prompt_failed', 502, 'Session created but failed to send plan')
    }
    
    // Navigate TUI if requested with default/post-prompt timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming !== 'after-create') {
      selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI', err as Error)
      })
    }
    
    // Abort source session if requested
    if (command.lifecycle?.abortSourceSession && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to abort source session', err as Error)
      })
    }
    
    const modelUsed = parsedModel
      ? `${parsedModel.providerID}/${parsedModel.modelID}`
      : null
    
    return ok({
      operation: 'plan.execute.newSession',
      mode: 'new-session',
      sessionId,
      modelUsed,
      title: sessionTitle,
    })
  }
  
  async function handlePlanHere(
    ctx: ForgeExecutionRequestContext,
    command: ExecutePlanHereCommand,
  ): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>> {
    if (!command.targetSessionId) {
      return fail('bad_request', 400, 'execute-here mode requires targetSessionId')
    }
    
    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    
    // Build execute-here prompt
    const executeHerePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`
    
    // Prompt code agent in target session
    let promptError: unknown = null
    try {
      await deps.client.session.promptAsync({
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: executeHerePrompt }],
        agent: 'code',
        ...(parsedModel ? { model: parsedModel } : {}),
      })
    } catch (err) {
      promptError = err
    }
    
    if (promptError) {
      deps.logger.error('handlePlanHere: execute-here execution failed', promptError)
      return fail('prompt_failed', 502, 'Failed to execute here')
    }
    
    const modelUsed = parsedModel
      ? `${parsedModel.providerID}/${parsedModel.modelID}`
      : null
    
    return ok({
      operation: 'plan.execute.here',
      mode: 'execute-here',
      sessionId: command.targetSessionId,
      modelUsed,
      title,
    })
  }
  
  async function handleStartLoop(
    ctx: ForgeExecutionRequestContext,
    command: StartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    // Check if loops are disabled in plugin config
    if (deps.config.loop?.enabled === false) {
      return fail('disabled', 403, 'Loops are disabled in plugin config')
    }

    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    
    // Extract loop names first so the session title can prefer the explicit Loop Name
    const { displayName, executionName } = extractPlanExecutionMetadata(planText)
    const title = command.title ?? displayName
    const sessionTitle = formatLoopSessionTitle(title, { iteration: 1, currentSectionIndex: 0, totalSections: 0 })
    
    // Generate unique loop name
    const uniqueLoopName = deps.loop.generateUniqueLoopName(command.loopName ?? executionName)

    // In-flight dedupe: suppress concurrent starts for the same source
    const dedupeKey = `${ctx.projectId}::${command.hostSessionId ?? ctx.sourceSessionId ?? ''}::${hashPlanForDedupe(planText)}`
    const existing = inFlightLoopStarts.get(dedupeKey)
    if (existing) {
      deps.logger.log(`handleStartLoop: dedupe — concurrent start suppressed for key=${dedupeKey}`)
      const prior = await existing
      if (prior.ok) {
        return { ok: true, data: { ...prior.data, deduped: true } }
      }
      return prior
    }

    // Wrapped inner async to store/clean up in-flight promise
    async function doStart(): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    // Resolve models
    const resolvedExecutionModel = command.executionModel ?? deps.config.executionModel
    const resolvedAuditorModel = command.auditorModel ?? deps.config.auditorModel
    
    // Resolve variants
    const resolvedExecutionVariant = command.executionVariant
    const resolvedAuditorVariant = command.auditorVariant
    
    // Resolve max iterations
    const maxIterations = command.maxIterations ?? deps.config.loop?.defaultMaxIterations ?? 0
    
    // Track created resources for rollback
    let createdSessionId: string | null = null
    let createdWorkspaceId: string | undefined
    let hostWorktreeDir: string | undefined
    let worktreeBranch: string | undefined
    let sandboxStarted = false
    let sandboxStartAttempted = false
    let sandboxContainer: string | null = null
    let sandboxEnabledForLoop: boolean
    let loopStatePersisted = false

    const rollbackLoopStart = async (): Promise<void> => {
      if (createdSessionId) {
        await deps.client.session.abort({ sessionID: createdSessionId }).catch(() => {})
      }
      if (loopStatePersisted) {
        deps.loop.service.deleteState(uniqueLoopName)
        loopStatePersisted = false
      }
      if ((sandboxStarted || sandboxStartAttempted) && deps.sandboxManager) {
        await deps.sandboxManager.stop(uniqueLoopName).catch(() => {})
        sandboxStarted = false
        sandboxContainer = null
      }
      if (createdWorkspaceId) {
        await deps.client.workspace.remove({ id: createdWorkspaceId }).catch(() => {})
      }
      if (hostWorktreeDir) {
        const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
        await cleanupLoopWorktree({
          worktreeDir: hostWorktreeDir,
          logPrefix: 'handleStartLoop',
          logger: deps.logger,
        })
      }
    }
    
    try {
      let sessionId: string
      let initialBoundWorkspaceId: string | undefined

      const doSelectInitialWorktreeSession = async (
        targetSessionId: string,
        boundWorkspaceId: string | undefined,
        context: string,
      ): Promise<void> => {
        await selectInitialWorktreeSession(targetSessionId, boundWorkspaceId, context, {
          selectSession: command.lifecycle?.selectSession,
          logger: deps.logger,
          workspaceStatusRegistry: deps.workspaceStatusRegistry,
          selectSessionFn: (sel) => selectSessionBestEffort(deps.client, deps.directory, deps.logger, sel),
        })
      }

      // Compute host session ID for metadata persistence only (not session parenting)
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId

      if (!deps.sandboxManager) {
        deps.logger.log('handleStartLoop: sandbox manager not initialized; running in worktree-only mode')
      }

      // Create builtin worktree workspace (single call — no separate worktree.create)
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const ws = await createBuiltinWorktreeWorkspace(deps.client, {
        loopName: uniqueLoopName,
        directory: ctx.directory,
      }, deps.logger, deps.workspaceStatusRegistry)
      if (!ws) {
        deps.logger.error('handleStartLoop: failed to create builtin worktree workspace')
        return fail('internal_error', 500, 'Failed to create worktree workspace')
      }
      hostWorktreeDir = ws.directory
      worktreeBranch = ws.branch
      const workspaceId = ws.workspaceId
      createdWorkspaceId = ws.workspaceId

      // Build permissions
      const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager)
      sandboxEnabledForLoop = sandboxEnabled

      const permissionRuleset = buildLoopPermissionRuleset({ sandbox: sandboxEnabled })

      // Create single code session
      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: sessionTitle,
        directory: hostWorktreeDir!,
        permission: permissionRuleset,
        workspaceId,
        loopName: uniqueLoopName,
        logPrefix: 'handleStartLoop',
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
      })

      if (!createResult) {
        deps.logger.error('handleStartLoop: failed to create session')
        await rollbackLoopStart()
        return fail('internal_error', 500, 'Failed to create loop session')
      }

      // eslint-disable-next-line prefer-const
      sessionId = createResult.sessionId
      createdSessionId = sessionId
      // eslint-disable-next-line prefer-const
      initialBoundWorkspaceId = createResult.boundWorkspaceId

      if (createResult.bindFailed) {
        deps.logger.log(`handleStartLoop: workspace ${workspaceId} created but initial bind failed; will retry on next session`)
      }
      // Navigate the TUI to the worktree session immediately so the user sees the new
      // session before the slow sandbox + provisioning + prompt path runs.
      await doSelectInitialWorktreeSession(sessionId, initialBoundWorkspaceId, 'after session create')

      // Start sandbox if enabled
      if (sandboxEnabled && deps.sandboxManager) {
        const existingSandbox = deps.sandboxManager.getActive(uniqueLoopName)
        if (existingSandbox) {
          sandboxStarted = true
          sandboxContainer = existingSandbox.containerName
          deps.logger.log(`handleStartLoop: sandbox container ${existingSandbox.containerName} already provisioned by forge workspace adapter`)
        } else {
          try {
            sandboxStartAttempted = true
            const result = await deps.sandboxManager.start(uniqueLoopName, hostWorktreeDir!)
            sandboxStarted = true
            sandboxContainer = result.containerName
            deps.logger.log(`handleStartLoop: sandbox container ${result.containerName} started`)
          } catch (err) {
            deps.logger.error('handleStartLoop: failed to start sandbox; rolling back loop start', err)
            await rollbackLoopStart()
            return fail('internal_error', 500, 'Failed to start sandbox')
          }
        }
      }

      // Call attachLoopToSession with the final state
      const attachResult = await attachLoopToSession(deps, ctx, {
        sessionId,
        workspaceId: createdWorkspaceId,
        worktreeDir: hostWorktreeDir!,
        worktreeBranch,
        loopName: uniqueLoopName,
        displayName,
        executionName,
        hostSessionId,
        executionModel: resolvedExecutionModel,
        auditorModel: resolvedAuditorModel,
        executionVariant: resolvedExecutionVariant,
        auditorVariant: resolvedAuditorVariant,
        maxIterations,
        sandboxEnabled: sandboxEnabledForLoop,
        sandboxContainer: sandboxContainer ?? undefined,
        planText,
        selectSession: command.lifecycle?.selectSession,
        selectSessionTiming: command.lifecycle?.selectSessionTiming,
        startWatchdog: command.lifecycle?.startWatchdog,
        abortSourceSessionOnSuccess: command.lifecycle?.abortSourceSessionOnSuccess,
        onStarted: command.lifecycle?.onStarted,
      })

      if (!attachResult.ok) {
        await rollbackLoopStart()
        return fail(attachResult.code as ForgeExecutionError['code'], 503, attachResult.message)
      }

      const parsedExec = parseModelString(resolvedExecutionModel)
      const modelUsed = parsedExec
        ? `${parsedExec.providerID}/${parsedExec.modelID}`
        : null

      return ok({
        operation: 'loop.start',
        sessionId,
        loopName: uniqueLoopName,
        displayName,
        executionName,
        worktreeDir: hostWorktreeDir,
        worktreeBranch,
        workspaceId: createdWorkspaceId,
        hostSessionId,
        modelUsed,
        maxIterations,
      })
      
    } catch (err) {
      deps.logger.error('handleStartLoop: unexpected error', err)
      await rollbackLoopStart()
      
      return fail('internal_error', 500, 'Failed to start loop')
    }

    }

    const promise = doStart()
    inFlightLoopStarts.set(dedupeKey, promise)
    try {
      return await promise
    } finally {
      inFlightLoopStarts.delete(dedupeKey)
    }
  }
  
  async function handleLoopStatus(
    _ctx: ForgeExecutionRequestContext,
    command: GetLoopStatusCommand,
  ): Promise<ForgeExecutionResponse<LoopStatusResult>> {
    let states: import('../loop/state').LoopState[]
    
    if (command.selector?.kind === 'only-active') {
      states = deps.loop.listActive()
    } else {
      const active = deps.loop.listActive()
      const recent = deps.loop.listRecent()
      states = [...active, ...recent]
    }
    
    // Apply selector filtering
    if (command.selector?.kind === 'exact' || command.selector?.kind === 'partial') {
      const { match, candidates } = findPartialMatch(
        command.selector.name,
        states,
        (s) => [s.loopName, s.worktreeBranch].filter(Boolean) as string[]
      )
      
      if (!match && candidates.length === 0 && command.selector.kind === 'exact') {
        return fail('not_found', 404, `No loop found for "${command.selector.name}"`)
      }
      
      if (!match && candidates.length > 0) {
        return fail('conflict', 409, `Multiple loops match "${command.selector.name}"`, undefined, candidates.map(s => s.loopName))
      }
      
      if (match) {
        states = [match]
      } else {
        states = []
      }
    }
    
    // Limit results
    const limit = command.limit ?? 20
    if (states.length > limit) {
      states = states.slice(0, limit)
    }
    
    const statusFromState = (state: import('../loop/state').LoopState): LoopStatusView['status'] => {
      if (state.active) return 'running'
      if (state.terminationReason) return terminationStatusFor(parseTerminationReasonString(state.terminationReason))
      return 'completed'
    }

    // Convert to status views
    const loops: LoopStatusView[] = states.map(state => {
      const cap200 = (s: string | null | undefined): string | null =>
        s ? (s.length > 200 ? s.slice(0, 200) : s) : null
      const sectionViews = state.totalSections > 0
        ? (() => {
            const digest = deps.loop.service.getCompletedSectionDigest(state)
            const sectionByIndex = new Map(
              (deps.sectionPlansRepo?.list(deps.projectId, state.loopName) ?? []).map(s => [s.sectionIndex, s] as const),
            )
            return Array.from({ length: state.totalSections }, (_, i) => {
              const section = sectionByIndex.get(i)
              const summary = digest.find(s => s.index === i)
              return {
                index: i,
                title: section?.title ?? `Section ${i + 1}`,
                status: section?.status ?? 'pending',
                attempts: section?.attempts ?? 0,
                startedAt: section?.startedAt,
                completedAt: section?.completedAt,
                summaryDone: cap200(summary?.summaryDone),
                summaryDeviations: cap200(summary?.summaryDeviations),
                summaryFollowUps: cap200(summary?.summaryFollowUps),
              }
            })
          })()
        : undefined
      
      // Fetch cumulative usage from persisted aggregate
      let usage: import('../loop/token-usage').LoopUsageSummary | undefined
      if (deps.loopSessionUsageRepo) {
        const aggregate = deps.loopSessionUsageRepo.getAggregate(deps.projectId, state.loopName)
        if (aggregate) {
          usage = aggregateToUsageSummary(aggregate)
        }
      }
      
      const restartability = getRestartability(state, {
        worktreeExists: existsSync,
        branchExists: () => loopBranchExists(state, _ctx.directory),
      })
      
      return {
        loopName: state.loopName,
        displayName: state.loopName, // Could extract from plan if needed
        status: statusFromState(state),
        phase: state.phase,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        sessionId: state.sessionId,
        active: state.active,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        terminationReason: state.terminationReason,
        worktree: !!state.worktree,
        worktreeDir: state.worktreeDir,
        worktreeBranch: state.worktreeBranch,
        executionModel: state.executionModel,
        auditorModel: state.auditorModel,
        workspaceId: state.workspaceId,
        hostSessionId: state.hostSessionId,
        currentSectionIndex: state.currentSectionIndex,
        totalSections: state.totalSections,
        finalAuditDone: state.finalAuditDone,
        usage,
        restartable: restartability.restartable,
        restartRequiresForce: restartability.restartRequiresForce,
        restartBlockedReason: restartability.restartBlockedReason,
        restartBlockedMessage: restartability.restartBlockedMessage,
        sections: sectionViews,
      }
    })
    
    const active = loops.filter(l => l.active)
    const recent = loops.filter(l => !l.active)
    
    return ok({
      operation: 'loop.status',
      loops,
      active,
      recent,
    })
  }
  
  async function handleLoopCancel(
    _ctx: ForgeExecutionRequestContext,
    command: CancelLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopCancelledResult>> {
    if (!deps.loopHandler) {
      return fail('internal_error', 500, 'Loop handler not available')
    }

    let state: import('../loop/state').LoopState

    // Resolve loop by selector
    if (!command.selector || command.selector.kind === 'only-active') {
      const active = deps.loop.listActive()
      if (active.length === 0) return fail('not_found', 404, 'No active loops.')
      if (active.length !== 1) {
        return fail('conflict', 409, 'Multiple active loops. Specify a name.', undefined, active.map(s => s.loopName))
      }
      state = active[0]
    } else {
      const name = command.selector.name
      const { match, candidates } = deps.loop.findMatchByName(name)
      if (!match) {
        if (candidates.length > 0) {
          return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, undefined, candidates.map(s => s.loopName))
        }
        const recent = deps.loop.listRecent()
        const foundRecent = recent.find(s => s.loopName === name || (s.worktreeBranch && s.worktreeBranch.toLowerCase().includes(name.toLowerCase())))
        if (foundRecent) {
          return fail('conflict', 409, `Loop "${foundRecent.loopName}" has already completed.`)
        }
        return fail('not_found', 404, `No active loop found for loop "${name}".`)
      }
      state = match
      if (!state.active) {
        return fail('conflict', 409, `Loop "${state.loopName}" has already completed.`)
      }
    }

    await deps.loopHandler.cancelBySessionId(state.sessionId)
    deps.logger.log(`loop-cancel: cancelled loop for session=${state.sessionId} at iteration ${state.iteration}`)

    let worktreeRemoved = false
    const cleanupRequested = command.cleanupWorktree ?? deps.config.loop?.cleanupWorktree
    if (cleanupRequested && state.worktree && state.worktreeDir) {
      const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
      const result = await cleanupLoopWorktree({
        worktreeDir: state.worktreeDir,
        logPrefix: 'loop-cancel',
        logger: deps.logger,
      })
      worktreeRemoved = result.removed
    }

    return ok({
      operation: 'loop.cancel',
      loopName: state.loopName,
      sessionId: state.sessionId,
      iteration: state.iteration,
      worktreeDir: state.worktreeDir,
      worktreeRemoved,
      worktree: !!state.worktree,
      worktreeBranch: state.worktreeBranch,
    })
  }
  
  async function handleLoopRestart(
    ctx: ForgeExecutionRequestContext,
    command: RestartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopRestartedResult>> {
    if (!deps.loopHandler) {
      return fail('internal_error', 500, 'Loop handler not available')
    }

    if (command.selector.kind === 'only-active') {
      return fail('bad_request', 400, 'Specify a loop name to restart. Use loop-status to see available loops.')
    }

    const name = command.selector.name
    const active = deps.loop.listActive()
    const recent = deps.loop.listRecent()
    const allStates = [...active, ...recent]
    const { match: stoppedState, candidates } = findPartialMatch(name, allStates, s => [s.loopName, s.worktreeBranch])
    if (!stoppedState && candidates.length > 0) {
      return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, undefined, candidates.map(s => s.loopName))
    }
    if (!stoppedState) {
      return fail('not_found', 404, `No loop found for "${name}".`, undefined, allStates.map(s => s.loopName))
    }
    
    const restartability = getRestartability(stoppedState, {
      force: command.force,
      worktreeExists: existsSync,
      branchExists: () => loopBranchExists(stoppedState, ctx.directory),
    })
    
    if (!restartability.restartable) {
      return fail('conflict', 409, restartability.restartBlockedMessage!)
    }
    
    if (restartability.restartRequiresForce && !command.force) {
      return fail('conflict', 409, restartability.restartBlockedMessage!)
    }

    const restartSandbox = isSandboxEnabled(deps.config, deps.sandboxManager)
    deps.logger.log(
      `handleRestartLoop: [perm-diag] worktree=${String(stoppedState.worktree)} sandbox=${String(restartSandbox)}`
    )
    const permissionRuleset = buildLoopPermissionRuleset({ sandbox: restartSandbox })
    const previousState = { ...stoppedState }
    let bindFailed = false
    const previousSessionId = stoppedState.sessionId

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean }
      | { ok: false; error: string }

    const outcome = await deps.loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
      if (stoppedState.active) {
        const latestState = deps.loop.service.getActiveState(stoppedState.loopName)
        if (latestState?.active) {
          try { await deps.client.session.abort({ sessionID: latestState.sessionId }) } catch {}
          await deps.loopHandler!.clearLoopTimers(stoppedState.loopName)
          // Sync stoppedState with latest persisted values
          Object.assign(stoppedState, {
            sessionId: latestState.sessionId,
            iteration: latestState.iteration,
            prompt: latestState.prompt,
            worktreeDir: latestState.worktreeDir,
            projectDir: latestState.projectDir,
            worktreeBranch: latestState.worktreeBranch,
            maxIterations: latestState.maxIterations,
            executionModel: latestState.executionModel,
            auditorModel: latestState.auditorModel,
            executionVariant: latestState.executionVariant,
            auditorVariant: latestState.auditorVariant,
            workspaceId: latestState.workspaceId,
            hostSessionId: latestState.hostSessionId,
            sandbox: latestState.sandbox,
          })
        }
      }

      stoppedState.iteration = 1

      // Create new session for restart

      let newSessionId: string | undefined

      if (stoppedState.worktree) {
        const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const ws = await createBuiltinWorktreeWorkspace(deps.client, {
          loopName: stoppedState.loopName,
          directory: stoppedState.projectDir || ctx.directory,
        }, deps.logger, deps.workspaceStatusRegistry)
        if (!ws) return { ok: false, error: 'Restart failed: could not create fresh workspace for preserved worktree.' }
        stoppedState.workspaceId = ws.workspaceId
        stoppedState.worktreeDir = ws.directory
        stoppedState.worktreeBranch = ws.branch
      }

      if (restartSandbox && deps.sandboxManager) {
        try {
          const sbxResult = await deps.sandboxManager.start(stoppedState.loopName, stoppedState.worktreeDir)
          deps.logger.log(`loop-restart: started sandbox container ${sbxResult.containerName}`)
        } catch (err) {
          deps.logger.error('loop-restart: failed to start sandbox container', err)
          return { ok: false, error: 'Restart failed: could not start sandbox container.' }
        }
      }

      // Unified session creation for restart (always a single code session)
      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: formatLoopSessionTitle(stoppedState.loopName, {
          iteration: stoppedState.iteration ?? 0,
          currentSectionIndex: stoppedState.currentSectionIndex ?? 0,
          totalSections: stoppedState.totalSections ?? 0,
        }),
        directory: stoppedState.worktreeDir,
        permission: stoppedState.phase === 'final_auditing' ? buildAuditSessionPermissionRuleset({ sandbox: restartSandbox }) : permissionRuleset,
        workspaceId: stoppedState.workspaceId,
        loopName: stoppedState.loopName,
        logPrefix: 'loop-restart',
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
      })

      if (!createResult) return { ok: false, error: 'Failed to create new session for restart.' }

      // eslint-disable-next-line prefer-const
      newSessionId = createResult.sessionId
      if (createResult.bindFailed) {
        stoppedState.workspaceId = undefined
        bindFailed = true
      }

      // Navigate the TUI to the recreated worktree session and wait for the
      // workspace to connect, mirroring handleStartLoop. Without this the loop
      // restarts and runs but its workspace never connects/focuses in the TUI.
      await selectInitialWorktreeSession(newSessionId, createResult.boundWorkspaceId, 'on restart', {
        selectSession: true,
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
        selectSessionFn: (sel) => selectSessionBestEffort(deps.client, deps.directory, deps.logger, sel),
      })

      // Unified section extraction on restart — preserve existing progress if sections exist
      if (!stoppedState.totalSections) {
        const planText = stoppedState.prompt ?? ''
        const { totalSections } = applyPlanDecomposition({
          projectId: ctx.projectId,
          loopName: stoppedState.loopName,
          planText,
          loopsRepo: deps.loopsRepo,
          sectionPlansRepo: deps.sectionPlansRepo,
        })
        stoppedState.totalSections = totalSections
        if (totalSections > 0) {
          stoppedState.currentSectionIndex = 0
        }
      }
      // else: existing totalSections preserved as-is

      const effectiveSessionId = newSessionId!
      const restartPhase = stoppedState.phase === 'final_auditing' ? 'final_auditing' as const : 'coding' as const

      const newState: import('../loop/state').LoopState = {
        active: true,
        sessionId: effectiveSessionId,
        loopName: stoppedState.loopName,
        worktreeDir: stoppedState.worktreeDir,
        projectDir: stoppedState.projectDir || stoppedState.worktreeDir,
        worktreeBranch: stoppedState.worktreeBranch,
        iteration: stoppedState.iteration,
        maxIterations: stoppedState.maxIterations,
        startedAt: new Date().toISOString(),
        prompt: stoppedState.prompt,
        phase: restartPhase,
        errorCount: 0,
        auditCount: 0,
        status: 'running',
        worktree: stoppedState.worktree,
        sandbox: restartSandbox,
        sandboxContainer: restartSandbox ? deps.sandboxManager?.docker.containerName(stoppedState.loopName) : undefined,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
        executionVariant: stoppedState.executionVariant,
        auditorVariant: stoppedState.auditorVariant,
        workspaceId: stoppedState.workspaceId,
        hostSessionId: stoppedState.hostSessionId,
        currentSectionIndex: stoppedState.currentSectionIndex,
        totalSections: stoppedState.totalSections,
        finalAuditDone: stoppedState.finalAuditDone,
      }
      // Build appropriate prompt based on persisted state
      let promptText: string

      if (stoppedState.totalSections > 0) {
        // Use persisted section state to build the correct section prompt
        if (stoppedState.phase === 'final_auditing') {
          promptText = deps.loop.service.buildFinalAuditPrompt(stoppedState)
        } else {
          promptText = deps.loop.service.buildSectionInitialPrompt(stoppedState)
        }
      } else {
        // Legacy non-sectioned prompt
        promptText = stoppedState.prompt ?? ''
      }

      const loopModel = stoppedState.phase === 'final_auditing'
        ? parseModelString(stoppedState.auditorModel ?? deps.config.auditorModel)
        : parseModelString(stoppedState.executionModel) ?? parseModelString(deps.config.executionModel)
      const workspaceParam = stoppedState.workspaceId ? { workspace: stoppedState.workspaceId } : {}

      const promptAgent = stoppedState.phase === 'final_auditing' ? 'auditor-loop' as const : 'code' as const

      deps.loopsRepo.restart(ctx.projectId, stoppedState.loopName, {
        sessionId: newState.sessionId,
        phase: newState.phase,
        iteration: newState.iteration,
        auditCount: newState.auditCount,
        sandbox: newState.sandbox ?? false,
        sandboxContainer: newState.sandboxContainer ?? null,
        workspaceId: newState.workspaceId ?? null,
        currentSectionIndex: newState.currentSectionIndex,
        totalSections: newState.totalSections,
        finalAuditDone: newState.finalAuditDone,
        startedAt: new Date(newState.startedAt).getTime(),
      })

      deps.loop.service.registerLoopSession(effectiveSessionId, stoppedState.loopName)

      const restartVariant = promptAgent === 'auditor-loop'
        ? stoppedState.auditorVariant
        : stoppedState.executionVariant

      const performRestartPrompt = async (model?: { providerID: string; modelID: string }): Promise<{ error?: unknown }> => {
        markPromptSent(stoppedState.loopName, effectiveSessionId, deps.logger)
        try {
          await deps.client.session.promptAsync({
            sessionID: effectiveSessionId,
            directory: stoppedState.worktreeDir,
            parts: [{ type: 'text' as const, text: promptText }],
            agent: promptAgent,
            ...(model ? { model, ...(restartVariant ? { variant: restartVariant } : {}) } : {}),
            ...workspaceParam,
          })
          return {}
        } catch (err) {
          return { error: err }
        }
      }

      // Retry the prompt with backoff: a just-created + warped session can briefly
      // report "Session not found" before it is durably registered. Without this,
      // a transient race tore the restart down and reverted the loop to terminal.
      // (Workspace connection was already awaited via selectInitialWorktreeSession.)
      const RESTART_PROMPT_MAX_ATTEMPTS = 4
      let promptResult: { error?: unknown } = { error: new Error('restart prompt not attempted') }
      for (let attempt = 1; attempt <= RESTART_PROMPT_MAX_ATTEMPTS; attempt++) {
        const { result } = await sendLoopPrompt({
          loopName: stoppedState.loopName,
          sessionId: effectiveSessionId,
          agent: promptAgent,
          logger: deps.logger,
          primaryModel: loopModel,
          useInFlightGuard: true,
          clearPendingOnError: false,
          performPrompt: performRestartPrompt,
        })
        promptResult = result
        if (!result.error || !isTransientSessionError(result.error) || attempt === RESTART_PROMPT_MAX_ATTEMPTS) {
          break
        }
        const backoffMs = 250 * attempt
        deps.logger.log(`loop-restart: new session not ready yet (attempt ${attempt}/${RESTART_PROMPT_MAX_ATTEMPTS}); retrying prompt in ${backoffMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }

      if (promptResult.error) {
        const isConcurrent = promptResult.error instanceof ConcurrentPromptError
        if (!isConcurrent) {
          clearPromptPending(stoppedState.loopName, deps.logger)
        }
        deps.logger.error('loop-restart: failed to send prompt', promptResult.error)
        // Save section plans before deleteState (which cascades to section_plans)
        const savedPlans = deps.sectionPlansRepo?.list(ctx.projectId, stoppedState.loopName) ?? []
        deps.loop.service.deleteState(stoppedState.loopName)
        try {
          deps.loop.service.setState(previousState.loopName, previousState)
          if (previousState.active) deps.loop.service.registerLoopSession(previousState.sessionId, previousState.loopName)
          // Restore section plans after setState
          if (savedPlans.length > 0) {
            deps.sectionPlansRepo?.restoreAll(savedPlans)
          }
        } catch (restoreErr) {
          deps.logger.error('loop-restart: failed to restore previous loop state', restoreErr)
        }
        if (restartSandbox && deps.sandboxManager) {
          await deps.sandboxManager.stop(stoppedState.loopName).catch(() => {})
        }
        return { ok: false, error: 'Restart failed: could not send prompt to new session.' }
      }

      deps.loopHandler!.startWatchdog(stoppedState.loopName)

      return { ok: true, newSessionId: effectiveSessionId, previousSessionId, sandbox: restartSandbox, bindFailed }
    })

    if (!outcome.ok) return fail('internal_error', 500, outcome.error)

    if (outcome.bindFailed) {
      publishWorkspaceDetachedToast({
        client: deps.client,
        directory: stoppedState.projectDir ?? stoppedState.worktreeDir,
        loopName: stoppedState.loopName,
        logger: deps.logger,
        context: 'on restart',
      })
    }

    return ok({
      operation: 'loop.restart',
      loopName: stoppedState.loopName,
      sessionId: outcome.newSessionId,
      previousSessionId: outcome.previousSessionId,
      worktreeDir: stoppedState.worktreeDir,
      worktreeBranch: stoppedState.worktreeBranch,
      worktree: !!stoppedState.worktree,
      sandbox: outcome.sandbox,
      bindFailed: outcome.bindFailed,
      iteration: stoppedState.iteration,
    })
  }
  
  async function dispatch<C extends ForgeExecutionCommand>(
    ctx: ForgeExecutionRequestContext,
    command: C,
  ): Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>> {
    switch (command.type) {
      case 'plan.execute.newSession':
        return handlePlanNewSession(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      case 'plan.execute.here':
        return handlePlanHere(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      case 'loop.start':
        return handleStartLoop(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      case 'loop.status':
        return handleLoopStatus(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      case 'loop.cancel':
        return handleLoopCancel(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      case 'loop.restart':
        return handleLoopRestart(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
      default:
        return fail('bad_request', 400, 'Unknown command type') as ForgeExecutionResponse<ForgeExecutionResult<C>>
    }
  }
  
  return {
    dispatch,
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================
