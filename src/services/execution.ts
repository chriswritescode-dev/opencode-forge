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
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'

import { formatLoopSessionTitle, formatPlanSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../constants/loop'
import { findPartialMatch } from '../utils/partial-match'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { join } from 'path'
import { existsSync } from 'fs'
import { extractSections, decomposeDeterministically } from '../utils/section-capture'
import { markPromptSent, clearPromptPending, terminationStatusFor, parseTerminationReasonString } from '../loop'
import {
  withInFlightGuard,
  ConcurrentPromptError,
  type PromptAgent,
} from '../loop/in-flight-guard'

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
  loopName: string
  hostSessionId?: string
  title?: string
  executionModel?: string
  auditorModel?: string
  planSource: 'stored' | 'inline'
  planText?: string
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
  maxIterations: number
  sandboxEnabled: boolean
  sandboxContainer?: string
  planText: string
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
  reviewFindingsRepo?: import('../storage/repos/review-findings-repo').ReviewFindingsRepo
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
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
  const maxAttempts = 3
  const backoffMs = 250

  async function attemptSelectSession(attempt: number): Promise<{ ok: boolean; retryable: boolean }> {
    try {
      await deps.v2.tui!.selectSession({
        sessionID: selection.sessionID,
        ...(selection.workspace ? { workspace: selection.workspace } : {}),
      })
      deps.logger.log(`[warp] select.v2.selectSession ok attempt=${attempt}`)
      return { ok: true, retryable: false }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      deps.logger.log(`[warp] select.v2.selectSession failed attempt=${attempt} error="${errorMsg}"`)
      const retryable = errorMsg.includes('Unable to connect')
      if (retryable) {
        deps.logger.log('selectSessionWithFallback: v2 TUI unavailable, will retry then fall back to publish')
      } else {
        deps.logger.error('selectSessionWithFallback: v2 TUI error', err)
      }
      return { ok: false, retryable }
    }
  }

  if (deps.v2.tui) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await attemptSelectSession(attempt)
      if (result.ok) return
      if (!result.retryable) break
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }
    }
  } else {
    deps.logger.log('[warp] select.v2.selectSession skipped reason=no-v2-tui')
  }

  try {
    if (!deps.v2.tui) {
      deps.logger.log('[warp] select.v2.publish skipped reason=no-v2-tui')
    } else {
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
      deps.logger.log('[warp] select.v2.publish ok')
      return
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    deps.logger.log(`[warp] select.v2.publish failed error="${errorMsg}"`)
    if (errorMsg.includes('Unable to connect')) {
      deps.logger.log('selectSessionWithFallback: v2 TUI publish unavailable, falling back to legacy SDK')
    } else {
      deps.logger.error('selectSessionWithFallback: v2 TUI publish error', err)
    }
  }

  if (!deps.legacyClient?.tui) {
    deps.logger.log('[warp] select.legacy.publish skipped reason=no-legacy-tui')
    deps.logger.error('selectSessionWithFallback: no legacy TUI available')
    return
  }

  try {
    await deps.legacyClient.tui.publish({
      body: {
        type: 'tui.session.select',
        properties: {
          sessionID: selection.sessionID,
          ...(selection.workspace ? { workspace: selection.workspace } : {}),
        },
      },
    } as unknown as Parameters<typeof deps.legacyClient.tui.publish>[0])
    deps.logger.log('[warp] select.legacy.publish ok')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    deps.logger.log(`[warp] select.legacy.publish failed error="${errorMsg}"`)
    deps.logger.error('selectSessionWithFallback: legacy TUI failed', err)
  }
}

export interface SelectInitialWorktreeSessionOpts {
  selectSession: boolean | undefined
  logger: Logger | Console
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
  selectSessionFn: (selection: { sessionID: string; workspace?: string }) => Promise<void>
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

    const SELECT_TIMEOUT_MS = 2000
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
): Promise<{ ok: true; loopName: string } | { ok: false; code: 'already_attached' | 'internal_error' | 'prompt_failed'; message: string }> {
  const {
    sessionId,
    workspaceId,
    worktreeDir,
    worktreeBranch,
    loopName,
    displayName,
    executionModel,
    auditorModel,
    maxIterations,
    sandboxEnabled,
    sandboxContainer,
    planText,
    selectSession,
    selectSessionTiming,
    startWatchdog,
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
    // Terminal row from a prior run (cancelled/completed/errored/stalled).
    // Clear it so the new attach can insert fresh state without colliding.
    deps.logger.log(`attachLoopToSession: clearing terminal loop row ${loopName} (status=${existing.status}) before re-attach`)
    try {
      deps.loop.deleteState(loopName)
    } catch (err) {
      deps.logger.error(`attachLoopToSession: failed to clear terminal loop row ${loopName}`, err)
      return { ok: false, code: 'internal_error', message: `Failed to clear stale loop state for ${loopName}` }
    }
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

  try {
    // Persist loop state
    const state: import('../loop/state').LoopState = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: worktreeDir ?? ctx.directory,
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
      sandbox: sandboxEnabled,
      sandboxContainer: sandboxContainer ?? undefined,
      executionModel,
      auditorModel,
      workspaceId,
      hostSessionId: input.hostSessionId,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    }

    deps.loop.setState(loopName, state)
    deps.loop.registerLoopSession(sessionId, loopName)

    deps.logger.log(`attachLoopToSession: state stored for loop=${loopName}`)

    onStarted?.({
      sessionId,
      loopName,
      displayName,
      worktreeDir,
      workspaceId,
    })

    // === Section extraction ===

    const maxSections = 12
    const markerSections = extractSections(planText, { maxSections })
    let sections = markerSections
    if (sections.length === 0) {
      sections = decomposeDeterministically(planText, { maxSections })
    }
    let promptText: string
    if (sections.length > 0 && deps.sectionPlansRepo) {
      deps.sectionPlansRepo.bulkInsert({ projectId: ctx.projectId, loopName, sections })
      deps.loopsRepo.setTotalSections(ctx.projectId, loopName, sections.length)
      deps.loopsRepo.setCurrentSectionIndex(ctx.projectId, loopName, 0)
      deps.sectionPlansRepo.setStatus(ctx.projectId, loopName, 0, 'in_progress')
      deps.sectionPlansRepo.setStartedAt(ctx.projectId, loopName, 0, Date.now())
      const updatedState = { ...state, phase: 'coding' as const, currentSectionIndex: 0, totalSections: sections.length }
      promptText = deps.loop.buildSectionInitialPrompt(updatedState as import('../loop/state').LoopState)
    } else {
      deps.loopsRepo.setTotalSections(ctx.projectId, loopName, 0)
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
          deps.loop.deleteState(loopName)
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

      selectSessionWithFallback(deps, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI (early)', err as Error)
      })
    }

    // Send initial prompt with fallback
    const sessionDir = worktreeDir
    const promptParts = [{ type: 'text' as const, text: promptText }]
    const workspaceParam = workspaceId ? { workspace: workspaceId } : {}

    let promptResult: { result: SessionPromptResult; usedModel?: typeof loopModel }

    if (loopModel) {
      promptResult = await retryWithModelFallback(
        async () => {
          markPromptSent(loopName, sessionId, deps.logger)
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
          markPromptSent(loopName, sessionId, deps.logger)
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
    } else {
      markPromptSent(loopName, sessionId, deps.logger)
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
    }

    if (promptResult.result.error) {
      clearPromptPending(loopName, deps.logger)
      deps.logger.error('attachLoopToSession: failed to send prompt', promptResult.result.error)
      deps.loop.deleteState(loopName)
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

      selectSessionWithFallback(deps, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI', err as Error)
      })
    }

    // Abort source session if requested
    if (abortSourceSessionOnSuccess && ctx.sourceSessionId) {
      deps.v2.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to abort source session', err as Error)
      })
    }

    return { ok: true, loopName }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isAlreadyExists = msg.includes('already exists') || msg.includes('UNIQUE constraint failed')
    deps.logger.error('attachLoopToSession: unexpected error', err)
    if (!isAlreadyExists) {
      deps.loop.deleteState(loopName)
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
    
    // Build execute-here prompt
    const executeHerePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`
    
    // Prompt code agent in target session with fallback
    const { result: promptResult, usedModel: actualModel } = await promptSessionWithFallback(
      deps,
      {
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: executeHerePrompt }],
        agent: 'code',
      },
      parsedModel,
    )
    
    if (promptResult.error) {
      deps.logger.error('handlePlanHere: execute-here execution failed', promptResult.error)
      return fail('prompt_failed', 502, 'Failed to execute here')
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

      const doSelectInitialWorktreeSession = async (
        targetSessionId: string,
        boundWorkspaceId: string | undefined,
        context: string,
      ): Promise<void> => {
        await selectInitialWorktreeSession(targetSessionId, boundWorkspaceId, context, {
          selectSession: command.lifecycle?.selectSession,
          logger: deps.logger,
          workspaceStatusRegistry: deps.workspaceStatusRegistry,
          selectSessionFn: (sel) => selectSessionWithFallback(deps, sel),
        })
      }

      // Compute host session ID for metadata persistence only (not session parenting)
      const hostSessionId = command.hostSessionId ?? ctx.sourceSessionId

      if (!deps.sandboxManager) {
        deps.logger.log('handleStartLoop: sandbox manager not initialized; running in worktree-only mode')
      }

      // Create builtin worktree workspace (single call — no separate worktree.create)
      const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
      const ws = await createBuiltinWorktreeWorkspace(deps.v2, {
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

      const permissionRuleset = buildLoopPermissionRuleset()

      // Create single code session
      const createResult = await createLoopSessionWithWorkspace({
        v2: deps.v2,
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
    if (
      stoppedState.terminationReason &&
      parseTerminationReasonString(stoppedState.terminationReason).kind === 'final_audit_retry_exhausted' &&
      !command.force
    ) {
      return fail(
        'conflict',
        409,
        `Loop "${stoppedState.loopName}" terminated during final audit retry exhaustion. Use force=true to restart.`,
      )
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
    const permissionRuleset = buildLoopPermissionRuleset()
    const previousState = { ...stoppedState }
    let bindFailed = false
    const previousSessionId = stoppedState.sessionId

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean }
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

      // Create new session for restart

      let newSessionId: string | undefined

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
        v2: deps.v2,
        title: formatLoopSessionTitle(stoppedState.loopName, {
          iteration: stoppedState.iteration ?? 0,
          currentSectionIndex: stoppedState.currentSectionIndex ?? 0,
          totalSections: stoppedState.totalSections ?? 0,
        }),
        directory: stoppedState.worktreeDir,
        permission: stoppedState.phase === 'final_auditing' ? buildAuditSessionPermissionRuleset() : permissionRuleset,
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

      // Unified section extraction on restart — preserve existing progress if sections exist
      const maxSections = 12
      const planText = stoppedState.prompt ?? ''
      const markerSections = extractSections(planText, { maxSections })
      let sections = markerSections
      if (sections.length === 0) {
        sections = decomposeDeterministically(planText, { maxSections })
      }
      if (sections.length > 0 && deps.sectionPlansRepo && !stoppedState.totalSections) {
        // New sections being extracted (first-time or fresh)
        deps.sectionPlansRepo.bulkInsert({
          projectId: ctx.projectId,
          loopName: stoppedState.loopName,
          sections,
        })

        deps.loopsRepo.setTotalSections(ctx.projectId, stoppedState.loopName, sections.length)
        deps.loopsRepo.setCurrentSectionIndex(ctx.projectId, stoppedState.loopName, 0)

        deps.sectionPlansRepo.setStatus(ctx.projectId, stoppedState.loopName, 0, 'in_progress')
        deps.sectionPlansRepo.setStartedAt(ctx.projectId, stoppedState.loopName, 0, Date.now())

        stoppedState.currentSectionIndex = 0
        stoppedState.totalSections = sections.length
      } else if (!stoppedState.totalSections) {
        deps.loopsRepo.setTotalSections(ctx.projectId, stoppedState.loopName, 0)
        stoppedState.totalSections = 0
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
        worktree: stoppedState.worktree,
        sandbox: restartSandbox,
        sandboxContainer: restartSandbox ? deps.sandboxManager?.docker.containerName(stoppedState.loopName) : undefined,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
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
          promptText = deps.loop.buildFinalAuditPrompt(stoppedState)
        } else {
          promptText = deps.loop.buildSectionInitialPrompt(stoppedState)
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

      deps.loop.registerLoopSession(effectiveSessionId, stoppedState.loopName)

      const sendRestartPrompt = async (model?: { providerID: string; modelID: string }) => {
        try {
          return await withInFlightGuard(
            stoppedState.loopName,
            effectiveSessionId,
            promptAgent as PromptAgent,
            deps.logger,
            async () => {
              markPromptSent(stoppedState.loopName, effectiveSessionId, deps.logger)
              return await deps.v2.session.promptAsync({
                sessionID: effectiveSessionId,
                directory: stoppedState.worktreeDir,
                parts: [{ type: 'text' as const, text: promptText }],
                agent: promptAgent,
                ...(model ? { model } : {}),
                ...workspaceParam,
              })
            },
          )
        } catch (err) {
          if (err instanceof ConcurrentPromptError) return { error: err }
          throw err
        }
      }

      const { result: promptResult } = await retryWithModelFallback(
        () => sendRestartPrompt(loopModel!),
        () => sendRestartPrompt(),
        loopModel,
        deps.logger,
      )

      if (promptResult.error) {
        const isConcurrent = promptResult.error instanceof ConcurrentPromptError
        if (!isConcurrent) {
          clearPromptPending(stoppedState.loopName, deps.logger)
        }
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
        return { ok: false, error: 'Restart failed: could not send prompt to new session.' }
      }

      deps.loopHandler!.startWatchdog(stoppedState.loopName)

      return { ok: true, newSessionId: effectiveSessionId, previousSessionId, sandbox: restartSandbox, bindFailed }
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
