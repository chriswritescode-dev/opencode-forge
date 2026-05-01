/**
 * Forge Execution Service - Command Bus Interface
 * 
 * Shared execution service for plan execution and loop lifecycle.
 * Provides a unified interface for internal tools, API/TUI, and CLI.
 */

import type { PluginConfig, Logger } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { GraphStatusRepo } from '../storage/repos/graph-status-repo'
import type { LoopService } from '../services/loop'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import { extractPlanTitle, extractLoopNames } from '../utils/plan-execution'
import { parseModelString } from '../utils/model-fallback'
import { generateUniqueName } from '../services/loop'

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
    abortSourceSession?: boolean
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
    startWatchdog?: boolean
    abortSourceSessionOnSuccess?: boolean
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
  plansRepo: PlansRepo
  loopsRepo: LoopsRepo
  graphStatusRepo?: GraphStatusRepo
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
    const truncatedTitle = title.length > 60 ? `${title.substring(0, 57)}...` : title
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    
    // Create new session
    const createResult = await deps.v2.session.create({
      title: truncatedTitle,
      directory: ctx.directory,
    })
    
    if (createResult.error || !createResult.data) {
      deps.logger.error('handlePlanNewSession: failed to create session', createResult.error)
      return fail('internal_error', 500, 'Failed to create session')
    }
    
    const sessionId = createResult.data.id
    deps.logger.log(`handlePlanNewSession: created session=${sessionId}`)
    
    // Prompt code agent
    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
      () => deps.v2.session.promptAsync({
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: planText }],
        agent: 'code',
        model: parsedModel!,
      }),
      () => deps.v2.session.promptAsync({
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: planText }],
        agent: 'code',
      }),
      parsedModel,
      deps.logger,
    )
    
    if (promptResult.error) {
      deps.logger.error('handlePlanNewSession: failed to prompt session', promptResult.error)
      return fail('prompt_failed', 502, 'Session created but failed to send plan')
    }
    
    // Navigate TUI if requested
    if (command.lifecycle?.selectSession && deps.v2.tui) {
      deps.v2.tui.selectSession({ sessionID: sessionId }).catch((err: unknown) => {
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
      title: truncatedTitle,
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
    
    // Prompt code agent in target session
    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
      () => deps.v2.session.promptAsync({
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        agent: 'code',
        parts: [{ type: 'text' as const, text: inPlacePrompt }],
        ...(parsedModel ? { model: parsedModel } : {}),
      }),
      () => deps.v2.session.promptAsync({
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        agent: 'code',
        parts: [{ type: 'text' as const, text: inPlacePrompt }],
      }),
      parsedModel,
      deps.logger,
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
    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    const title = command.title ?? extractPlanTitle(planText)
    const truncatedTitle = title.length > 60 ? `${title.substring(0, 57)}...` : title
    
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
        if (deps.loopService) {
          deps.loopService.deleteState(uniqueLoopName)
        } else {
          deps.loopsRepo.delete(ctx.projectId, uniqueLoopName)
        }
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
          projectId: ctx.projectId,
          dataDir: deps.dataDir,
          logPrefix: 'handleStartLoop',
          logger: deps.logger,
        })
      }
    }
    
    try {
      let sessionId: string
      let workspaceId: string | undefined
      
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
        
        void (async () => {
          try {
            const { seedWorktreeGraphScope } = await import('../utils/worktree-graph-seed')
            const seedResult = await seedWorktreeGraphScope({
              projectId: ctx.projectId,
              sourceCwd: ctx.directory,
              targetCwd: hostWorktreeDir!,
              dataDir: deps.dataDir,
              graphStatusRepo: deps.graphStatusRepo,
              logger: deps.logger,
            })
            deps.logger.log(`handleStartLoop: graph seed ${seedResult.seeded ? 'reused' : 'skipped'} (${seedResult.reason})`)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            deps.logger.log(`handleStartLoop: graph seed error (non-fatal): ${reason}`)
          }
        })()
        
        // Create workspace
        const { createLoopWorkspace } = await import('../workspace/forge-worktree')
        const workspace = await createLoopWorkspace(deps.v2, {
          loopName: uniqueLoopName,
          directory: hostWorktreeDir!,
          branch: worktreeBranch,
        })
        
        if (workspace) {
          deps.logger.log(`handleStartLoop: workspace ${workspace.workspaceId} created for ${uniqueLoopName}`)
          workspaceId = workspace.workspaceId
        }
        
        // Build permissions
        const { buildLoopPermissionRuleset } = await import('../constants/loop')
        const { isSandboxEnabled } = await import('../sandbox/context')
        const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager)
        sandboxEnabledForLoop = sandboxEnabled
        
        const permissionRuleset = buildLoopPermissionRuleset({
          isWorktree: true,
          isSandbox: sandboxEnabled,
        })
        
        // Create session
        const { createLoopSessionWithWorkspace } = await import('../utils/loop-session')
        const createResult = await createLoopSessionWithWorkspace({
          v2: deps.v2,
          title: `Loop: ${truncatedTitle}`,
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
        const createResult = await deps.v2.session.create({
          title: `Loop: ${truncatedTitle}`,
          directory: ctx.directory,
        })
        
        if (createResult.error || !createResult.data) {
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
        hostSessionId: command.hostSessionId,
      }
      
      if (deps.loopService) {
        deps.loopService.setState(uniqueLoopName, state)
        loopStatePersisted = true
        deps.loopService.registerLoopSession(sessionId, uniqueLoopName)
      } else {
        // CLI adapter: use loopsRepo directly
        const row: import('../storage/repos/loops-repo').LoopRow = {
          projectId: ctx.projectId,
          loopName: uniqueLoopName,
          status: 'running',
          currentSessionId: sessionId,
          auditSessionId: null,
          worktree: command.mode === 'worktree',
          worktreeDir: hostWorktreeDir ?? ctx.directory,
          worktreeBranch: worktreeBranch ?? null,
          projectDir: ctx.directory,
          maxIterations,
          iteration: 1,
          auditCount: 0,
          errorCount: 0,
          phase: 'coding',
          executionModel: resolvedExecutionModel ?? null,
          auditorModel: resolvedAuditorModel ?? null,
          modelFailed: false,
          sandbox: sandboxEnabledForLoop,
          sandboxContainer,
          startedAt: Date.now(),
          completedAt: null,
          terminationReason: null,
          completionSummary: null,
          workspaceId: createdWorkspaceId ?? null,
          hostSessionId: command.hostSessionId ?? null,
        }
        
        const large: import('../storage/repos/loops-repo').LoopLargeFields = {
          prompt: planText,
          lastAuditResult: null,
        }
        
        const inserted = deps.loopsRepo.insert(row, large)
        if (!inserted) {
          deps.logger.error('handleStartLoop: failed to persist loop state')
          await rollbackLoopStart()
          return fail('internal_error', 500, 'Failed to persist loop state')
        }
        loopStatePersisted = true
      }
      
      deps.logger.log(`handleStartLoop: state stored for loop=${uniqueLoopName}`)
      
      // Send initial prompt
      const sessionDir = state.worktreeDir
      const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
        () => deps.v2.session.promptAsync({
          sessionID: sessionId,
          directory: sessionDir,
          parts: [{ type: 'text' as const, text: planText }],
          agent: 'code',
          model: loopModel!,
        }),
        () => deps.v2.session.promptAsync({
          sessionID: sessionId,
          directory: sessionDir,
          parts: [{ type: 'text' as const, text: planText }],
          agent: 'code',
        }),
        loopModel,
        deps.logger,
      )
      
      if (promptResult.error) {
        deps.logger.error('handleStartLoop: failed to send prompt', promptResult.error)
        await rollbackLoopStart()
        
        return fail('prompt_failed', 502, 'Loop session created but failed to send prompt')
      }
      
      if (hostWorktreeDir) {
        void (async () => {
          try {
            const { waitForGraphReady } = await import('../utils/tui-graph-status')
            const waitResult = await waitForGraphReady(ctx.projectId, {
              cwd: hostWorktreeDir,
              dbPathOverride: deps.dataDir ? join(deps.dataDir, 'graph.db') : undefined,
              pollMs: 100,
              timeoutMs: 5000,
            })
            
            if (waitResult === 'timeout') {
              deps.logger.log(`handleStartLoop: graph readiness timeout for worktree ${hostWorktreeDir}`)
            } else if (waitResult === null) {
              deps.logger.log(`handleStartLoop: graph status unavailable for worktree ${hostWorktreeDir}`)
            } else {
              deps.logger.log(`handleStartLoop: graph ready (${waitResult.state}) for worktree ${hostWorktreeDir}`)
            }
          } catch (err) {
            deps.logger.log(`handleStartLoop: graph wait error (non-fatal)`, err)
          }
        })()
      }
      
      // Success: start watchdog if requested
      if (command.lifecycle?.startWatchdog && deps.loopHandler) {
        deps.loopHandler.startWatchdog(uniqueLoopName)
      }
      
      // Navigate TUI if requested
      if (command.lifecycle?.selectSession && deps.v2.tui) {
        deps.v2.tui.selectSession({
          sessionID: sessionId,
          ...(createdWorkspaceId ? { workspace: createdWorkspaceId } : {}),
        }).catch((err: unknown) => {
          deps.logger.error('handleStartLoop: failed to navigate TUI', err as Error)
        })
      }
      
      // Abort source session if requested
      if (command.lifecycle?.abortSourceSessionOnSuccess && ctx.sourceSessionId) {
        deps.v2.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
          deps.logger.error('handleStartLoop: failed to abort source session', err as Error)
        })
      }
      
      const modelUsed = actualModel
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
        hostSessionId: command.hostSessionId,
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
      const { findPartialMatch } = await import('../utils/partial-match')
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
    _command: CancelLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopCancelledResult>> {
    // TODO: Implement in Phase 4
    return fail('internal_error', 500, 'Not yet implemented')
  }
  
  async function handleLoopRestart(
    _ctx: ForgeExecutionRequestContext,
    _command: RestartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopRestartedResult>> {
    // TODO: Implement in Phase 4
    return fail('internal_error', 500, 'Not yet implemented')
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
import { retryWithModelFallback } from '../utils/model-fallback'

function rowToLoopState(
  row: import('../storage/repos/loops-repo').LoopRow,
  large: import('../storage/repos/loops-repo').LoopLargeFields | null,
  _deps: ForgeExecutionServiceDeps,
): import('../services/loop').LoopState {
  return {
    active: row.status === 'running',
    sessionId: row.currentSessionId,
    auditSessionId: row.auditSessionId ?? undefined,
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
