/**
 * Forge Execution Service - Command Bus Interface
 * 
 * Shared execution service for plan execution and loop lifecycle.
 * Provides a unified interface for internal tools, API/TUI, and CLI.
 */

import type { PluginConfig, Logger } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ToolContext } from '../tools/types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { LoopService } from '../services/loop'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import { extractPlanTitle, extractLoopNames } from '../utils/plan-execution'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { generateUniqueName } from '../services/loop'
import { resolveCurrentGitBranch } from '../utils/git-branch'
import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { findPartialMatch } from '../utils/partial-match'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { existsSync } from 'fs'

// ============================================================================
// Surface Types - Identifies the caller boundary
// ============================================================================

export type ForgeExecutionSurface = 'tool' | 'approval-hook' | 'api' | 'tui' | 'cli'

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
}

export interface LoopRestartedResult {
  operation: 'loop.restart'
  loopName: string
  sessionId: string
  previousSessionId: string
  previousTermination?: string
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
  legacyClient?: ToolContext['input']['client']
  plansRepo: PlansRepo
  loopsRepo: LoopsRepo
  loopService?: LoopService
  loopHandler?: ReturnType<typeof createLoopEventHandler>
  sandboxManager?: SandboxManager | null
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
      // Try loopService first if available
      if (deps.loopService) {
        const planText = deps.loopService.getPlanText(source.loopName, ctx.sourceSessionId ?? '')
        if (planText) {
          return { ok: true, planText }
        }
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
// Fallback Helpers for Legacy Plugin Client
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
}

interface SessionPromptResult {
  data?: unknown
  error?: unknown
}

async function createSessionWithFallback(
  deps: ForgeExecutionServiceDeps,
  input: SessionCreateInput,
): Promise<SessionCreateResult> {
  // Try v2 client first
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
        deps.logger.log('createSessionWithFallback: v2 client unavailable, falling back to legacy client')
      } else {
        deps.logger.error('createSessionWithFallback: v2 client error', result.error)
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('createSessionWithFallback: v2 client threw connection error, falling back to legacy client')
    } else {
      deps.logger.error('createSessionWithFallback: v2 client threw error', err)
    }
  }
  
  // Fallback to legacy client
  if (!deps.legacyClient) {
    deps.logger.error('createSessionWithFallback: no legacy client available')
    return { error: new Error('No legacy client available') }
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
    
    return { error: new Error('Legacy client returned no session ID') }
  } catch (err) {
    deps.logger.error('createSessionWithFallback: legacy client failed', err)
    return { error: err }
  }
}

async function promptSessionWithFallback(
  deps: ForgeExecutionServiceDeps,
  input: SessionPromptInput,
  model?: { providerID: string; modelID: string },
): Promise<{ result: SessionPromptResult; usedModel?: typeof model }> {
  // Try v2 client first
  try {
    const result = await deps.v2.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.directory,
      parts: input.parts,
      agent: input.agent,
      ...(model ? { model } : {}),
    })
    
    if (!result.error) {
      return { result: { data: result.data }, usedModel: model }
    }
    
    const errorMsg = result.error instanceof Error ? result.error.message : String(result.error)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('promptSessionWithFallback: v2 client unavailable, falling back to legacy client')
    } else {
      deps.logger.error('promptSessionWithFallback: v2 client error', result.error)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('promptSessionWithFallback: v2 client threw connection error, falling back to legacy client')
    } else {
      deps.logger.error('promptSessionWithFallback: v2 client threw error', err)
    }
  }
  
  // Fallback to legacy client
  if (!deps.legacyClient) {
    deps.logger.error('promptSessionWithFallback: no legacy client available')
    return { result: { error: new Error('No legacy client available') }, usedModel: model }
  }
  
  try {
    const legacyResult = await deps.legacyClient.session.promptAsync({
      path: { id: input.sessionID },
      query: {
        directory: input.directory,
      },
      body: {
        agent: input.agent,
        parts: input.parts,
        ...(model ? { model } : {}),
      },
    } as Parameters<typeof deps.legacyClient.session.promptAsync>[0])
    
    // Legacy client returns { data, request, response }
    const legacyData = legacyResult as { data?: unknown }
    if (!legacyData.data) {
      return { result: { error: new Error('Legacy client returned no data') }, usedModel: model }
    }
    
    return { result: { data: legacyData.data }, usedModel: model }
  } catch (err) {
    deps.logger.error('promptSessionWithFallback: legacy client failed', err)
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
      await deps.v2.tui.selectSession(selection)
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
        ...(selection.workspace ? { workspace: selection.workspace } : {}),
        body: {
          type: 'tui.session.select',
          properties: {
            sessionID: selection.sessionID,
          },
        },
      })
      return
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('selectSessionWithFallback: v2 TUI publish unavailable, falling back to legacy client')
    } else {
      deps.logger.error('selectSessionWithFallback: v2 TUI publish error', err)
    }
  }
  
  // Fallback to legacy client TUI
  if (!deps.legacyClient?.tui) {
    deps.logger.error('selectSessionWithFallback: no legacy TUI available')
    return
  }
  
  try {
    // Fallback to publish with tui.session.select event
    await deps.legacyClient.tui.publish({
      ...(selection.workspace ? { workspace: selection.workspace } : {}),
      body: {
        type: 'tui.session.select',
        properties: {
          sessionID: selection.sessionID,
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
    const title = command.title ?? extractPlanTitle(planText)
    const sessionTitle = formatLoopSessionTitle(title)
    
    // Extract loop names
    const { displayName, executionName } = extractLoopNames(planText)
    
    // Generate unique loop name
    let uniqueLoopName: string
    if (deps.loopService) {
      uniqueLoopName = deps.loopService.generateUniqueLoopName(command.loopName ?? executionName)
    } else {
      // Fallback to loopsRepo-based uniqueness
      const existingNames = deps.loopsRepo.listByStatus(ctx.projectId, ['running', 'completed', 'cancelled', 'errored', 'stalled'])
        .map(row => row.loopName)
      uniqueLoopName = generateUniqueName(command.loopName ?? executionName, existingNames)
    }
    
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
        deps.loopService!.deleteState(uniqueLoopName)
        loopStatePersisted = false
      }
      if ((sandboxStarted || sandboxStartAttempted) && deps.sandboxManager) {
        await deps.sandboxManager.stop(uniqueLoopName).catch(() => {})
        sandboxStarted = false
        sandboxContainer = null
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
      let workspaceId: string | undefined
      
      // Compute host session ID for metadata persistence only (not session parenting)
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId
      
      if (command.mode === 'worktree') {
        // Create worktree
        const worktreeResult = await deps.v2.worktree.create({
          worktreeCreateInput: { name: uniqueLoopName },
        })
        
        if (worktreeResult.error || !worktreeResult.data) {
          deps.logger.error('handleStartLoop: failed to create worktree', worktreeResult.error)
          return fail('internal_error', 500, 'Failed to create worktree')
        }
        
        hostWorktreeDir = worktreeResult.data.directory!
        worktreeBranch = worktreeResult.data.branch ?? undefined
        
        // Create workspace
        const { createLoopWorkspace } = await import('../workspace/forge-worktree')
        const workspace = await createLoopWorkspace(deps.v2, {
          loopName: uniqueLoopName,
          directory: hostWorktreeDir!,
          branch: worktreeBranch,
        }, deps.logger)
        
        if (workspace) {
          deps.logger.log(`handleStartLoop: workspace ${workspace.workspaceId} created for ${uniqueLoopName}`)
          workspaceId = workspace.workspaceId
        }
        
        // Build permissions
        const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager)
        sandboxEnabledForLoop = sandboxEnabled
        
        const permissionRuleset = buildLoopPermissionRuleset({
          isWorktree: true,
          isSandbox: sandboxEnabled,
        })
        
        // Create session
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
        createdWorkspaceId = createResult.boundWorkspaceId
        
        if (createResult.bindFailed) {
          deps.logger.log('handleStartLoop: continuing without workspace backing')
        }
        
        // Start sandbox if enabled
        if (sandboxEnabled && deps.sandboxManager) {
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
        
      } else {
        // In-place mode
        worktreeBranch = resolveCurrentGitBranch(ctx.directory)
        const permissionRuleset = buildLoopPermissionRuleset({
          isWorktree: false,
        })
        
        const createResult = await createSessionWithFallback(deps, {
          title: sessionTitle,
          directory: ctx.directory,
          permission: permissionRuleset,
        })
        
        if (!createResult.data) {
          deps.logger.error('handleStartLoop: failed to create session', createResult.error)
          return fail('internal_error', 500, 'Failed to create loop session')
        }
        
        sessionId = createResult.data.id
        createdSessionId = sessionId
      }
      
      // Persist loop state
      const state: import('../services/loop').LoopState = {
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
        worktree: command.mode === 'worktree',
        sandbox: sandboxEnabledForLoop,
        sandboxContainer: sandboxContainer ?? undefined,
        executionModel: resolvedExecutionModel,
        auditorModel: resolvedAuditorModel,
        workspaceId: createdWorkspaceId,
        hostSessionId,
      }
      
      deps.loopService!.setState(uniqueLoopName, state)
      loopStatePersisted = true
      deps.loopService!.registerLoopSession(sessionId, uniqueLoopName)
      
      deps.logger.log(`handleStartLoop: state stored for loop=${uniqueLoopName}`)
      
      // Emit early event for TUI to resolve RPC without waiting for full loop start
      command.lifecycle?.onStarted?.({
        mode: command.mode,
        sessionId,
        loopName: uniqueLoopName,
        displayName,
        worktreeDir: hostWorktreeDir,
        workspaceId: createdWorkspaceId,
      })
      
      // Wait for sandbox readiness in worktree+sandbox mode (after persistence)
      if (command.mode === 'worktree' && sandboxEnabledForLoop && deps.sandboxManager && deps.dataDir) {
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
      
      if (command.mode === 'worktree' && loopModel) {
        const retryResult = await retryWithModelFallback(
          async () => {
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
  
  async function handleLoopStatus(
    ctx: ForgeExecutionRequestContext,
    command: GetLoopStatusCommand,
  ): Promise<ForgeExecutionResponse<LoopStatusResult>> {
    let states: import('../services/loop').LoopState[]
    
    if (deps.loopService) {
      if (command.selector?.kind === 'only-active') {
        states = deps.loopService.listActive()
      } else {
        const active = deps.loopService.listActive()
        const recent = deps.loopService.listRecent()
        states = [...active, ...recent]
      }
    } else {
      // CLI adapter: read from DB
      const rows = deps.loopsRepo.listByStatus(ctx.projectId, ['running', 'completed', 'cancelled', 'errored', 'stalled'])
      states = rows.map(row => {
        const large = deps.loopsRepo.getLarge(ctx.projectId, row.loopName)
        return rowToLoopState(row, large, deps)
      })
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
    
    const statusFromState = (state: import('../services/loop').LoopState): LoopStatusView['status'] => {
      if (state.active) return 'running'
      if (state.terminationReason === 'completed') return 'completed'
      if (state.terminationReason === 'cancelled' || state.terminationReason === 'user_aborted' || state.terminationReason === 'shutdown') return 'cancelled'
      if (state.terminationReason === 'max_iterations' || state.terminationReason === 'stall_timeout') return 'stalled'
      if (state.terminationReason) return 'errored'
      return 'completed'
    }

    // Convert to status views
    const loops: LoopStatusView[] = states.map(state => ({
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
    }))
    
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
    if (!deps.loopService || !deps.loopHandler) {
      return fail('internal_error', 500, 'Loop service not available')
    }

    let state: import('../services/loop').LoopState

    // Resolve loop by selector
    if (!command.selector || command.selector.kind === 'only-active') {
      const active = deps.loopService.listActive()
      if (active.length === 0) return fail('not_found', 404, 'No active loops.')
      if (active.length !== 1) {
        return fail('conflict', 409, 'Multiple active loops. Specify a name.', undefined, active.map(s => s.loopName))
      }
      state = active[0]
    } else {
      const name = command.selector.name
      const { match, candidates } = deps.loopService.findMatchByName(name)
      if (!match) {
        if (candidates.length > 0) {
          return fail('conflict', 409, `Multiple loops match "${name}". Be more specific.`, undefined, candidates.map(s => s.loopName))
        }
        const recent = deps.loopService.listRecent()
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
    _ctx: ForgeExecutionRequestContext,
    command: RestartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopRestartedResult>> {
    if (!deps.loopService || !deps.loopHandler) {
      return fail('internal_error', 500, 'Loop service not available')
    }

    if (command.selector.kind === 'only-active') {
      return fail('bad_request', 400, 'Specify a loop name to restart. Use loop-status to see available loops.')
    }

    const name = command.selector.name
    const active = deps.loopService.listActive()
    const recent = deps.loopService.listRecent()
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
    if (stoppedState.terminationReason === 'completed') {
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
    const permissionRuleset = buildLoopPermissionRuleset({ isWorktree: !!stoppedState.worktree, isSandbox: restartSandbox })
    const previousTermination = stoppedState.terminationReason
    const previousState = { ...stoppedState }
    let restartedState: import('../services/loop').LoopState | null = null
    let bindFailed = false

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean }
      | { ok: false; error: string }

    const outcome = await deps.loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
      if (stoppedState.active) {
        const latestState = deps.loopService!.getActiveState(stoppedState.loopName)
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

      const previousSessionId = stoppedState.sessionId

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

      const newSessionId = createResult.sessionId
      if (createResult.bindFailed) {
        stoppedState.workspaceId = undefined
        bindFailed = true
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

      const newState: import('../services/loop').LoopState = {
        active: true,
        sessionId: newSessionId,
        loopName: stoppedState.loopName,
        worktreeDir: stoppedState.worktreeDir,
        projectDir: stoppedState.projectDir || stoppedState.worktreeDir,
        worktreeBranch: stoppedState.worktreeBranch,
        iteration: stoppedState.iteration,
        maxIterations: stoppedState.maxIterations,
        startedAt: new Date().toISOString(),
        prompt: stoppedState.prompt,
        phase: 'coding',
        errorCount: 0,
        auditCount: 0,
        worktree: stoppedState.worktree,
        sandbox: restartSandbox,
        sandboxContainer: restartSandbox ? deps.sandboxManager?.docker.containerName(stoppedState.loopName) : undefined,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
        workspaceId: stoppedState.workspaceId,
        hostSessionId: stoppedState.hostSessionId,
      }
      restartedState = newState
      return { ok: true, newSessionId, previousSessionId, sandbox: restartSandbox, bindFailed }
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

    const promptText = stoppedState.prompt ?? ''
    const loopModel = parseModelString(stoppedState.executionModel) ?? parseModelString(deps.config.executionModel)
    const workspaceParam = stoppedState.workspaceId ? { workspace: stoppedState.workspaceId } : {}

    const { result: promptResult } = await retryWithModelFallback(
      () => deps.v2.session.promptAsync({
        sessionID: outcome.newSessionId,
        directory: stoppedState.worktreeDir,
        parts: [{ type: 'text' as const, text: promptText }],
        agent: 'code',
        model: loopModel!,
        ...workspaceParam,
      }),
      () => deps.v2.session.promptAsync({
        sessionID: outcome.newSessionId,
        directory: stoppedState.worktreeDir,
        parts: [{ type: 'text' as const, text: promptText }],
        agent: 'code',
        ...workspaceParam,
      }),
      loopModel,
      deps.logger,
    )

    if (promptResult.error) {
      deps.logger.error('loop-restart: failed to send prompt', promptResult.error)
      deps.loopService.deleteState(stoppedState.loopName)
      try {
        deps.loopService.setState(previousState.loopName, previousState)
        if (previousState.active) deps.loopService.registerLoopSession(previousState.sessionId, previousState.loopName)
      } catch (restoreErr) {
        deps.logger.error('loop-restart: failed to restore previous loop state', restoreErr)
      }
      if (restartSandbox && deps.sandboxManager) {
        await deps.sandboxManager.stop(stoppedState.loopName).catch(() => {})
      }
      return fail('internal_error', 500, 'Restart failed: could not send prompt to new session.')
    }

    deps.loopService.deleteState(stoppedState.loopName)
    deps.loopService.setState(stoppedState.loopName, restartedState!)
    deps.loopService.registerLoopSession(outcome.newSessionId, stoppedState.loopName)
    deps.loopHandler.startWatchdog(stoppedState.loopName)

    return ok({
      operation: 'loop.restart',
      loopName: stoppedState.loopName,
      sessionId: outcome.newSessionId,
      previousSessionId: outcome.previousSessionId,
      previousTermination,
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

import { join } from 'path'

function rowToLoopState(
  row: import('../storage/repos/loops-repo').LoopRow,
  large: import('../storage/repos/loops-repo').LoopLargeFields | null,
  _deps: unknown,
): import('../services/loop').LoopState {
  return {
    active: row.status === 'running',
    sessionId: row.currentSessionId,
    loopName: row.loopName,
    worktreeDir: row.worktreeDir,
    projectDir: row.projectDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    startedAt: new Date(row.startedAt).toISOString(),
    prompt: large?.prompt ?? undefined,
    phase: row.phase,
    lastAuditResult: large?.lastAuditResult ?? undefined,
    errorCount: row.errorCount,
    auditCount: row.auditCount,
    terminationReason: row.terminationReason ?? undefined,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    worktree: row.worktree,
    modelFailed: row.modelFailed,
    sandbox: row.sandbox,
    sandboxContainer: row.sandboxContainer ?? undefined,
    completionSummary: row.completionSummary ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
  }
}
