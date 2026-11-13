import type { PluginConfig, Logger, LoopSandboxSettings } from '../types'
import type { ForgeClient } from '../client/port'
import { publishToast } from '../utils/toast'

import type { PlansRepo } from '../storage/repos/plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { createLoopEventHandler } from '../hooks'
import type { SandboxManager } from '../sandbox/manager'
import { extractPlanExecutionMetadata, createPlanExecutionSession } from '../utils/plan-execution'
import { parseModelString } from '../utils/model-fallback'
import { auditorModelChoiceAt, buildAuditorModelChain, usageRoleForPhase, standbyPhaseFor } from '../utils/loop-helpers'
import { createUsageCapture } from '../loop/runtime-usage'
import { classifyProviderLimit, extractErrorSignal } from '../loop/provider-limit'

import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset, buildPermissionRulesetForPhase, resolveLoopPermissionOptions } from '../constants/loop'
import { resolveLoopPermissionOptionsForWorkspace } from '../utils/loop-permission-options'
import { findPartialMatch } from '../utils/partial-match'
import { isSandboxEnabled } from '../sandbox/context'
import { loopSandboxWorkspaceExtra } from '../sandbox/loop-settings'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast, deleteSessionBestEffort } from '../utils/loop-session'
import { aggregateToUsageSummary } from '../utils/loop-format'
import { resolveForgeDbPath } from '../utils/opencode-paths'
import { existsSync } from 'fs'
import { applyPlanDecomposition } from './section-bootstrap'
import { decomposePlanSections } from './deterministic-decomposer'
import { sendLoopPrompt } from '../loop/send-loop-prompt'
import { markPromptSent, clearPromptPending, terminationStatusFor, parseTerminationReasonString, isWorkspaceNotFoundError } from '../loop'
import { ConcurrentPromptError } from '../loop/in-flight-guard'
import { transitionSectionIndex } from '../loop/state'
import { getRestartability, type RestartBlockedReason } from '../loop/restartability'
import { loopBranchExists, forgeBranchName } from '../workspace/forge-naming'
import { validateLoopBranchRequest } from '../workspace/loop-branch'
import { getWorktreeProjectPreconditionError } from '../workspace/forge-worktree'
import { resolveHostSessionDirectory } from '../utils/resolve-project-root'
import { resolvePostActionConfig, type ResolvedPostActionConfig } from '../loop/post-action-config'
import { defaultGitService, type GitService } from '../utils/git-service'
import { z } from 'zod'
import type { SessionPromptAsyncParams } from '../client/port'
import type { JsonObject } from '../utils/json-schema'

function stringifyCause(cause: unknown): string {
  try {
    return JSON.stringify(cause ?? '')
  } catch {
    return String(cause)
  }
}

function isTransientSessionError(cause: unknown): boolean {
  const text = z.string().safeParse(cause)
  const msg = cause instanceof Error ? cause.message : text.success ? text.data : stringifyCause(cause)
  return /Session not found/i.test(msg) || isWorkspaceNotFoundError(cause)
}

export type ForgeExecutionSurface = 'tool' | 'approval-hook' | 'api' | 'tui'

export interface ForgeExecutionRequestContext {
  surface: ForgeExecutionSurface
  projectId: string
  directory: string
  sourceSessionId?: string
  requestId?: string
}

export type PlanSource =
  | { kind: 'inline'; planText: string }
  | { kind: 'stored'; sessionId: string }
  | { kind: 'loop-state'; loopName: string }

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
  sandboxEnabled?: boolean
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
  baseCommit?: string
  sandboxSettings?: LoopSandboxSettings
  planText: string
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

export type LoopSelector =
  | { kind: 'exact'; name: string }
  | { kind: 'partial'; name: string }
  | { kind: 'only-active' }

export interface ExecutePlanNewSessionCommand {
  type: 'plan.execute.newSession'
  source: PlanSource
  title?: string
  executionModel?: string
  executionVariant?: string
  lifecycle?: {
    abortSourceSession?: boolean
    deleteSessionOnPromptFailure?: boolean
  }
}

export interface ExecutePlanHereCommand {
  type: 'plan.execute.here'
  source: PlanSource
  targetSessionId: string
  title?: string
  executionModel?: string
  executionVariant?: string
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
  sandbox?: LoopSandboxSettings
  baseRef?: string
  branch?: string
  lifecycle?: {
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
  sandbox?: LoopSandboxSettings
  baseRef?: string
  branch?: string
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
    sandbox: input.sandbox,
    baseRef: input.baseRef,
    branch: input.branch,
    lifecycle: input.lifecycle,
  }
}

export interface RestartLoopCommand {
  type: 'loop.restart'
  selector: LoopSelector
  force?: boolean
  auditorModel?: string
  auditorVariant?: string
  executionModel?: string
  executionVariant?: string
  expectedStartedAt?: string
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

export interface ForgeExecutionError {
  code: 'bad_request' | 'not_found' | 'conflict' | 'disabled' | 'prompt_failed' | 'lifecycle_failed' | 'internal_error' | 'provider_limit'
  status: number
  message: string
  candidates?: string[]
  details?: JsonObject
}

export interface ForgeExecutionWarning {
  code: string
  message: string
}

export type ForgeExecutionResponse<T> =
  | { ok: true; data: T; warnings?: ForgeExecutionWarning[] }
  | { ok: false; error: ForgeExecutionError }

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

export type ForgeExecutionResult<C extends ForgeExecutionCommand> =
  C extends ExecutePlanNewSessionCommand ? PlanExecutionStartedResult :
  C extends ExecutePlanHereCommand ? PlanExecutionStartedResult :
  C extends StartLoopCommand ? LoopStartedResult :
  C extends RestartLoopCommand ? LoopRestartedResult :
  C extends CancelLoopCommand ? LoopCancelledResult :
  C extends GetLoopStatusCommand ? LoopStatusResult :
  never

export interface ForgeExecutionService {
  dispatch(ctx: ForgeExecutionRequestContext, command: ExecutePlanNewSessionCommand): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>>
  dispatch(ctx: ForgeExecutionRequestContext, command: ExecutePlanHereCommand): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>>
  dispatch(ctx: ForgeExecutionRequestContext, command: StartLoopCommand): Promise<ForgeExecutionResponse<LoopStartedResult>>
  dispatch(ctx: ForgeExecutionRequestContext, command: RestartLoopCommand): Promise<ForgeExecutionResponse<LoopRestartedResult>>
  dispatch(ctx: ForgeExecutionRequestContext, command: CancelLoopCommand): Promise<ForgeExecutionResponse<LoopCancelledResult>>
  dispatch(ctx: ForgeExecutionRequestContext, command: GetLoopStatusCommand): Promise<ForgeExecutionResponse<LoopStatusResult>>
}

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
  pendingTeardowns: import('../workspace/pending-teardown').PendingTeardownRegistry
  gitService?: GitService
}

type AttachLoopFailureCode = 'already_attached' | 'conflict' | 'internal_error' | 'prompt_failed' | 'provider_limit'

function executionCodeForAttachFailure(code: AttachLoopFailureCode): ForgeExecutionError['code'] {
  switch (code) {
    case 'conflict':
      return 'conflict'
    case 'prompt_failed':
      return 'prompt_failed'
    case 'provider_limit':
      return 'provider_limit'
    case 'internal_error':
      return 'internal_error'
    case 'already_attached':
      return 'conflict'
  }
}

interface PromptAttemptResult {
  error?: unknown
}

function normalizeModelString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function ok<T>(data: T, warnings?: ForgeExecutionWarning[]): ForgeExecutionResponse<T> {
  return { ok: true, data, warnings }
}

function fail(
  code: ForgeExecutionError['code'],
  status: number,
  message: string,
  details?: JsonObject,
  candidates?: string[]
): ForgeExecutionResponse<never> {
  return {
    ok: false,
    error: { code, status, message, details, candidates }
  }
}

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

export async function attachLoopToSession(
  deps: ForgeExecutionServiceDeps,
  ctx: ForgeExecutionRequestContext,
  input: AttachLoopInput,
): Promise<{ ok: true; loopName: string } | { ok: false; code: 'already_attached' | 'conflict' | 'internal_error' | 'prompt_failed' | 'provider_limit'; message: string }> {
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
    sandboxSettings,
    baseCommit,
    planText,
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

  try {
    const removedSections = deps.sectionPlansRepo?.deleteAll(ctx.projectId, loopName) ?? 0
    deps.plansRepo.deleteForLoop(ctx.projectId, loopName)
    deps.reviewFindingsRepo?.deleteByLoopName(ctx.projectId, loopName)
    if (removedSections > 0) {
      deps.logger.log(`attachLoopToSession: purged ${removedSections} orphaned section_plans rows for ${loopName}`)
    }
  } catch (err) {
    deps.logger.error(`attachLoopToSession: failed to purge orphaned per-loop rows for ${loopName}`, err)
  }

  const resolvedProjectDir =
    (await resolveHostSessionDirectory(deps.client, input.hostSessionId, ctx.directory, deps.logger)) ?? ctx.directory

  let releaseFirstPromptHold = (): void => {}
  const attachOwnsLoop = (): boolean => deps.loop.service.getActiveState(loopName)?.sessionId === sessionId

  try {
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
      sandboxSettings,
      baseCommit,
      executionModel,
      auditorModel,
      executionVariant,
      auditorVariant,
      workspaceId,
      hostSessionId: input.hostSessionId,
      currentSectionIndex: 0,
      totalSections: 0,
    }

    deps.loop.service.setState(loopName, state)
    deps.loop.service.registerLoopSession(sessionId, loopName)
    deps.loop.registerSessionReverseIndex(sessionId, loopName)
    if (sendInitialPrompt) releaseFirstPromptHold = deps.loop.holdUntilFirstPrompt(state)

    deps.logger.log(`attachLoopToSession: state stored for loop=${loopName}`)

    onStarted?.({
      sessionId,
      loopName,
      displayName,
      worktreeDir,
      workspaceId,
    })

    const decomposition = applyPlanDecomposition({
      projectId: ctx.projectId,
      loopName,
      planText,
      loopsRepo: deps.loopsRepo,
      sectionPlansRepo: deps.sectionPlansRepo,
    })
    if (!decomposition.ok) {
      deps.logger.error(`attachLoopToSession: plan section graph is invalid: ${decomposition.errors.join('; ')}`)
      deps.loop.unregisterSessionReverseIndex(sessionId)
      if (attachOwnsLoop()) deps.loop.service.deleteState(loopName)
      return {
        ok: false,
        code: 'internal_error',
        message: `Plan section graph is invalid:\n- ${decomposition.errors.join('\n- ')}`,
      }
    }
    const { totalSections } = decomposition

    if (sandboxEnabled && deps.sandboxManager && deps.dataDir) {
      const dbPath = resolveForgeDbPath(deps.dataDir)
      if (existsSync(dbPath)) {
        const { waitForSandboxReady } = await import('../utils/sandbox-ready')
        const waitResult = await waitForSandboxReady({
          projectId: ctx.projectId,
          loopName,
          dbPath,
          pollMs: 200,
        })

        if (!waitResult.ready) {
          deps.logger.error(`attachLoopToSession: sandbox not ready (${waitResult.reason}${waitResult.error ? `: ${waitResult.error}` : ''})`)
          await deps.sandboxManager.stop(loopName).catch((err) => deps.logger.error('attachLoopToSession: failed to remove sandbox container after timeout', err))
          deps.loop.unregisterSessionReverseIndex(sessionId)
          if (attachOwnsLoop()) deps.loop.service.deleteState(loopName)
          return { ok: false, code: 'internal_error', message: `Sandbox not ready: ${waitResult.reason}` }
        }

        deps.logger.log(`attachLoopToSession: sandbox ready (${waitResult.containerName})`)
      }
    }

    if (!sendInitialPrompt) {
      if (startWatchdog && deps.loopHandler) {
        deps.loopHandler.startWatchdog(loopName)
      }
      deps.logger.log(`attachLoopToSession: attached loop=${loopName} without sending initial prompt`)
      return { ok: true, loopName }
    }

    const updatedState = { ...state, phase: 'coding' as const, currentSectionIndex: 0, totalSections }
    if (totalSections > 0) await deps.loop.snapshotSectionCodeGraph(updatedState)
    if (!attachOwnsLoop()) {
      deps.logger.log(`attachLoopToSession: loop ${loopName} was cancelled or restarted before its first prompt was built; skipping prompt and watchdog`)
      return { ok: true, loopName }
    }
    const promptText = totalSections > 0
      ? deps.loop.service.buildSectionInitialPrompt(updatedState)
      : deps.loop.service.buildPlanInitialPrompt(planText)

    const sessionDir = worktreeDir
    const promptParts = [{ type: 'text' as const, text: promptText }]

    const promptResult = await sendLoopPrompt({
      projectId: ctx.projectId,
      loopName,
      sessionId,
      agent: 'code',
      logger: deps.logger,
      primaryModel: loopModel,
      useInFlightGuard: false,
      performPrompt: async (model) => {
        markPromptSent(ctx.projectId, loopName, sessionId, deps.logger)
        releaseFirstPromptHold()
        try {
          const promptParams: SessionPromptAsyncParams = {
            sessionID: sessionId,
            directory: sessionDir,
            parts: promptParts,
            agent: 'code',
          }
          if (workspaceId) promptParams.workspace = workspaceId
          if (model) promptParams.model = model
          await deps.client.session.promptAsync(promptParams)
          return {}
        } catch (err) {
          return { error: err }
        }
      },
    })

    if (promptResult.result.error) {
      if (!attachOwnsLoop()) {
        deps.logger.error(`attachLoopToSession: initial prompt failed after loop ${loopName} moved to another session; leaving its state alone`, promptResult.result.error)
        return { ok: false, code: 'prompt_failed', message: 'Loop session created but failed to send prompt' }
      }
      const limitReason = classifyProviderLimit(extractErrorSignal(promptResult.result.error))
      if (limitReason) {
        deps.logger.error('attachLoopToSession: initial prompt hit provider limit, terminating loop', promptResult.result.error)
        await deps.loop.terminate(loopName, { kind: 'provider_limit', message: limitReason })
        return { ok: false, code: 'provider_limit', message: `Provider limit on initial prompt: ${limitReason}` }
      }
      deps.logger.error('attachLoopToSession: failed to send prompt', promptResult.result.error)
      deps.loop.unregisterSessionReverseIndex(sessionId)
      deps.loop.service.deleteState(loopName)
      return { ok: false, code: 'prompt_failed', message: 'Loop session created but failed to send prompt' }
    }

    if (startWatchdog && deps.loopHandler) {
      deps.loopHandler.startWatchdog(loopName)
    }

    if (abortSourceSessionOnSuccess && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((cause: unknown) => {
        deps.logger.error('attachLoopToSession: failed to abort source session', cause)
      })
    }

    return { ok: true, loopName }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isAlreadyExists = msg.includes('already exists') || msg.includes('UNIQUE constraint failed')
    deps.logger.error('attachLoopToSession: unexpected error', err)
    if (!isAlreadyExists) {
      deps.loop.unregisterSessionReverseIndex(sessionId)
      deps.loop.service.deleteState(loopName)
    } else {
      deps.logger.log(`attachLoopToSession: preserving existing loop ${loopName} despite collision`)
    }
    return {
      ok: false,
      code: isAlreadyExists ? 'already_attached' : 'internal_error',
      message: isAlreadyExists ? `Loop ${loopName} already attached` : 'Failed to attach loop to session',
    }
  } finally {
    releaseFirstPromptHold()
  }
}

export function createForgeExecutionService(deps: ForgeExecutionServiceDeps): ForgeExecutionService {
  const inFlightLoopStarts = new Map<string, Promise<ForgeExecutionResponse<LoopStartedResult>>>()
  const git = deps.gitService ?? defaultGitService
  function hashPlanForDedupe(text: string): string {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h) ^ text.charCodeAt(i)
    return (h >>> 0).toString(36)
  }

  async function handlePlanNewSession(
    ctx: ForgeExecutionRequestContext,
    command: ExecutePlanNewSessionCommand,
  ): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>> {
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const sessionTitle = formatPlanSessionTitle(title)
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    const executionVariant = command.executionVariant ?? deps.config.executionVariant
    
    let sessionId: string
    let sessionWorkspaceId: string | undefined
    try {
      const created = await createPlanExecutionSession(deps.client, {
        title: sessionTitle,
        directory: ctx.directory,
      })
      sessionId = created.sessionId
      sessionWorkspaceId = created.workspaceId
    } catch (err) {
      deps.logger.error('handlePlanNewSession: failed to create session', err)
      return fail('internal_error', 500, 'Failed to create session')
    }
    deps.logger.log(`handlePlanNewSession: created session=${sessionId}`)
    
    let promptError: unknown
    try {
      const promptParams: SessionPromptAsyncParams = {
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text', text: planText }],
        agent: 'code',
      }
      if (parsedModel) promptParams.model = parsedModel
      if (executionVariant) promptParams.variant = executionVariant
      if (sessionWorkspaceId) promptParams.workspace = sessionWorkspaceId
      await deps.client.session.promptAsync(promptParams)
    } catch (err) {
      promptError = err
    }
    
    if (promptError) {
      deps.logger.error('handlePlanNewSession: failed to prompt session', promptError)
      
      if (command.lifecycle?.deleteSessionOnPromptFailure) {
        await deleteSessionBestEffort(
          deps.client,
          { sessionID: sessionId, directory: ctx.directory },
          deps.logger,
          'handlePlanNewSession: failed to delete failed session',
        )
      }
      
      return fail('prompt_failed', 502, 'Session created but failed to send plan')
    }
    
    if (command.lifecycle?.abortSourceSession && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((cause: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to abort source session', cause)
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
    
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)
    const executionVariant = command.executionVariant ?? deps.config.executionVariant
    
    const executeHerePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`
    
    let promptError: unknown
    try {
      const promptParams: SessionPromptAsyncParams = {
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        parts: [{ type: 'text', text: executeHerePrompt }],
        agent: 'code',
      }
      if (parsedModel) promptParams.model = parsedModel
      if (executionVariant) promptParams.variant = executionVariant
      await deps.client.session.promptAsync(promptParams)
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
  
  function guardCommittedProject(ctx: ForgeExecutionRequestContext): ForgeExecutionResponse<never> | null {
    const errorMsg = getWorktreeProjectPreconditionError(ctx.projectId)
    if (errorMsg) {
      publishToast({
        client: deps.client,
        directory: ctx.directory,
        logger: deps.logger,
        title: 'Loop start blocked',
        message: 'No git commit in this project — the loop session would be invisible to this opencode instance. Commit, restart opencode, and retry.',
        variant: 'error',
        duration: 10_000,
        logPrefix: 'guardCommittedProject: failed to publish toast',
      })

      return fail(
        'bad_request',
        400,
        errorMsg,
      )
    }
    return null
  }

  async function handleStartLoop(
    ctx: ForgeExecutionRequestContext,
    command: StartLoopCommand,
  ): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    if (deps.config.loop?.enabled === false) {
      return fail('disabled', 403, 'Loops are disabled in plugin config')
    }

    const projectGuard = guardCommittedProject(ctx)
    if (projectGuard) return projectGuard

    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }
    
    const planText = planResult.planText

    const graphErrors = decomposePlanSections(planText).graphErrors
    if (graphErrors.length > 0) {
      return fail('bad_request', 400, `Plan section graph is invalid:\n- ${graphErrors.join('\n- ')}`)
    }

    const { displayName, executionName } = extractPlanExecutionMetadata(planText)
    const title = command.title ?? displayName
    const sessionTitle = formatLoopSessionTitle(title, { iteration: 1, currentSectionIndex: 0, totalSections: 0 })
    
    const uniqueLoopName = deps.loop.generateUniqueLoopName(
      command.loopName ?? executionName,
      (name) => git.branchExists(ctx.directory, forgeBranchName(name)),
    )

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

    const branchValidation = validateLoopBranchRequest(git, ctx.directory, {
      branch: command.branch,
      baseRef: command.baseRef,
    })
    if (!branchValidation.ok) return fail('bad_request', 400, branchValidation.message)

    async function doStart(): Promise<ForgeExecutionResponse<LoopStartedResult>> {
    const resolvedExecutionModel = command.executionModel ?? deps.config.executionModel
    const resolvedAuditorModel = command.auditorModel ?? deps.config.auditorModel
    
    const resolvedExecutionVariant = command.executionVariant ?? deps.config.executionVariant
    const resolvedAuditorVariant = command.auditorVariant ?? deps.config.auditorVariant
    
    const maxIterations = command.maxIterations ?? deps.config.loop?.defaultMaxIterations ?? 0
    
    let createdSessionId: string | null = null
    let createdWorkspaceId: string | undefined
    let hostWorktreeDir: string | undefined
    let worktreeBranch: string | undefined
    let sandboxStarted = false
    let sandboxStartAttempted = false
    let sandboxContainer: string | null = null
    let sandboxEnabledForLoop: boolean
    let loopStatePersisted = false
    let previousBranchTip: string | null = null

    const restoreBranchTip = (): void => {
      const branch = command.branch
      if (!previousBranchTip || !branch) return
      const current = git.revParse(ctx.directory, `refs/heads/${branch}`)
      if (current.ok && current.stdout.trim() === previousBranchTip) return
      const restored = git.branchForceUpdate(ctx.directory, branch, previousBranchTip)
      if (!restored.ok) {
        deps.logger.error(
          `handleStartLoop: failed to restore branch ${branch} to ${previousBranchTip}`,
          restored.stderr.trim(),
        )
      }
    }

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
      restoreBranchTip()
    }
    
    try {
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId

      if (!deps.sandboxManager) {
        deps.logger.log('handleStartLoop: sandbox manager not initialized; running in worktree-only mode')
      }

      if (command.branch && command.baseRef && git.branchExists(ctx.directory, command.branch)) {
        const tip = git.revParse(ctx.directory, `refs/heads/${command.branch}`)
        if (tip.ok) {
          previousBranchTip = tip.stdout.trim()
        } else {
          deps.logger.error(
            `handleStartLoop: could not capture the pre-start tip of branch ${command.branch}; a failed start will not restore it`,
            tip.stderr.trim(),
          )
        }
      }
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const wsResult = await createBuiltinWorktreeWorkspace(deps.client, {
        loopName: uniqueLoopName,
        directory: ctx.directory,
        baseRef: command.baseRef,
        branch: command.branch || undefined,
        extra: loopSandboxWorkspaceExtra(command.sandbox),
      }, deps.logger)
      if (!wsResult.ok) {
        deps.logger.error(`handleStartLoop: failed to create builtin worktree workspace (${wsResult.error.reason})`, wsResult.error.cause ?? '')
        await rollbackLoopStart()
        return fail('internal_error', 500, wsResult.error.message, { reason: wsResult.error.reason })
      }
      const ws = wsResult.workspace
      hostWorktreeDir = ws.directory
      worktreeBranch = ws.branch
      const workspaceId = ws.workspaceId
      createdWorkspaceId = ws.workspaceId

      const headResult = git.revParseHead(hostWorktreeDir)
      const resolvedBaseCommit = headResult.ok ? headResult.stdout.trim() : ''
      if (!resolvedBaseCommit) {
        deps.logger.error(`handleStartLoop: failed to resolve loop base commit for ${uniqueLoopName}`)
        await rollbackLoopStart()
        return fail('internal_error', 500, 'Failed to resolve loop base commit')
      }

      const sandboxEnabled = isSandboxEnabled(deps.config, deps.sandboxManager) && command.sandbox?.enabled !== false
      sandboxEnabledForLoop = sandboxEnabled

      const permissionRuleset = buildLoopPermissionRuleset(resolveLoopPermissionOptions(deps.config))

      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: sessionTitle,
        directory: hostWorktreeDir!,
        permission: permissionRuleset,
        workspaceId,
        loopName: uniqueLoopName,
        logPrefix: 'handleStartLoop',
        logger: deps.logger,
      })

      if (!createResult) {
        deps.logger.error('handleStartLoop: failed to create session')
        await rollbackLoopStart()
        return fail('internal_error', 500, 'Failed to create loop session')
      }

      const sessionId = createResult.sessionId
      createdSessionId = sessionId

      if (createResult.bindFailed) {
        deps.logger.log(`handleStartLoop: workspace ${workspaceId} created but initial bind failed; will retry on next session`)
      }

      if (sandboxEnabled && deps.sandboxManager) {
        const existingSandbox = deps.sandboxManager.getActive(uniqueLoopName)
        if (existingSandbox) {
          sandboxStarted = true
          sandboxContainer = existingSandbox.containerName
          deps.logger.log(`handleStartLoop: sandbox container ${existingSandbox.containerName} already provisioned by forge workspace adapter`)
        } else {
          try {
            sandboxStartAttempted = true
            const result = await deps.sandboxManager.start(uniqueLoopName, hostWorktreeDir!, undefined, command.sandbox)
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
        sandboxSettings: command.sandbox,
        baseCommit: resolvedBaseCommit,
        planText,
        startWatchdog: command.lifecycle?.startWatchdog,
        abortSourceSessionOnSuccess: command.lifecycle?.abortSourceSessionOnSuccess,
        onStarted: command.lifecycle?.onStarted,
      })

      if (!attachResult.ok) {
        if (attachResult.code !== 'provider_limit') {
          await rollbackLoopStart()
        }
        return fail(executionCodeForAttachFailure(attachResult.code), 503, attachResult.message)
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
    
    if (command.selector?.kind === 'exact' || command.selector?.kind === 'partial') {
      const { match, candidates } = findPartialMatch(
        command.selector.name,
        states,
        (s) => [s.loopName, s.worktreeBranch].filter((value) => value !== null && value !== undefined)
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
    
    const limit = command.limit ?? 20
    if (states.length > limit) {
      states = states.slice(0, limit)
    }
    
    const statusFromState = (state: import('../loop/state').LoopState): LoopStatusView['status'] => {
      if (state.active) return 'running'
      if (state.terminationReason) return terminationStatusFor(parseTerminationReasonString(state.terminationReason))
      return 'completed'
    }

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
        displayName: state.loopName,
        status: statusFromState(state),
        phase: state.phase,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        sessionId: state.sessionId,
        active: state.active,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        terminationReason: state.terminationReason,
        completionSummary: state.completionSummary,
        worktree: !!state.worktree,
        worktreeDir: state.worktreeDir,
        worktreeBranch: state.worktreeBranch,
        executionModel: state.executionModel,
        auditorModel: state.auditorModel,
        workspaceId: state.workspaceId,
        hostSessionId: state.hostSessionId,
        currentSectionIndex: state.currentSectionIndex,
        totalSections: state.totalSections,
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

    const restartSandbox = isSandboxEnabled(deps.config, deps.sandboxManager) && stoppedState.sandboxSettings?.enabled !== false
    deps.logger.log(
      `handleRestartLoop: [perm-diag] worktree=${String(stoppedState.worktree)} sandbox=${String(restartSandbox)}`
    )
    const previousState = { ...stoppedState }
    let previousSessionId = stoppedState.sessionId
    let bindFailed = false

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean }
      | { ok: false; error: string }
      | { ok: false; error: string; providerLimitMessage: string }

    const outcome = await deps.loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
      const latestState = deps.loop.service.getActiveState(stoppedState.loopName)
      if (command.expectedStartedAt !== undefined) {
        const expectedMs = Date.parse(command.expectedStartedAt)
        const currentMs = Date.parse((latestState ?? stoppedState).startedAt)
        if (!Number.isFinite(expectedMs) || expectedMs !== currentMs) {
          return {
            ok: false,
            error: `Loop "${stoppedState.loopName}" was restarted since it was selected. Reopen the restart dialog to see its current state.`,
          }
        }
      }
      if (!latestState && stoppedState.active) {
        return { ok: false, error: `Loop "${stoppedState.loopName}" has been removed.` }
      }
      if (latestState && latestState.active && !stoppedState.active) {
        return {
          ok: false,
          error: `Loop "${stoppedState.loopName}" is already active with session ${latestState.sessionId}. Use --force to abort and restart.`,
        }
      }

      const graphState = latestState ?? stoppedState
      if (!graphState.totalSections) {
        const graphErrors = decomposePlanSections(graphState.prompt ?? '').graphErrors
        if (graphErrors.length > 0) {
          return { ok: false, error: `Plan section graph is invalid:\n- ${graphErrors.join('\n- ')}` }
        }
      }

      if (stoppedState.active && latestState) {
        try {
          await deps.client.session.abort({ sessionID: latestState.sessionId })
        } catch (err) {
          return { ok: false, error: `Could not abort active loop session ${latestState.sessionId}: ${err instanceof Error ? err.message : String(err)}` }
        }
        await deps.loopHandler!.clearLoopTimers(stoppedState.loopName)
        Object.assign(stoppedState, latestState)
        Object.assign(previousState, latestState)
        previousSessionId = latestState.sessionId
      } else {
        if (latestState) {
          Object.assign(stoppedState, latestState)
          Object.assign(previousState, latestState)
          previousSessionId = latestState.sessionId
        }
      }

      const overrideAuditorModel = normalizeModelString(command.auditorModel)
      const overrideAuditorVariant = normalizeModelString(command.auditorVariant)
      if (overrideAuditorModel) {
        stoppedState.auditorModel = overrideAuditorModel
      }
      if (command.auditorVariant !== undefined) {
        stoppedState.auditorVariant = overrideAuditorVariant
      }

      const overrideExecutionModel = normalizeModelString(command.executionModel)
      const overrideExecutionVariant = normalizeModelString(command.executionVariant)
      if (overrideExecutionModel) {
        stoppedState.executionModel = overrideExecutionModel
      }
      if (command.executionVariant !== undefined) {
        stoppedState.executionVariant = overrideExecutionVariant
      }

      if (stoppedState.standbySessionId && stoppedState.standbySessionId !== previousSessionId) {
        const standbyPhase = standbyPhaseFor(stoppedState.phase)
        const standbyUsage = createUsageCapture({
          client: deps.client,
          logger: deps.logger,
          getConfig: () => deps.config,
          projectId: ctx.projectId,
          loopSessionUsageRepo: deps.loopSessionUsageRepo,
        })
        await standbyUsage.captureLoopSessionUsage({
          loopName: stoppedState.loopName,
          sessionId: stoppedState.standbySessionId,
          directory: stoppedState.worktreeDir,
          role: usageRoleForPhase(standbyPhase),
          fallbackModel: standbyUsage.getFallbackModelForSession(stoppedState, standbyPhase),
        })
        await deleteSessionBestEffort(
          deps.client,
          { sessionID: stoppedState.standbySessionId, directory: stoppedState.worktreeDir },
          deps.logger,
          `loop-restart: failed to delete standby session ${stoppedState.standbySessionId}`,
        )
      }

      deps.loop.service.discardPendingHandoff(stoppedState.loopName)

      if (stoppedState.phase === 'post_action' && !resolvePostActionConfig(deps.config).enabled) {
        deps.logger.log(`loop-restart: ${stoppedState.loopName} was in post_action but postAction is disabled; marking completed without restart`)
        const fromPhase = stoppedState.phase
        const iteration = stoppedState.iteration ?? 0
        const sectionIndex = transitionSectionIndex(stoppedState)
        deps.loop.service.terminate(stoppedState.loopName, { status: 'completed', reason: 'completed', completedAt: Date.now() })
        deps.loop.service.recordTerminalTransition(stoppedState.loopName, {
          reason: { kind: 'completed' },
          fromPhase,
          iteration,
          sectionIndex,
        })
        return { ok: false, error: 'Loop implementation already completed; post-action is disabled — nothing to restart.' }
      }

      const permissionOptions = await resolveLoopPermissionOptionsForWorkspace(deps.client, deps.config, stoppedState.workspaceId)
      const permissionRuleset = buildPermissionRulesetForPhase(stoppedState.phase, permissionOptions)

      stoppedState.iteration = 1

      if (stoppedState.worktree) {
        const { createBuiltinWorktreeWorkspace, getForgeWorkspaceEntry } = await import('../workspace/forge-worktree')
        const previousEntry = stoppedState.workspaceId
          ? await getForgeWorkspaceEntry(deps.client, stoppedState.workspaceId).catch(() => undefined)
          : undefined
        const mergedExtra = {
          ...(previousEntry?.extra ?? {}),
          ...loopSandboxWorkspaceExtra(stoppedState.sandboxSettings),
        }
        const wsResult = await createBuiltinWorktreeWorkspace(deps.client, {
          loopName: stoppedState.loopName,
          directory: stoppedState.projectDir || ctx.directory,
          branch: stoppedState.worktreeBranch,
          extra: Object.keys(mergedExtra).length > 0 ? mergedExtra : undefined,
        }, deps.logger)
        if (!wsResult.ok) return { ok: false, error: `Restart failed: ${wsResult.error.message}` }
        const ws = wsResult.workspace
        stoppedState.workspaceId = ws.workspaceId
        stoppedState.worktreeDir = ws.directory
        stoppedState.worktreeBranch = ws.branch
      }

      if (restartSandbox && deps.sandboxManager) {
        try {
          const sandboxResult = await deps.sandboxManager.start(stoppedState.loopName, stoppedState.worktreeDir, undefined, stoppedState.sandboxSettings)
          deps.logger.log(`loop-restart: started sandbox container ${sandboxResult.containerName}`)
        } catch (err) {
          deps.logger.error('loop-restart: failed to start sandbox container', err)
          return { ok: false, error: 'Restart failed: could not start sandbox container.' }
        }
      }

      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: formatLoopSessionTitle(stoppedState.loopName, {
          iteration: stoppedState.iteration ?? 0,
          currentSectionIndex: stoppedState.currentSectionIndex ?? 0,
          totalSections: stoppedState.totalSections ?? 0,
        }),
        directory: stoppedState.worktreeDir,
        permission: permissionRuleset,
        workspaceId: stoppedState.workspaceId,
        loopName: stoppedState.loopName,
        logPrefix: 'loop-restart',
        logger: deps.logger,
      })

      if (!createResult) return { ok: false, error: 'Failed to create new session for restart.' }

      const newSessionId = createResult.sessionId
      if (createResult.bindFailed) {
        stoppedState.workspaceId = undefined
        bindFailed = true
      }

      if (!stoppedState.totalSections) {
        const planText = stoppedState.prompt ?? ''
        const decomposition = applyPlanDecomposition({
          projectId: ctx.projectId,
          loopName: stoppedState.loopName,
          planText,
          loopsRepo: deps.loopsRepo,
          sectionPlansRepo: deps.sectionPlansRepo,
        })
        if (!decomposition.ok) {
          return { ok: false, error: `Plan section graph is invalid:\n- ${decomposition.errors.join('\n- ')}` }
        }
        stoppedState.totalSections = decomposition.totalSections
        if (stoppedState.totalSections > 0) {
          stoppedState.currentSectionIndex = 0
        }
      }

      const effectiveSessionId = newSessionId
      const restartPhase = stoppedState.phase === 'post_action' ? 'post_action' as const : 'coding' as const

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
        sandboxContainer: restartSandbox ? deps.sandboxManager?.runtime.sandboxContainerName(stoppedState.loopName) : undefined,
        sandboxSettings: stoppedState.sandboxSettings,
        baseCommit: stoppedState.baseCommit,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
        executionVariant: stoppedState.executionVariant,
        auditorVariant: stoppedState.auditorVariant,
        workspaceId: stoppedState.workspaceId,
        hostSessionId: stoppedState.hostSessionId,
        currentSectionIndex: stoppedState.currentSectionIndex,
        totalSections: stoppedState.totalSections,
      }
      let promptText: string
      let postActionCfg: ResolvedPostActionConfig | undefined

      if (stoppedState.phase === 'post_action') {
        postActionCfg = resolvePostActionConfig(deps.config)
        promptText = deps.loop.service.buildPostActionPrompt(newState, { skill: postActionCfg.skill, prompt: postActionCfg.prompt })
      } else if (stoppedState.totalSections > 0) {
        const outstandingBugs = deps.loop.service.getOutstandingFindings(stoppedState.loopName, 'bug')
        if (deps.loop.service.getBlockingBugFindings(stoppedState).length > 0) {
          promptText = deps.loop.service.buildSectionContinuationPrompt(newState, undefined, outstandingBugs)
        } else {
          promptText = deps.loop.service.buildSectionInitialPrompt(newState)
        }
      } else {
        promptText = deps.loop.service.buildPlanInitialPrompt(stoppedState.prompt ?? '')
      }

      const restartAuditorState = {
        ...stoppedState,
        auditorModel: normalizeModelString(stoppedState.auditorModel ?? deps.config.auditorModel),
        modelFailed: false,
        auditorFallbackIndex: 0,
      }
      const restartAuditorChoice = auditorModelChoiceAt(buildAuditorModelChain(deps.config, restartAuditorState), 0)
      const restartAuditorModel = restartAuditorChoice.model
      const loopModel = stoppedState.phase === 'post_action' && postActionCfg?.model
        ? parseModelString(postActionCfg.model)
        : stoppedState.phase === 'post_action'
          ? restartAuditorModel
          : parseModelString(stoppedState.executionModel) ?? parseModelString(deps.config.executionModel)
      const loopFallbackModel = stoppedState.phase === 'post_action' && postActionCfg?.model
        ? restartAuditorModel
        : undefined


      deps.loopsRepo.restart(ctx.projectId, stoppedState.loopName, {
        sessionId: newState.sessionId,
        phase: newState.phase,
        iteration: newState.iteration,
        auditCount: newState.auditCount,
        sandbox: newState.sandbox ?? false,
        sandboxContainer: newState.sandboxContainer ?? null,
        workspaceId: newState.workspaceId ?? null,
        auditorModel: restartAuditorState.auditorModel ?? null,
        auditorVariant: command.auditorVariant === undefined ? undefined : overrideAuditorVariant ?? null,
        executionModel: overrideExecutionModel,
        executionVariant: command.executionVariant === undefined ? undefined : overrideExecutionVariant ?? null,
        currentSectionIndex: newState.currentSectionIndex,
        totalSections: newState.totalSections,
        startedAt: new Date(newState.startedAt).getTime(),
      })

      deps.loop.service.registerLoopSession(effectiveSessionId, stoppedState.loopName)
      deps.loop.registerSessionReverseIndex(effectiveSessionId, stoppedState.loopName)

      const restartPhaseChanged = restartPhase !== stoppedState.phase
      if (restartPhaseChanged) {
        deps.loop.service.recordTransition(stoppedState.loopName, {
          eventType: 'restart',
          transitionKind: 'phase',
          fromPhase: stoppedState.phase,
          toPhase: restartPhase,
          iteration: 1,
          sectionIndex: transitionSectionIndex(stoppedState),
        })
      }

      const performRestartPrompt = async (model?: { providerID: string; modelID: string }): Promise<{ error?: unknown }> => {
        markPromptSent(ctx.projectId, stoppedState.loopName, effectiveSessionId, deps.logger)
        const variant = stoppedState.phase === 'post_action'
          ? (postActionCfg?.model && model === loopModel ? undefined : restartAuditorChoice.variant)
          : stoppedState.executionVariant
        try {
          const promptParams: SessionPromptAsyncParams = {
            sessionID: effectiveSessionId,
            directory: stoppedState.worktreeDir,
            parts: [{ type: 'text', text: promptText }],
            agent: 'code',
          }
          if (model) promptParams.model = model
          if (variant) promptParams.variant = variant
          if (stoppedState.workspaceId) promptParams.workspace = stoppedState.workspaceId
          await deps.client.session.promptAsync(promptParams)
          return {}
        } catch (err) {
          return { error: err }
        }
      }

      const RESTART_PROMPT_MAX_ATTEMPTS = 4
      let promptResult: PromptAttemptResult = { error: new Error('restart prompt not attempted') }
      for (let attempt = 1; attempt <= RESTART_PROMPT_MAX_ATTEMPTS; attempt++) {
        const { result } = await sendLoopPrompt({
          projectId: ctx.projectId,
          loopName: stoppedState.loopName,
          sessionId: effectiveSessionId,
          agent: 'code',
          logger: deps.logger,
          primaryModel: loopModel,
          fallbackModel: loopFallbackModel,
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
        const limitReason = classifyProviderLimit(extractErrorSignal(promptResult.error))
        if (limitReason) {
          deps.logger.error(`loop-restart: provider limit detected for ${stoppedState.loopName}: ${limitReason}, terminating`)
          clearPromptPending(ctx.projectId, stoppedState.loopName, deps.logger)
          deps.loop.unregisterSessionReverseIndex(effectiveSessionId)
          return {
            ok: false as const,
            error: `Provider limit on restart prompt: ${limitReason}`,
            providerLimitMessage: limitReason,
          }
        }

        const isConcurrent = promptResult.error instanceof ConcurrentPromptError
        if (!isConcurrent) {
          clearPromptPending(ctx.projectId, stoppedState.loopName, deps.logger)
        }
        deps.logger.error('loop-restart: failed to send prompt', promptResult.error)
        const savedPlans = deps.sectionPlansRepo?.list(ctx.projectId, stoppedState.loopName) ?? []
        deps.loop.unregisterSessionReverseIndex(effectiveSessionId)
        try {
          let restoreRow: import('../loop/state').LoopState
          if (previousState.active) {
            restoreRow = {
              ...previousState,
              active: false,
              status: 'errored',
              terminationReason: 'restart_prompt_failed',
              completedAt: new Date().toISOString(),
            }
          } else {
            restoreRow = previousState
          }
          deps.loop.service.restoreState(restoreRow.loopName, restoreRow)
          const restartFromPhase = restartPhase
          const restartToPhase = previousState.phase ?? 'coding'
          const iteration = previousState.iteration ?? 0
          const sectionIndex = transitionSectionIndex(previousState)
          if (restartPhaseChanged) {
            deps.loop.service.recordTransition(previousState.loopName, {
              eventType: 'restart_prompt_failed',
              transitionKind: 'rollback',
              fromPhase: restartFromPhase,
              toPhase: restartToPhase,
              iteration,
              sectionIndex,
            })
          }
          if (previousState.active) {
            deps.loop.service.terminate(previousState.loopName, {
              status: 'errored',
              reason: 'restart_prompt_failed',
              completedAt: Date.now(),
            })
            deps.loop.service.recordTerminalTransition(previousState.loopName, {
              reason: { kind: 'restart_prompt_failed' },
              fromPhase: restartToPhase,
              iteration,
              sectionIndex,
            })
          }
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

    const restartSucceeded = (
      sessionId: string,
      previousSession: string,
      bindFailedValue: boolean,
    ): ForgeExecutionResponse<LoopRestartedResult> => {
      if (bindFailedValue) {
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
        sessionId,
        previousSessionId: previousSession,
        worktreeDir: stoppedState.worktreeDir,
        worktreeBranch: stoppedState.worktreeBranch,
        worktree: !!stoppedState.worktree,
        sandbox: restartSandbox,
        bindFailed: bindFailedValue,
        iteration: stoppedState.iteration,
      })
    }

    if (!outcome.ok && 'providerLimitMessage' in outcome) {
      await deps.loop.terminate(stoppedState.loopName, { kind: 'provider_limit', message: outcome.providerLimitMessage })
      if (restartSandbox && deps.sandboxManager) {
        await deps.sandboxManager.stop(stoppedState.loopName).catch(() => {})
      }
      return fail('internal_error', 500, outcome.error)
    }

    if (!outcome.ok) return fail('internal_error', 500, outcome.error)

    return restartSucceeded(outcome.newSessionId, outcome.previousSessionId, outcome.bindFailed)
  }
  
  async function dispatch(ctx: ForgeExecutionRequestContext, command: ExecutePlanNewSessionCommand): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>>
  async function dispatch(ctx: ForgeExecutionRequestContext, command: ExecutePlanHereCommand): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>>
  async function dispatch(ctx: ForgeExecutionRequestContext, command: StartLoopCommand): Promise<ForgeExecutionResponse<LoopStartedResult>>
  async function dispatch(ctx: ForgeExecutionRequestContext, command: RestartLoopCommand): Promise<ForgeExecutionResponse<LoopRestartedResult>>
  async function dispatch(ctx: ForgeExecutionRequestContext, command: CancelLoopCommand): Promise<ForgeExecutionResponse<LoopCancelledResult>>
  async function dispatch(ctx: ForgeExecutionRequestContext, command: GetLoopStatusCommand): Promise<ForgeExecutionResponse<LoopStatusResult>>
  async function dispatch(
    ctx: ForgeExecutionRequestContext,
    command: ForgeExecutionCommand,
  ): Promise<ForgeExecutionResponse<ForgeExecutionResult<ForgeExecutionCommand>>> {
    switch (command.type) {
      case 'plan.execute.newSession':
        return handlePlanNewSession(ctx, command)
      case 'plan.execute.here':
        return handlePlanHere(ctx, command)
      case 'loop.start':
        return handleStartLoop(ctx, command)
      case 'loop.status':
        return handleLoopStatus(ctx, command)
      case 'loop.cancel':
        return handleLoopCancel(ctx, command)
      case 'loop.restart':
        return handleLoopRestart(ctx, command)
    }
  }
  
  return {
    dispatch,
  }
}

