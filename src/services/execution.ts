/**
 * Forge Execution Service - Command Bus Interface
 * 
 * Shared execution service for plan execution and loop lifecycle.
 * Provides a unified interface for internal tools, API, and TUI surfaces.
 */

import type { PluginConfig, Logger } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import { extractPlanTitle, extractLoopNames } from '../utils/plan-execution'
import { parseModelString, retryWithModelFallback, resolveDecomposerModel } from '../utils/model-fallback'

import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { findPartialMatch } from '../utils/partial-match'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { join } from 'path'
import { existsSync } from 'fs'
import { decomposeDeterministically } from './deterministic-decomposer'
import { markPromptSent, clearPromptPending, terminationStatusFor, parseTerminationReasonString } from '../loop'

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
  mode: 'in-place' | 'worktree'
  maxIterations?: number
  executionModel?: string
  auditorModel?: string
  hostSessionId?: string
  lifecycle?: {
    selectSession?: boolean
    selectSessionTiming?: 'after-create' | 'after-prompt'
    startWatchdog?: boolean
    abortSourceSessionOnSuccess?: boolean
    onStarted?: (info: {
      mode: 'in-place' | 'worktree'
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
  mode: 'in-place' | 'worktree'
  maxIterations?: number
  executionModel?: string
  auditorModel?: string
  hostSessionId?: string
  lifecycle?: StartLoopCommand['lifecycle']
}

export function buildStartLoopCommand(input: BuildStartLoopCommandInput): StartLoopCommand {
  return {
    type: 'loop.start',
    source: input.source,
    title: input.title,
    loopName: input.loopName,
    mode: input.mode,
    maxIterations: input.maxIterations,
    executionModel: input.executionModel,
    auditorModel: input.auditorModel,
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
  mode: 'in-place' | 'worktree'
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
  decompositionStatus?: string
  decompositionMode?: string
  currentSectionIndex?: number
  totalSections?: number
  finalAuditDone?: boolean
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
  v2: OpencodeClient
  legacyClient?: import('@opencode-ai/sdk').OpencodeClient
  plansRepo: PlansRepo
  loopsRepo: LoopsRepo
  loopHandler?: ReturnType<typeof createLoopEventHandler>
  loop: import('../loop/runtime').Loop
  sandboxManager?: SandboxManager | null
  sectionPlansRepo?: import('../storage/repos/section-plans-repo').SectionPlansRepo
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
      const planText = deps.loop.getPlanText(source.loopName, ctx.sourceSessionId ?? '')
      if (planText) {
        return { ok: true, planText }
      }

      // Fallback to loopsRepo
      const large = deps.loopsRepo.getLarge(ctx.projectId, source.loopName)
      if (large?.prompt) {
        return { ok: true, planText: large.prompt }
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
// Fallback Helpers for Legacy Plugin SDK
// ============================================================================

interface SessionCreateInput {
  title: string
  directory: string
  permission?: ReturnType<typeof import('../constants/loop').buildLoopPermissionRuleset>
}

interface SessionCreateResult {
  data?: { id: string }
  error?: unknown
}

interface SessionPromptInput {
  sessionID: string
  directory: string
  parts: Array<{ type: 'text'; text: string }>
  agent: string
  model?: { providerID: string; modelID: string }
  workspace?: string
}

interface SessionPromptResult {
  data?: unknown
  error?: unknown
}

async function createSessionWithFallback(
  deps: ForgeExecutionServiceDeps,
  input: SessionCreateInput,
): Promise<SessionCreateResult> {
  // Try v2 SDK first
  try {
    const result = await deps.v2.session.create({
      title: input.title,
      directory: input.directory,
      ...(input.permission ? { permission: input.permission } : {}),
    })
    
    if (result.data) {
      return { data: result.data }
    }
    
    if (result.error) {
      const errorMsg = result.error instanceof Error ? result.error.message : String(result.error)
      if (errorMsg.includes('Unable to connect')) {
        deps.logger.log('createSessionWithFallback: v2 SDK unavailable, falling back to legacy SDK')
      } else {
        deps.logger.error('createSessionWithFallback: v2 SDK error', result.error)
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('createSessionWithFallback: v2 SDK threw connection error, falling back to legacy SDK')
    } else {
      deps.logger.error('createSessionWithFallback: v2 SDK threw error', err)
    }
  }
  
  // Fallback to legacy SDK
  if (!deps.legacyClient) {
    deps.logger.error('createSessionWithFallback: no legacy SDK available')
    return { error: new Error('No legacy SDK available') }
  }
  
  try {
    const result = await deps.legacyClient.session.create({
      body: {
        title: input.title,
        ...(input.permission ? { permission: input.permission } : {}),
      },
      query: {
        directory: input.directory,
      },
    } as Parameters<typeof deps.legacyClient.session.create>[0])
    
    const session = result.data as { id?: string } | undefined
    if (session?.id) {
      return { data: { id: session.id } }
    }
    
    return { error: new Error('Legacy SDK returned no session ID') }
  } catch (err) {
    deps.logger.error('createSessionWithFallback: legacy SDK failed', err)
    return { error: err }
  }
}

async function promptSessionWithFallback(
  deps: ForgeExecutionServiceDeps,
  input: SessionPromptInput,
  model?: { providerID: string; modelID: string },
): Promise<{ result: SessionPromptResult; usedModel?: typeof model }> {
  // Try v2 SDK first
  try {
    const result = await deps.v2.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.directory,
      parts: input.parts,
      agent: input.agent,
      ...(model ? { model } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
    })
    
    if (!result.error) {
      return { result: { data: result.data }, usedModel: model }
    }
    
    const errorMsg = result.error instanceof Error ? result.error.message : String(result.error)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('promptSessionWithFallback: v2 SDK unavailable, falling back to legacy SDK')
    } else {
      deps.logger.error('promptSessionWithFallback: v2 SDK error', result.error)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('promptSessionWithFallback: v2 SDK threw connection error, falling back to legacy SDK')
    } else {
      deps.logger.error('promptSessionWithFallback: v2 SDK threw error', err)
    }
  }
  
  // Fallback to legacy SDK
  if (!deps.legacyClient) {
    deps.logger.error('promptSessionWithFallback: no legacy SDK available')
    return { result: { error: new Error('No legacy SDK available') }, usedModel: model }
  }
  
  try {
    const legacyResult = await deps.legacyClient.session.promptAsync({
      path: { id: input.sessionID },
      query: {
        directory: input.directory,
        ...(input.workspace ? { workspace: input.workspace } : {}),
      },
      body: {
        agent: input.agent,
        parts: input.parts,
        ...(model ? { model } : {}),
      },
    } as Parameters<typeof deps.legacyClient.session.promptAsync>[0])
    
    // Legacy SDK returns { data, request, response }
    const legacyData = legacyResult as { data?: unknown }
    if (!legacyData.data) {
      return { result: { error: new Error('Legacy SDK returned no data') }, usedModel: model }
    }
    
    return { result: { data: legacyData.data }, usedModel: model }
  } catch (err) {
    deps.logger.error('promptSessionWithFallback: legacy SDK failed', err)
    return { result: { error: err }, usedModel: model }
  }
}

async function selectSessionWithFallback(
  deps: ForgeExecutionServiceDeps,
  selection: { sessionID: string; workspace?: string },
): Promise<void> {
  // Try v2 TUI selectSession first
  try {
    if (deps.v2.tui) {
      await deps.v2.tui.selectSession({
        sessionID: selection.sessionID,
        ...(selection.workspace ? { workspace: selection.workspace } : {}),
      })
      return
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('selectSessionWithFallback: v2 TUI unavailable, falling back to publish')
    } else {
      deps.logger.error('selectSessionWithFallback: v2 TUI error', err)
    }
  }
  
  // Fallback to v2 TUI publish with tui.session.select event
  try {
    if (deps.v2.tui) {
      await deps.v2.tui.publish({
        directory: deps.directory,
        body: {
          type: 'tui.session.select',
          properties: {
            sessionID: selection.sessionID,
            ...(selection.workspace ? { workspace: selection.workspace } : {}),
          },
        },
      })
      return
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('selectSessionWithFallback: v2 TUI publish unavailable, falling back to legacy SDK')
    } else {
      deps.logger.error('selectSessionWithFallback: v2 TUI publish error', err)
    }
  }
  
  // Fallback to legacy SDK TUI
  if (!deps.legacyClient?.tui) {
    deps.logger.error('selectSessionWithFallback: no legacy TUI available')
    return
  }
  
  try {
    // Fallback to publish with tui.session.select event
    await deps.legacyClient.tui.publish({
      body: {
        type: 'tui.session.select',
        properties: {
          sessionID: selection.sessionID,
          ...(selection.workspace ? { workspace: selection.workspace } : {}),
        },
      },
    } as unknown as Parameters<typeof deps.legacyClient.tui.publish>[0])
  } catch (err) {
    deps.logger.error('selectSessionWithFallback: legacy TUI failed', err)
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
    const title = command.title ?? extractPlanTitle(planText)
    const sessionTitle = formatPlanSessionTitle(title)
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    
    // Create new session with fallback
    const createResult = await createSessionWithFallback(deps, {
      title: sessionTitle,
      directory: ctx.directory,
    })
    
    if (!createResult.data) {
      deps.logger.error('handlePlanNewSession: failed to create session', createResult.error)
      return fail('internal_error', 500, 'Failed to create session')
    }
    
    const sessionId = createResult.data.id
    deps.logger.log(`handlePlanNewSession: created session=${sessionId}`)
    
    // Navigate TUI if requested with early timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming === 'after-create') {
      selectSessionWithFallback(deps, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI (early)', err as Error)
      })
    }
    
    // Prompt code agent with fallback
    const { result: promptResult, usedModel: actualModel } = await promptSessionWithFallback(
      deps,
      {
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: planText }],
        agent: 'code',
      },
      parsedModel!,
    )
    
    if (promptResult.error) {
      deps.logger.error('handlePlanNewSession: failed to prompt session', promptResult.error)
      
      // Delete created session if requested
      if (command.lifecycle?.deleteSessionOnPromptFailure) {
        await deps.v2.session.delete({ sessionID: sessionId, directory: ctx.directory }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to delete failed session', err as Error)
        })
      }
      
      // Return to source session if requested
      if (command.lifecycle?.returnToSourceOnPromptFailure && ctx.sourceSessionId) {
        selectSessionWithFallback(deps, { sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to return to source session', err as Error)
        })
      }
      
      return fail('prompt_failed', 502, 'Session created but failed to send plan')
    }
    
    // Navigate TUI if requested with default/post-prompt timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming !== 'after-create') {
      selectSessionWithFallback(deps, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI', err as Error)
      })
    }
    
    // Abort source session if requested
    if (command.lifecycle?.abortSourceSession && ctx.sourceSessionId) {
      deps.v2.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to abort source session', err as Error)
      })
    }
    
    const modelUsed = actualModel
      ? `${actualModel.providerID}/${actualModel.modelID}`
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
    const title = command.title ?? extractPlanTitle(planText)
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    
    // Build in-place prompt
    const inPlacePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`
    
    // Prompt code agent in target session with fallback
    const { result: promptResult, usedModel: actualModel } = await promptSessionWithFallback(
      deps,
      {
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: inPlacePrompt }],
        agent: 'code',
      },
      parsedModel,
    )
    
    if (promptResult.error) {
      deps.logger.error('handlePlanHere: in-place execution failed', promptResult.error)
      return fail('prompt_failed', 502, 'Failed to execute in-place')
    }
    
    const modelUsed = actualModel
      ? `${actualModel.providerID}/${actualModel.modelID}`
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
    const { displayName, executionName } = extractLoopNames(planText)
    const title = command.title ?? displayName
    const sessionTitle = formatLoopSessionTitle(title)
    
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
    const loopModel = parseModelString(resolvedExecutionModel)
    
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
    let sandboxEnabledForLoop = false
    let loopStatePersisted = false

    const rollbackLoopStart = async (): Promise<void> => {
      if (createdSessionId) {
        await deps.v2.session.abort({ sessionID: createdSessionId }).catch(() => {})
      }
      if (loopStatePersisted) {
        deps.loop.deleteState(uniqueLoopName)
        loopStatePersisted = false
      }
      if ((sandboxStarted || sandboxStartAttempted) && deps.sandboxManager) {
        await deps.sandboxManager.stop(uniqueLoopName).catch(() => {})
        sandboxStarted = false
        sandboxContainer = null
      }
      if (createdWorkspaceId) {
        const workspaceApi = deps.v2.experimental?.workspace
        if (workspaceApi?.remove) {
          await workspaceApi.remove({ id: createdWorkspaceId }).catch(() => {})
        }
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

      const selectInitialWorktreeSession = async (
        targetSessionId: string,
        boundWorkspaceId: string | undefined,
        context: string,
      ): Promise<void> => {
        if (!boundWorkspaceId || !command.lifecycle?.selectSession) return
        const SELECT_TIMEOUT_MS = 2000
        try {
          await Promise.race([
            selectSessionWithFallback(deps, { sessionID: targetSessionId, workspace: boundWorkspaceId }),
            new Promise<void>((resolve) => setTimeout(resolve, SELECT_TIMEOUT_MS)),
          ])
        } catch (err) {
          deps.logger.error(`handleStartLoop: failed to navigate TUI to worktree session ${context}`, err as Error)
        }
      }

      // Compute host session ID for metadata persistence only (not session parenting)
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId
      
      // Determine decomposer mode early so we don't create an unused code session in agent mode
      const decomposerConfig = deps.config.decomposer ?? { enabled: true, mode: 'agent' as const, onParseFailure: 'legacy' as const, maxSections: 12 }
      const isAgentDecomposer = decomposerConfig.enabled !== false && decomposerConfig.mode === 'agent'

      if (!deps.sandboxManager) {
        deps.logger.error('handleStartLoop: sandbox manager not initialized; loops require Docker')
        return fail(
          'internal_error',
          500,
          'Sandbox required: Docker is not available. Install Docker and build oc-forge-sandbox:latest before starting a loop.',
        )
      }
      
      // Create builtin worktree workspace (single call — no separate worktree.create)
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const ws = await createBuiltinWorktreeWorkspace(deps.v2, {
        loopName: uniqueLoopName,
        directory: ctx.directory,
      }, deps.logger)
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

      const permissionRuleset = buildLoopPermissionRuleset({
        isSandbox: sandboxEnabled,
      })

      // Create session (code session or decomposer session based on decomposer mode)
      if (isAgentDecomposer) {
        const createResult = await createLoopSessionWithWorkspace({
          v2: deps.v2,
          title: `decomposer-${uniqueLoopName}`,
          directory: hostWorktreeDir!,
          permission: permissionRuleset,
          workspaceId,
          logPrefix: 'handleStartLoop:decomposer',
          logger: deps.logger,
          legacyClient: deps.legacyClient,
        })
        if (!createResult) {
          deps.logger.error('handleStartLoop: failed to create decomposer session')
          await rollbackLoopStart()
          return fail('internal_error', 500, 'Failed to create decomposer session')
        }
        sessionId = createResult.sessionId
        createdSessionId = sessionId
        initialBoundWorkspaceId = createResult.boundWorkspaceId
        if (createResult.bindFailed) {
          deps.logger.log(
            `handleStartLoop: workspace ${workspaceId} created but initial decomposer bind failed; will retry on next session`,
          )
        }
        // Navigate the TUI to the worktree session immediately so the user sees the new
        // session before the slow sandbox + provisioning + prompt path runs.
        await selectInitialWorktreeSession(sessionId, initialBoundWorkspaceId, 'after session create (decomposer)')
      } else {
        const createResult = await createLoopSessionWithWorkspace({
          v2: deps.v2,
          title: sessionTitle,
          directory: hostWorktreeDir!,
          permission: permissionRuleset,
          workspaceId,
          logPrefix: 'handleStartLoop',
          logger: deps.logger,
        })

        if (!createResult) {
          deps.logger.error('handleStartLoop: failed to create session')
          await rollbackLoopStart()
          return fail('internal_error', 500, 'Failed to create loop session')
        }

        sessionId = createResult.sessionId
        createdSessionId = sessionId
        initialBoundWorkspaceId = createResult.boundWorkspaceId

        if (createResult.bindFailed) {
          deps.logger.log(`handleStartLoop: workspace ${workspaceId} created but initial bind failed; will retry on next session`)
        }
        // Navigate the TUI to the worktree session immediately so the user sees the new
        // session before the slow sandbox + provisioning + prompt path runs.
        await selectInitialWorktreeSession(sessionId, initialBoundWorkspaceId, 'after session create')
      }

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
            deps.logger.error('handleStartLoop: failed to start sandbox', err)
            await rollbackLoopStart()
            return fail('internal_error', 500, 'Failed to start sandbox')
          }
        }
      }
      
      // Persist loop state
      const state: import('../loop/state').LoopState = {
        active: true,
        sessionId,
        loopName: uniqueLoopName,
        worktreeDir: hostWorktreeDir ?? ctx.directory,
        projectDir: ctx.directory,
        worktreeBranch,
        iteration: 1,
        maxIterations,
        startedAt: new Date().toISOString(),
        prompt: planText,
        phase: 'coding',
        errorCount: 0,
        auditCount: 0,
        worktree: true,
        sandbox: sandboxEnabledForLoop,
        sandboxContainer: sandboxContainer ?? undefined,
        executionModel: resolvedExecutionModel,
        auditorModel: resolvedAuditorModel,
        workspaceId: createdWorkspaceId,
        hostSessionId,
        decompositionStatus: 'pending',
        decompositionMode: 'agent',
        decompositionSessionId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
      }
      
      deps.loop.setState(uniqueLoopName, state)
      loopStatePersisted = true
      deps.loop.registerLoopSession(sessionId, uniqueLoopName)
      
      deps.logger.log(`handleStartLoop: state stored for loop=${uniqueLoopName}`)

      // Order: createBuiltinWorktreeWorkspace → createLoopSessionWithWorkspace → await selectInitialWorktreeSession
      // (with bounded 2s timeout) → sandbox start → loop-state persist → onStarted.
      command.lifecycle?.onStarted?.({
        mode: command.mode,
        sessionId,
        loopName: uniqueLoopName,
        displayName,
        worktreeDir: hostWorktreeDir,
        workspaceId: createdWorkspaceId,
      })
      
      // === Decomposer logic ===
      
      // Set decomposition mode
      deps.loopsRepo.setDecompositionMode(ctx.projectId, uniqueLoopName, decomposerConfig.mode ?? 'agent')
      
      if (decomposerConfig.enabled === false) {
        deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'skipped')
        deps.loopsRepo.setTotalSections(ctx.projectId, uniqueLoopName, 0)
      } else if (isAgentDecomposer) {
        // Agent mode: decomposer session was already created earlier; just update metadata and prompt
        deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'running')
        
        deps.loopsRepo.setDecompositionSessionId(ctx.projectId, uniqueLoopName, sessionId)
        deps.loopsRepo.setCurrentSessionId(ctx.projectId, uniqueLoopName, sessionId)
        deps.loop.registerLoopSession(sessionId, uniqueLoopName)
        deps.loop.setPhase(uniqueLoopName, 'decomposing')
        
        // Wait for sandbox readiness in worktree+sandbox mode BEFORE prompting
        if (sandboxEnabledForLoop && deps.sandboxManager && deps.dataDir) {
          const dbPath = join(deps.dataDir, 'forge.db')
          if (existsSync(dbPath)) {
            const { waitForSandboxReady } = await import('../utils/sandbox-ready')
            const waitResult = await waitForSandboxReady({
              projectId: ctx.projectId,
              loopName: uniqueLoopName,
              dbPath,
              pollMs: 200,
              timeoutMs: 15_000,
            })
            if (!waitResult.ready) {
              deps.logger.error(`handleStartLoop: sandbox not ready (${waitResult.reason})`)
              try {
                const { createDockerService } = await import('../sandbox/docker')
                const docker = createDockerService(deps.logger as unknown as Console)
                const cn = docker.containerName(uniqueLoopName)
                if (await docker.isRunning(cn)) {
                  await docker.removeContainer(cn)
                }
              } catch (cleanupErr) {
                deps.logger.error('handleStartLoop: failed to remove sandbox container after timeout', cleanupErr)
              }
              await rollbackLoopStart()
              return fail('internal_error', 503, `Sandbox not ready: ${waitResult.reason}`)
            }
            deps.logger.log(`handleStartLoop: sandbox ready (${waitResult.containerName})`)
          }
        }

        const decomposerPrompt = deps.loop.buildDecomposerInitialPrompt(state)

        try {
          markPromptSent(uniqueLoopName, sessionId, deps.logger)
          const decomposerResult = await deps.v2.session.promptAsync({
            sessionID: sessionId,
            directory: state.worktreeDir,
            ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
            agent: 'decomposer',
            parts: [{ type: 'text' as const, text: decomposerPrompt }],
            ...(() => {
              const m = resolveDecomposerModel({
                decomposerModel: decomposerConfig.model,
                auditorModel: resolvedAuditorModel,
                executionModel: resolvedExecutionModel,
              })
              return m ? { model: m } : {}
            })(),
          })
          if ((decomposerResult as { error?: unknown })?.error) {
            clearPromptPending(uniqueLoopName, deps.logger)
            deps.logger.error('handleStartLoop: decomposer promptAsync returned error', (decomposerResult as { error?: unknown }).error)
            await rollbackLoopStart()
            return fail('prompt_failed', 502, 'Failed to prompt decomposer')
          }
        } catch (err) {
          clearPromptPending(uniqueLoopName, deps.logger)
          deps.logger.error('handleStartLoop: failed to prompt decomposer', err)
          await rollbackLoopStart()
          return fail('prompt_failed', 502, 'Failed to prompt decomposer')
        }
        // Start watchdog if requested
        if (command.lifecycle?.startWatchdog && deps.loopHandler) {
          deps.loopHandler.startWatchdog(uniqueLoopName)
        }

        return ok({
          operation: 'loop.start',
          mode: command.mode,
          sessionId,
          loopName: uniqueLoopName,
          displayName,
          executionName,
          worktreeDir: hostWorktreeDir,
          worktreeBranch,
          workspaceId: createdWorkspaceId,
          hostSessionId,
          modelUsed: null,
          maxIterations,
        })
      } else {
        // Deterministic mode
        deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'running')
        
        const sections = decomposeDeterministically(planText, { maxSections: decomposerConfig.maxSections ?? 12 })
        
        if (sections.length > 0 && deps.sectionPlansRepo) {
          deps.sectionPlansRepo.bulkInsert({
            projectId: ctx.projectId,
            loopName: uniqueLoopName,
            sections,
          })
          
          deps.loopsRepo.setTotalSections(ctx.projectId, uniqueLoopName, sections.length)
          deps.loopsRepo.setCurrentSectionIndex(ctx.projectId, uniqueLoopName, 0)
          deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'completed')
          
          deps.sectionPlansRepo.setStatus(ctx.projectId, uniqueLoopName, 0, 'in_progress')
          deps.sectionPlansRepo.setStartedAt(ctx.projectId, uniqueLoopName, 0, Date.now())
          
          const updatedState = {
            ...state,
            phase: 'coding' as const,
            decompositionStatus: 'completed' as const,
            currentSectionIndex: 0,
            totalSections: sections.length,
          }
          
          const sectionPrompt = deps.loop.buildSectionInitialPrompt(updatedState)
          
          // Wait for sandbox readiness in worktree+sandbox mode BEFORE prompting
          if (sandboxEnabledForLoop && deps.sandboxManager && deps.dataDir) {
            const dbPath = join(deps.dataDir, 'forge.db')
            if (existsSync(dbPath)) {
              const { waitForSandboxReady } = await import('../utils/sandbox-ready')
              const waitResult = await waitForSandboxReady({
                projectId: ctx.projectId,
                loopName: uniqueLoopName,
                dbPath,
                pollMs: 200,
                timeoutMs: 15_000,
              })
              if (!waitResult.ready) {
                deps.logger.error(`handleStartLoop: sandbox not ready (${waitResult.reason})`)
                try {
                  const { createDockerService } = await import('../sandbox/docker')
                  const docker = createDockerService(deps.logger as unknown as Console)
                  const cn = docker.containerName(uniqueLoopName)
                  if (await docker.isRunning(cn)) {
                    await docker.removeContainer(cn)
                  }
                } catch (cleanupErr) {
                  deps.logger.error('handleStartLoop: failed to remove sandbox container after timeout', cleanupErr)
                }
                await rollbackLoopStart()
                return fail('internal_error', 503, `Sandbox not ready: ${waitResult.reason}`)
              }
              deps.logger.log(`handleStartLoop: sandbox ready (${waitResult.containerName})`)
            }
          }

          // Send section-based prompt via the code session
          let sectionPromptResult: { result: SessionPromptResult; usedModel?: typeof loopModel }
          if (loopModel) {
            sectionPromptResult = await retryWithModelFallback(
              async () => {
                markPromptSent(uniqueLoopName, sessionId, deps.logger)
                const { result } = await promptSessionWithFallback(deps, {
                  sessionID: sessionId,
                  directory: state.worktreeDir,
                  parts: [{ type: 'text' as const, text: sectionPrompt }],
                  agent: 'code',
                  ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
                }, loopModel)
                return result
              },
              async () => {
                markPromptSent(uniqueLoopName, sessionId, deps.logger)
                const { result } = await promptSessionWithFallback(deps, {
                  sessionID: sessionId,
                  directory: state.worktreeDir,
                  parts: [{ type: 'text' as const, text: sectionPrompt }],
                  agent: 'code',
                  ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
                })
                return result
              },
              loopModel,
              deps.logger,
            )
          } else {
            markPromptSent(uniqueLoopName, sessionId, deps.logger)
            sectionPromptResult = await promptSessionWithFallback(deps, {
              sessionID: sessionId,
              directory: state.worktreeDir,
              parts: [{ type: 'text' as const, text: sectionPrompt }],
              agent: 'code',
              ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
            }, loopModel)
          }

          if (sectionPromptResult.result.error) {
            clearPromptPending(uniqueLoopName, deps.logger)
            deps.logger.error('handleStartLoop: failed to send section prompt', sectionPromptResult.result.error)
            await rollbackLoopStart()
            return fail('prompt_failed', 502, 'Failed to send section prompt')
          }
        } else {
          // No sections found: fallback per onParseFailure
          if (decomposerConfig.onParseFailure === 'agent') {
            // Fall back to agent decomposer mode — clean up the code session created for deterministic parsing
            if (createdSessionId) {
              await deps.v2.session.abort({ sessionID: createdSessionId }).catch(() => {})
              createdSessionId = null
            }
            deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'running')
            
            let decomposerSessionId: string
            let fallbackBoundWorkspaceId: string | undefined
            if (createdWorkspaceId) {
              const fallbackPermission = buildLoopPermissionRuleset({
                isSandbox: sandboxEnabledForLoop,
              })
              const createResult = await createLoopSessionWithWorkspace({
                v2: deps.v2,
                title: `decomposer-${uniqueLoopName}`,
                directory: state.worktreeDir,
                permission: fallbackPermission,
                workspaceId: createdWorkspaceId,
                logPrefix: 'handleStartLoop:decomposer-fallback',
                logger: deps.logger,
                legacyClient: deps.legacyClient,
              })
              if (!createResult) {
                deps.logger.error('handleStartLoop: failed to create decomposer session for fallback')
                await rollbackLoopStart()
                return fail('internal_error', 500, 'Failed to create decomposer session')
              }
              decomposerSessionId = createResult.sessionId
              fallbackBoundWorkspaceId = createResult.boundWorkspaceId
              if (createResult.bindFailed) {
                deps.logger.log(
                  `handleStartLoop: workspace ${createdWorkspaceId} created but salvage decomposer bind failed`,
                )
              }
            } else {
              const decomposerSessionResult = await createSessionWithFallback(deps, {
                title: `decomposer-${uniqueLoopName}`,
                directory: state.worktreeDir,
              })
              if (!decomposerSessionResult.data) {
                deps.logger.error('handleStartLoop: failed to create decomposer session for fallback')
                await rollbackLoopStart()
                return fail('internal_error', 500, 'Failed to create decomposer session')
              }
              decomposerSessionId = decomposerSessionResult.data.id
            }
            createdSessionId = decomposerSessionId
            
            deps.loopsRepo.setDecompositionSessionId(ctx.projectId, uniqueLoopName, decomposerSessionId)
            deps.loopsRepo.setCurrentSessionId(ctx.projectId, uniqueLoopName, decomposerSessionId)
            deps.loop.registerLoopSession(decomposerSessionId, uniqueLoopName)
            deps.loop.setPhase(uniqueLoopName, 'decomposing')

            // The original session was aborted above; navigate the TUI to the new decomposer
            // session. onStarted already fired with the original sessionId, so the caller's RPC
            // is already resolved.
            selectInitialWorktreeSession(decomposerSessionId, fallbackBoundWorkspaceId, 'after fallback decomposer start')

            const decomposerPrompt = deps.loop.buildDecomposerInitialPrompt(state)
            
            try {
              markPromptSent(uniqueLoopName, decomposerSessionId, deps.logger)
              const decomposerFallbackResult = await deps.v2.session.promptAsync({
                sessionID: decomposerSessionId,
                directory: state.worktreeDir,
                ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
                agent: 'decomposer',
                parts: [{ type: 'text' as const, text: decomposerPrompt }],
                ...(() => {
                  const m = resolveDecomposerModel({
                    decomposerModel: decomposerConfig.model,
                    auditorModel: resolvedAuditorModel,
                    executionModel: resolvedExecutionModel,
                  })
                  return m ? { model: m } : {}
                })(),
              })
              if ((decomposerFallbackResult as { error?: unknown })?.error) {
                clearPromptPending(uniqueLoopName, deps.logger)
                deps.logger.error('handleStartLoop: decomposer promptAsync returned error', (decomposerFallbackResult as { error?: unknown }).error)
                await rollbackLoopStart()
                return fail('prompt_failed', 502, 'Failed to prompt decomposer')
              }
            } catch (err) {
              clearPromptPending(uniqueLoopName, deps.logger)
              deps.logger.error('handleStartLoop: failed to prompt decomposer for fallback', err)
              await rollbackLoopStart()
              return fail('prompt_failed', 502, 'Failed to prompt decomposer')
            }
          } else {
            deps.loopsRepo.setDecompositionStatus(ctx.projectId, uniqueLoopName, 'skipped')
            deps.loopsRepo.setTotalSections(ctx.projectId, uniqueLoopName, 0)

            // Legacy fallback: prompt the code session with the plan text
            const legacyPrompt = planText ?? ''
            try {
              markPromptSent(uniqueLoopName, sessionId, deps.logger)
              const legacyResult = await promptSessionWithFallback(deps, {
                sessionID: sessionId,
                directory: state.worktreeDir,
                parts: [{ type: 'text' as const, text: legacyPrompt }],
                agent: 'code',
                ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
              }, loopModel)
              if ((legacyResult.result as { error?: unknown })?.error) {
                clearPromptPending(uniqueLoopName, deps.logger)
                deps.logger.error('handleStartLoop: legacy fallback promptAsync returned error', (legacyResult.result as { error?: unknown }).error)
                await rollbackLoopStart()
                return fail('prompt_failed', 502, 'Failed to send legacy fallback prompt')
              }
            } catch (err) {
              clearPromptPending(uniqueLoopName, deps.logger)
              deps.logger.error('handleStartLoop: failed to send legacy fallback prompt', err)
              await rollbackLoopStart()
              return fail('prompt_failed', 502, 'Failed to send legacy fallback prompt')
            }
          }
        }
        
        // Start watchdog if requested
        if (command.lifecycle?.startWatchdog && deps.loopHandler) {
          deps.loopHandler.startWatchdog(uniqueLoopName)
        }

        return ok({
          operation: 'loop.start',
          mode: command.mode,
          sessionId: createdSessionId,
          loopName: uniqueLoopName,
          displayName,
          executionName,
          worktreeDir: hostWorktreeDir,
          worktreeBranch,
          workspaceId: createdWorkspaceId,
          hostSessionId,
          modelUsed: null,
          maxIterations,
        })
      }
      
      // Wait for sandbox readiness in worktree+sandbox mode (after persistence)
      if (sandboxEnabledForLoop && deps.sandboxManager && deps.dataDir) {
        const dbPath = join(deps.dataDir, 'forge.db')
        if (existsSync(dbPath)) {
          const { waitForSandboxReady } = await import('../utils/sandbox-ready')
          const waitResult = await waitForSandboxReady({
            projectId: ctx.projectId,
            loopName: uniqueLoopName,
            dbPath,
            pollMs: 200,
            timeoutMs: 15_000,
          })
          
          if (!waitResult.ready) {
            deps.logger.error(`handleStartLoop: sandbox not ready (${waitResult.reason})`)
            // Best-effort: stop reconciled container
            try {
              const { createDockerService } = await import('../sandbox/docker')
              const docker = createDockerService(deps.logger as unknown as Console)
              const cn = docker.containerName(uniqueLoopName)
              if (await docker.isRunning(cn)) {
                await docker.removeContainer(cn)
              }
            } catch (cleanupErr) {
              deps.logger.error('handleStartLoop: failed to remove sandbox container after timeout', cleanupErr)
            }
            await rollbackLoopStart()
            return fail('internal_error', 503, `Sandbox not ready: ${waitResult.reason}`)
          }
          
          deps.logger.log(`handleStartLoop: sandbox ready (${waitResult.containerName})`)
        }
      }
      
      // Navigate TUI if requested with early timing
      if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming === 'after-create') {
        const selection = createdWorkspaceId
          ? { workspace: createdWorkspaceId, sessionID: sessionId }
          : { sessionID: sessionId }
        
        selectSessionWithFallback(deps, selection).catch((err: unknown) => {
          deps.logger.error('handleStartLoop: failed to navigate TUI (early)', err as Error)
        })
      }
      
      // Send initial prompt with fallback
      const sessionDir = state.worktreeDir
      const promptParts = [{ type: 'text' as const, text: planText }]
      const workspaceParam = createdWorkspaceId ? { workspace: createdWorkspaceId } : {}
      
      // For worktree mode with a configured model, use retryWithModelFallback
      let promptResult: { result: SessionPromptResult; usedModel?: typeof loopModel }
      let actualModel: typeof loopModel | null = null
      
      if (loopModel) {
        const retryResult = await retryWithModelFallback(
          async () => {
            markPromptSent(uniqueLoopName, sessionId, deps.logger)
            const { result } = await promptSessionWithFallback(
              deps,
              {
                sessionID: sessionId,
                directory: sessionDir,
                parts: promptParts,
                agent: 'code',
                ...workspaceParam,
              },
              loopModel,
            )
            return result
          },
          async () => {
            markPromptSent(uniqueLoopName, sessionId, deps.logger)
            const { result } = await promptSessionWithFallback(
              deps,
              {
                sessionID: sessionId,
                directory: sessionDir,
                parts: promptParts,
                agent: 'code',
                ...workspaceParam,
              },
              undefined,
            )
            return result
          },
          loopModel,
          deps.logger as unknown as Console,
        )
        promptResult = retryResult
        actualModel = retryResult.usedModel ?? null
      } else {
        markPromptSent(uniqueLoopName, sessionId, deps.logger)
        promptResult = await promptSessionWithFallback(
          deps,
          {
            sessionID: sessionId,
            directory: sessionDir,
            parts: promptParts,
            agent: 'code',
            ...workspaceParam,
          },
          loopModel,
        )
        actualModel = promptResult.usedModel ?? null
      }
      
      if (promptResult.result.error) {
        clearPromptPending(uniqueLoopName, deps.logger)
        deps.logger.error('handleStartLoop: failed to send prompt', promptResult.result.error)
        await rollbackLoopStart()
        
        return fail('prompt_failed', 502, 'Loop session created but failed to send prompt')
      }
      
      // Success: start watchdog if requested
      if (command.lifecycle?.startWatchdog && deps.loopHandler) {
        deps.loopHandler.startWatchdog(uniqueLoopName)
      }
      
      // Navigate TUI if requested with default/post-prompt timing
      if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming !== 'after-create') {
        const selection = createdWorkspaceId
          ? { workspace: createdWorkspaceId, sessionID: sessionId }
          : { sessionID: sessionId }
        
        selectSessionWithFallback(deps, selection).catch((err: unknown) => {
          deps.logger.error('handleStartLoop: failed to navigate TUI', err as Error)
        })
      }
      
      // Abort source session if requested
      if (command.lifecycle?.abortSourceSessionOnSuccess && ctx.sourceSessionId) {
        deps.v2.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
          deps.logger.error('handleStartLoop: failed to abort source session', err as Error)
        })
      }
      
      const modelUsed = actualModel && 'providerID' in actualModel
        ? `${actualModel.providerID}/${actualModel.modelID}`
        : null
      
      return ok({
        operation: 'loop.start',
        mode: command.mode,
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
        ? Array.from({ length: state.totalSections }, (_, i) => {
            const section = deps.loop.getSectionPlan(state, i)
            const digest = deps.loop.getCompletedSectionDigest(state)
            const summary = digest?.find(s => s.index === i)
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
        : undefined
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
        decompositionStatus: state.decompositionStatus,
        decompositionMode: state.decompositionMode,
        currentSectionIndex: state.currentSectionIndex,
        totalSections: state.totalSections,
        finalAuditDone: state.finalAuditDone,
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
    if (stoppedState.active && !command.force) {
      return fail('conflict', 409, `Loop "${stoppedState.loopName}" is currently active. Use force=true to force-restart a stuck loop.`)
    }
    if (stoppedState.terminationReason && parseTerminationReasonString(stoppedState.terminationReason).kind === 'completed') {
      return fail('conflict', 409, `Loop "${stoppedState.loopName}" completed successfully and cannot be restarted.`)
    }
    if (stoppedState.worktree && stoppedState.worktreeDir) {
      if (!existsSync(stoppedState.worktreeDir)) {
        return fail('conflict', 409, `Cannot restart "${stoppedState.loopName}": worktree directory no longer exists at ${stoppedState.worktreeDir}.`)
      }
    }

    const restartSandbox = isSandboxEnabled(deps.config, deps.sandboxManager)
    deps.logger.log(
      `handleRestartLoop: [perm-diag] worktree=${String(stoppedState.worktree)} sandbox=${String(restartSandbox)}`
    )
    const permissionRuleset = buildLoopPermissionRuleset({ isSandbox: restartSandbox })
    const previousState = { ...stoppedState }
    let restartedState: import('../loop/state').LoopState | null = null
    let bindFailed = false
    const previousSessionId = stoppedState.sessionId

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean; decomposerSessionId?: string }
      | { ok: false; error: string }

    const outcome = await deps.loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
      if (stoppedState.active) {
        const latestState = deps.loop.getActiveState(stoppedState.loopName)
        if (latestState?.active) {
          try { await deps.v2.session.abort({ sessionID: latestState.sessionId }) } catch {}
          deps.loopHandler!.clearLoopTimers(stoppedState.loopName)
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
            workspaceId: latestState.workspaceId,
            hostSessionId: latestState.hostSessionId,
            sandbox: latestState.sandbox,
          })
        }
      }

      // Determine if decomposition needs to be re-entered before creating sessions
      const needsDecomposerRestart =
        stoppedState.decompositionStatus === 'pending' ||
        stoppedState.decompositionStatus === 'running' ||
        stoppedState.decompositionStatus === 'failed'

      let newSessionId: string | undefined
      let decomposerSessionId: string | undefined

      if (restartSandbox && deps.sandboxManager) {
        try {
          const sbxResult = await deps.sandboxManager.start(stoppedState.loopName, stoppedState.worktreeDir)
          deps.logger.log(`loop-restart: started sandbox container ${sbxResult.containerName}`)
        } catch (err) {
          deps.logger.error('loop-restart: failed to start sandbox container', err)
          return { ok: false, error: 'Restart failed: could not start sandbox container.' }
        }
      }

      if (needsDecomposerRestart) {
        if (stoppedState.decompositionMode === 'deterministic') {
          // Deterministic mode: re-run deterministic parsing/fallback instead of creating an agent decomposer
          deps.logger.log(`loop-restart: re-entering deterministic decomposition (status=${stoppedState.decompositionStatus})`)
          
          const createResult = await createLoopSessionWithWorkspace({
            v2: deps.v2,
            title: formatLoopSessionTitle(stoppedState.loopName),
            directory: stoppedState.worktreeDir,
            permission: permissionRuleset,
            workspaceId: stoppedState.workspaceId,
            logPrefix: 'loop-restart',
            logger: deps.logger,
          })
          
          if (!createResult) return { ok: false, error: 'Failed to create new session for restart.' }
          
          newSessionId = createResult.sessionId
          if (createResult.bindFailed) {
            stoppedState.workspaceId = undefined
            bindFailed = true
          }
          
          const decomposerConfig = deps.config.decomposer ?? { enabled: true, mode: 'agent' as const, onParseFailure: 'legacy' as const, maxSections: 12 }
          const planText = stoppedState.prompt ?? ''
          const sections = decomposeDeterministically(planText, { maxSections: decomposerConfig.maxSections ?? 12 })
          
          if (sections.length > 0 && deps.sectionPlansRepo) {
            deps.sectionPlansRepo.bulkInsert({
              projectId: ctx.projectId,
              loopName: stoppedState.loopName,
              sections,
            })
            
            deps.loopsRepo.setTotalSections(ctx.projectId, stoppedState.loopName, sections.length)
            deps.loopsRepo.setCurrentSectionIndex(ctx.projectId, stoppedState.loopName, 0)
            deps.loopsRepo.setDecompositionStatus(ctx.projectId, stoppedState.loopName, 'completed')
            
            deps.sectionPlansRepo.setStatus(ctx.projectId, stoppedState.loopName, 0, 'in_progress')
            deps.sectionPlansRepo.setStartedAt(ctx.projectId, stoppedState.loopName, 0, Date.now())
            
            deps.loop.registerLoopSession(newSessionId, stoppedState.loopName)
            deps.loopsRepo.setDecompositionSessionId(ctx.projectId, stoppedState.loopName, newSessionId)
            deps.loopsRepo.setCurrentSessionId(ctx.projectId, stoppedState.loopName, newSessionId)
            
            // Update in-memory state so downstream prompt logic sees correct values
            stoppedState.decompositionStatus = 'completed'
            stoppedState.currentSectionIndex = 0
            stoppedState.totalSections = sections.length
            
            // Prompt will be sent later using section prompt
          } else {
            // No sections: fallback per onParseFailure
            if (decomposerConfig.onParseFailure === 'agent') {
              let didBindFail = false
              if (stoppedState.worktree && stoppedState.workspaceId) {
                const restartPermission = buildLoopPermissionRuleset({
                  isSandbox: restartSandbox,
                })
                const createResult = await createLoopSessionWithWorkspace({
                  v2: deps.v2,
                  title: `decomposer-${stoppedState.loopName}`,
                  directory: stoppedState.worktreeDir,
                  permission: restartPermission,
                  workspaceId: stoppedState.workspaceId,
                  logPrefix: 'loop-restart:decomposer-fallback',
                  logger: deps.logger,
                })
                if (!createResult) return { ok: false, error: 'Failed to create decomposer session for fallback.' }
                decomposerSessionId = createResult.sessionId
                if (createResult.bindFailed) {
                  stoppedState.workspaceId = undefined
                  didBindFail = true
                }
              } else {
                const decomposerResult = await createSessionWithFallback(deps, {
                  title: `decomposer-${stoppedState.loopName}`,
                  directory: stoppedState.worktreeDir,
                })
                if (!decomposerResult.data) {
                  return { ok: false, error: 'Failed to create decomposer session for fallback.' }
                }
                decomposerSessionId = decomposerResult.data.id
              }
              deps.loop.registerLoopSession(decomposerSessionId, stoppedState.loopName)
              deps.loopsRepo.setDecompositionStatus(ctx.projectId, stoppedState.loopName, 'running')
              deps.loopsRepo.setDecompositionSessionId(ctx.projectId, stoppedState.loopName, decomposerSessionId)
              deps.loopsRepo.setCurrentSessionId(ctx.projectId, stoppedState.loopName, decomposerSessionId)
              if (didBindFail) bindFailed = true
            } else {
              deps.loopsRepo.setDecompositionStatus(ctx.projectId, stoppedState.loopName, 'skipped')
              deps.loopsRepo.setTotalSections(ctx.projectId, stoppedState.loopName, 0)

              // Update in-memory state so downstream prompt logic sees correct values
              stoppedState.decompositionStatus = 'skipped'
              stoppedState.totalSections = 0
            }
          }
        } else {
          // Agent mode: re-create decomposer session
          deps.logger.log(`loop-restart: re-entering decomposition (status=${stoppedState.decompositionStatus})`)
          
          if (stoppedState.worktree && stoppedState.workspaceId) {
            const restartPermission = buildLoopPermissionRuleset({
              isSandbox: restartSandbox,
            })
            const createResult = await createLoopSessionWithWorkspace({
              v2: deps.v2,
              title: `decomposer-${stoppedState.loopName}`,
              directory: stoppedState.worktreeDir,
              permission: restartPermission,
              workspaceId: stoppedState.workspaceId,
              logPrefix: 'loop-restart:decomposer',
              logger: deps.logger,
            })
            if (!createResult) {
              deps.logger.error('loop-restart: failed to create decomposer session')
              return { ok: false, error: 'Failed to create decomposer session for restart.' }
            }
            decomposerSessionId = createResult.sessionId
            if (createResult.bindFailed) {
              stoppedState.workspaceId = undefined
              bindFailed = true
            }
          } else {
            const decomposerResult = await createSessionWithFallback(deps, {
              title: `decomposer-${stoppedState.loopName}`,
              directory: stoppedState.worktreeDir,
            })
            if (!decomposerResult.data) {
              deps.logger.error('loop-restart: failed to create decomposer session')
              return { ok: false, error: 'Failed to create decomposer session for restart.' }
            }
            decomposerSessionId = decomposerResult.data.id
          }
          deps.loop.registerLoopSession(decomposerSessionId, stoppedState.loopName)
          deps.loopsRepo.setDecompositionStatus(ctx.projectId, stoppedState.loopName, 'running')
          deps.loopsRepo.setDecompositionSessionId(ctx.projectId, stoppedState.loopName, decomposerSessionId)
          deps.loopsRepo.setCurrentSessionId(ctx.projectId, stoppedState.loopName, decomposerSessionId)
        }
      } else {
        const createResult = await createLoopSessionWithWorkspace({
          v2: deps.v2,
          title: formatLoopSessionTitle(stoppedState.loopName),
          directory: stoppedState.worktreeDir,
          permission: permissionRuleset,
          workspaceId: stoppedState.workspaceId,
          logPrefix: 'loop-restart',
          logger: deps.logger,
        })

        if (!createResult) return { ok: false, error: 'Failed to create new session for restart.' }

        newSessionId = createResult.sessionId
        if (createResult.bindFailed) {
          stoppedState.workspaceId = undefined
          bindFailed = true
        }
      }

      // Recompute effective decomposer restart flag after deterministic handling
      const effectiveNeedsDecomposerRestart = needsDecomposerRestart && stoppedState.decompositionStatus !== 'completed'
      const restartPhase = effectiveNeedsDecomposerRestart ? 'decomposing' as const : stoppedState.phase === 'final_auditing' ? 'final_auditing' as const : 'coding' as const
      const effectiveSessionId = decomposerSessionId || newSessionId!

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
        worktree: stoppedState.worktree,
        sandbox: restartSandbox,
        sandboxContainer: restartSandbox ? deps.sandboxManager?.docker.containerName(stoppedState.loopName) : undefined,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
        workspaceId: stoppedState.workspaceId,
        hostSessionId: stoppedState.hostSessionId,
        decompositionStatus: effectiveNeedsDecomposerRestart ? 'running' as const : stoppedState.decompositionStatus,
        decompositionMode: stoppedState.decompositionMode,
        decompositionSessionId: decomposerSessionId || stoppedState.decompositionSessionId,
        currentSectionIndex: stoppedState.currentSectionIndex,
        totalSections: stoppedState.totalSections,
        finalAuditDone: stoppedState.finalAuditDone,
      }
      restartedState = newState
      return { ok: true, newSessionId: effectiveSessionId, previousSessionId, sandbox: restartSandbox, bindFailed, decomposerSessionId }
    })

    if (!outcome.ok) return fail('internal_error', 500, outcome.error)

    if (outcome.bindFailed) {
      publishWorkspaceDetachedToast({
        v2: deps.v2,
        directory: stoppedState.projectDir ?? stoppedState.worktreeDir,
        loopName: stoppedState.loopName,
        logger: deps.logger,
        context: 'on restart',
      })
    }

    // Build appropriate prompt based on persisted decomposition state
    let promptText: string
    const needsDecomposerRestart =
      stoppedState.decompositionStatus === 'pending' ||
      stoppedState.decompositionStatus === 'running' ||
      stoppedState.decompositionStatus === 'failed'

    if (needsDecomposerRestart) {
      // Re-enter decomposition: prompt the decomposer session
      promptText = deps.loop.buildDecomposerInitialPrompt(stoppedState)
    } else if (stoppedState.totalSections > 0 && stoppedState.decompositionStatus === 'completed') {
      // Use persisted section state to build the correct section prompt
      if (stoppedState.phase === 'final_auditing') {
        promptText = deps.loop.buildFinalAuditPrompt(stoppedState)
      } else {
        promptText = deps.loop.buildSectionInitialPrompt(stoppedState)
      }
    } else {
      // Legacy non-sectioned prompt
      promptText = stoppedState.prompt ?? ''
    }

    const loopModel = needsDecomposerRestart
      ? resolveDecomposerModel({
          decomposerModel: deps.config.decomposer?.model,
          auditorModel: stoppedState.auditorModel ?? deps.config.auditorModel,
          executionModel: stoppedState.executionModel ?? deps.config.executionModel,
        })
      : parseModelString(stoppedState.executionModel) ?? parseModelString(deps.config.executionModel)
    const workspaceParam = stoppedState.workspaceId ? { workspace: stoppedState.workspaceId } : {}

    const promptAgent = needsDecomposerRestart ? 'decomposer' : stoppedState.phase === 'final_auditing' ? 'auditor-loop' : 'code'

    const { result: promptResult } = await retryWithModelFallback(
      () => {
        markPromptSent(stoppedState.loopName, outcome.newSessionId, deps.logger)
        return deps.v2.session.promptAsync({
          sessionID: outcome.newSessionId,
          directory: stoppedState.worktreeDir,
          parts: [{ type: 'text' as const, text: promptText }],
          agent: promptAgent,
          model: loopModel!,
          ...workspaceParam,
        })
      },
      () => {
        markPromptSent(stoppedState.loopName, outcome.newSessionId, deps.logger)
        return deps.v2.session.promptAsync({
          sessionID: outcome.newSessionId,
          directory: stoppedState.worktreeDir,
          parts: [{ type: 'text' as const, text: promptText }],
          agent: promptAgent,
          ...workspaceParam,
        })
      },
      loopModel,
      deps.logger,
    )

    if (promptResult.error) {
      clearPromptPending(stoppedState.loopName, deps.logger)
      deps.logger.error('loop-restart: failed to send prompt', promptResult.error)
      // Save section plans before deleteState (which cascades to section_plans)
      const savedPlans = deps.sectionPlansRepo?.list(ctx.projectId, stoppedState.loopName) ?? []
      deps.loop.deleteState(stoppedState.loopName)
      try {
        deps.loop.setState(previousState.loopName, previousState)
        if (previousState.active) deps.loop.registerLoopSession(previousState.sessionId, previousState.loopName)
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
      return fail('internal_error', 500, 'Restart failed: could not send prompt to new session.')
    }
    deps.loopsRepo.restart(ctx.projectId, stoppedState.loopName, {
      sessionId: restartedState!.sessionId,
      phase: restartedState!.phase,
      iteration: restartedState!.iteration,
      auditCount: restartedState!.auditCount,
      sandbox: restartedState!.sandbox ?? false,
      sandboxContainer: restartedState!.sandboxContainer ?? null,
      workspaceId: restartedState!.workspaceId ?? null,
      decompositionStatus: restartedState!.decompositionStatus,
      decompositionSessionId: restartedState!.decompositionSessionId ?? null,
      currentSectionIndex: restartedState!.currentSectionIndex,
      totalSections: restartedState!.totalSections,
      finalAuditDone: restartedState!.finalAuditDone,
      startedAt: new Date(restartedState!.startedAt).getTime(),
    })
    deps.loop.registerLoopSession(outcome.newSessionId, stoppedState.loopName)

    deps.loopHandler.startWatchdog(stoppedState.loopName)

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
