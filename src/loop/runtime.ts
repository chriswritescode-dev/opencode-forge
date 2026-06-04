import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopChangeNotifier } from './service'
import { createLoopService, MAX_RETRIES } from './service'
import { generateUniqueName } from './name-uniqueness'
import type { LoopState } from './state'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo, SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import { createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
import { retryWithModelFallback } from '../utils/model-fallback'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import type { createSandboxManager } from '../sandbox/manager'
// worktree-completion imports moved to hooks/loop.ts (termination side-effects)
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../constants/loop'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
// worktree-cleanup imports moved to hooks/loop.ts (termination side-effects)
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { formatAuditSessionTitle, formatLoopSessionTitle } from '../utils/session-titles'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { markPromptSent, clearPromptPending, sessionsAwaitingBusy, isAwaitingBusy, isAwaitingBusyExpired } from './idle-gate'
import {
  clearPromptInFlight,
  clearPromptInFlightBySession,
  withInFlightGuard,
  ConcurrentPromptError,
} from './in-flight-guard'
import type { TerminationReason } from './termination'
import { terminationStatusFor, terminationReasonToString } from './termination'
import { nextTransition } from './transitions'
import { summarizeAssistantUsage, type UsageAttribution } from './token-usage'
import { loopRegistry } from '../utils/loop-registry'
import { createInterjectionStore, formatInterjections, isLoopGeneratedPrompt } from './interjections'
import { parseCoderDecisions } from '../utils/coder-decisions'

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
  client: PluginInput['client']
  v2Client: OpencodeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  onTerminated?: OnTerminatedCallback
  notify?: LoopChangeNotifier
  loopConfig?: LoopConfig
  sectionPlansRepo?: SectionPlansRepo
  loopSessionUsageRepo?: LoopSessionUsageRepo
}

export interface StartLoopInput {
  state: LoopState
}

export interface Loop {
  tick(event: LoopEvent): Promise<void>
  start(input: StartLoopInput): void
  cancel(name: string): Promise<void>
  inspect(name: string): LoopState | null
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  terminateAll(): Promise<void>
  terminate(name: string, reason: TerminationReason): Promise<boolean>
  cancelBySessionId(sessionId: string): Promise<boolean>
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T>
  clearLoopTimers(name: string): Promise<void>
  clearAllRetryTimeouts(): void
  recordActivity(name: string, source?: string): void
  recordUserMessage(sessionId: string, text: string): boolean
  startWatchdog(name: string): void
  getStallInfo(name: string): LoopWatchdogStallInfo | null
  restart(name: string, params: { newState: LoopState; newSessionId: string }): void
  generateUniqueLoopName(baseName: string): string
  /** Transition a running loop's phase. */
  setPhase(name: string, phase: LoopState['phase']): void

  // State management methods (from LoopService)
  resolveLoopName(sessionId: string): string | null
  getActiveState(name: string): LoopState | null
  getAnyState(name: string): LoopState | null
  setState(name: string, state: LoopState): void
  deleteState(name: string): void
  registerLoopSession(sessionId: string, loopName: string): void
  replaceSession(name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }): void
  setStatus(name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'): void
  setPhaseAndResetError(name: string, phase: LoopState['phase']): void
  setModelFailed(name: string, failed: boolean): void
  setLastAuditResult(name: string, text: string): void
  clearLastAuditResult(name: string): void
  setSandboxContainer(name: string, containerName: string | null): void
  clearWorkspaceId(name: string): void
  setWorkspaceId(name: string, workspaceId: string): void
  incrementError(name: string): number
  resetError(name: string): void
  terminateLoop(name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }): void
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  bumpFindingRecurrence(name: string, findings: ReviewFindingRow[]): void
  resetSectionRecurrence(name: string, sectionIndex: number): void
  getStallTimeoutMs(): number
  getMaxConsecutiveStalls(): number

  // Prompt building methods
  buildContinuationPrompt(state: LoopState, auditFindings?: string): string
  buildAuditPrompt(state: LoopState): string
  buildSectionInitialPrompt(state: LoopState): string
  buildSectionAuditPrompt(state: LoopState): string
  buildSectionContinuationPrompt(state: LoopState, auditText: string): string
  buildFinalAuditPrompt(state: LoopState): string
  buildFinalAuditFixPrompt(state: LoopState, auditText: string): string

  // Plan and section methods
  getPlanText(loopName: string, sessionId: string): string | null
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getNextIncompleteSectionPlan(state: LoopState): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): { index: number; title: string; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }[]
  parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null
  completeSection(loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }): void
  incrementSectionAttempts(loopName: string, index: number): void
  resetSectionForRewind(loopName: string, index: number): void
  setCurrentSectionIndex(loopName: string, index: number): void
  setFinalAuditDone(loopName: string, done: boolean): void
  startSection(loopName: string, index: number): void
  bulkInsertSections(loopName: string, sections: { index: number; title: string; content: string }[]): void
  setTotalSections(loopName: string, total: number): void
}

export function isWorkspaceNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /Workspace not found/i.test(msg)
}

export function createLoop(deps: LoopRuntimeDeps): Loop {
  const { loopsRepo, plansRepo, reviewFindingsRepo, projectId, client, v2Client, logger, getConfig, onTerminated, notify, loopConfig, sectionPlansRepo, loopSessionUsageRepo } = deps
  const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, undefined, sectionPlansRepo)

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryAttempts = new Map<string, number>()
  const stateLocks = new Map<string, Promise<unknown>>()

  const IDLE_RETRY_DELAY_MS = 1500
  const MAX_IDLE_RETRIES = 1
  const MAX_CODE_LAUNCH_RECOVERIES = MAX_RETRIES

  const codingLaunchRecoveryAttempts = new Map<string, number>()
  // Loops currently in "fix → re-final-audit" mode. When a final audit comes back dirty
  // we rotate to a coding session with the findings, then on coding idle we transition
  // straight back to final_auditing (skipping the per-section audit).
  const pendingFinalAuditFix = new Set<string>()
  interface RetainedSessionMeta {
    sessionId: string
    role: 'code' | 'auditor'
    fallbackModel: string | undefined
    directory: string
  }
  const loopRetainedSessions = new Map<string, RetainedSessionMeta[]>()
  const SESSION_RETENTION = 0
  const interjections = createInterjectionStore()

  /**
   * Shared helper: peek pending interjections for a loop, append them to the
   * prompt text, and return a consume function that removes them on success.
   * Every code path that sends a prompt (including retries) MUST use this so
   * interjections are never silently dropped.
   */
  function applyInterjections(loopName: string, promptText: string): { effectivePrompt: string; consume: () => void } {
    const pendingInterjections = interjections.peek(loopName)
    const effectivePrompt = pendingInterjections.length > 0
      ? promptText + formatInterjections(pendingInterjections)
      : promptText
    const consumeInterjections = () => {
      if (pendingInterjections.length > 0) {
        interjections.remove(loopName, pendingInterjections.map(e => e.id))
      }
    }
    return { effectivePrompt, consume: consumeInterjections }
  }

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

  async function sendPromptWithFallback(input: {
    loopName: string
    sessionId: string
    promptText: string
    agent: 'code' | 'auditor-loop'
    model?: { providerID: string; modelID: string } | null
    variant?: string
  }): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }> {
    const { loopName, sessionId, promptText, agent } = input

    const { effectivePrompt, consume: consumeInterjections } = applyInterjections(loopName, promptText)

    if (agent === 'auditor-loop') {
      const auditorModel = input.model != null ? input.model : undefined

      const sendFn = async (model?: { providerID: string; modelID: string }) => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        try {
          return await withInFlightGuard(loopName, sessionId, 'auditor-loop', logger, async () => {
            markPromptSent(loopName, sessionId, logger)
            const result = await promptAuditSessionWithFallback({
              sessionId,
              worktreeDir: freshState.worktreeDir,
              workspaceId: freshState.workspaceId,
              prompt: effectivePrompt,
              ...(model ? { auditorModel: model, ...(input.variant ? { auditorVariant: input.variant } : {}) } : {}),
            })
            return result.ok ? { data: true } : { error: result.error }
          })
        } catch (err) {
          if (err instanceof ConcurrentPromptError) return { error: err }
          throw err
        }
      }

      const { result, usedModel } = await retryWithModelFallback(() => sendFn(auditorModel), () => sendFn(undefined), auditorModel, logger)
      if (result.error) {
        if (result.error instanceof ConcurrentPromptError) {
          return { error: result.error, usedModel }
        }
        clearPromptPending(loopName, logger)
      }
      if (!result.error) consumeInterjections()
      return { error: result.error, usedModel }
    }

    const effectiveModel = input.model != null ? input.model : resolveLoopModel(getConfig(), loopService, loopName)

    const sendFn = async (model?: { providerID: string; modelID: string }) => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) throw new Error('loop_cancelled')
      try {
        return await withInFlightGuard(loopName, sessionId, 'code', logger, async () => {
          markPromptSent(loopName, sessionId, logger)
          return await v2Client.session.promptAsync({
            sessionID: sessionId,
            directory: freshState.worktreeDir,
            ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: effectivePrompt }],
            ...(model ? { model, ...(input.variant ? { variant: input.variant } : {}) } : {}),
          })
        })
      } catch (err) {
        if (err instanceof ConcurrentPromptError) return { error: err }
        throw err
      }
    }

    const { result, usedModel } = await retryWithModelFallback(() => sendFn(effectiveModel), () => sendFn(undefined), effectiveModel, logger)
    if (result.error) {
      if (result.error instanceof ConcurrentPromptError) {
        return { error: result.error, usedModel }
      }
      clearPromptPending(loopName, logger)
    }
    if (!result.error) consumeInterjections()
    return { error: result.error, usedModel }
  }

  async function getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ text: string | null; error: string | null; lastMessageRole: string }> {
    try {
      let messagesResult = await v2Client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
        limit: 4,
      })

      if (messagesResult.error || !messagesResult.data?.length) {
        try {
          logger.log(`Loop: falling back to plugin client for session messages (${sessionId})`)
          const legacyResult = await client.session.messages({
            path: { id: sessionId },
            query: { directory: worktreeDir, limit: 4 },
          })
          if (!legacyResult.error) {
            messagesResult = legacyResult as typeof messagesResult
          }
        } catch (fallbackErr) {
          logger.error(`Loop: plugin client session messages fallback failed for ${sessionId}`, fallbackErr)
        }
      }

      const messages = (messagesResult.data ?? []) as Array<{
        info: { role: string; finish?: string; error?: { name?: string; data?: { message?: string } } }
        parts: Array<{ type: string; text?: string }>
      }>

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null

      if (!lastMessage) {
        return { text: null, error: null, lastMessageRole: 'none' }
      }

      if (lastMessage.info.role !== 'assistant') {
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${lastMessage.info.role ?? 'unknown'}`)
        return { text: null, error: null, lastMessageRole: lastMessage.info.role ?? 'unknown' }
      }

      const lastAssistant = lastMessage
      if (lastAssistant.info.finish && lastAssistant.info.finish !== 'stop') {
        logger.log(`Loop: assistant message in session ${sessionId} is not final yet (finish=${lastAssistant.info.finish})`)
        return { text: null, error: null, lastMessageRole: `assistant:${lastAssistant.info.finish}` }
      }

      const text = lastAssistant.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n') || null

      const error = lastAssistant.info.error?.data?.message ?? lastAssistant.info.error?.name ?? null

      return { text, error, lastMessageRole: 'assistant' }
    } catch (err) {
      logger.error(`Loop: could not read session messages`, err)
      return { text: null, error: null, lastMessageRole: 'error' }
    }
  }

  /**
   * Determine the fallback model for a session based on phase and loop state.
   * For code sessions: state.executionModel > config.executionModel
   * For audit/final-audit sessions: state.auditorModel > state.executionModel > config.auditorModel > config.executionModel
   */
  function getFallbackModelForSession(state: LoopState, phase: LoopState['phase']): string | undefined {
    const config = getConfig()
    if (phase === 'auditing' || phase === 'final_auditing') {
      return (
        state.auditorModel ??
        state.executionModel ??
        config.auditorModel ??
        config.executionModel
      )
    }
    // Code session
    return (
      state.executionModel ??
      config.executionModel
    )
  }

  /**
   * Capture and persist token usage for a loop session.
   * Non-fatal: logs errors but does not block deletion or termination.
   */
  async function captureLoopSessionUsage(input: {
    loopName: string
    sessionId: string
    directory: string
    role: 'code' | 'auditor' | 'unknown'
    fallbackModel?: string
  }): Promise<void> {
    if (!loopSessionUsageRepo) {
      return
    }

    try {
      const messagesResult = await v2Client.session.messages({
        sessionID: input.sessionId,
        directory: input.directory,
      })

      const messages = (messagesResult.data ?? []) as Array<{
        info: {
          role: string
          cost?: number
          tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
          model?: string
          modelID?: string
          modelId?: string
          provider?: string
          providerID?: string
          model_name?: string
        }
      }>

      const attribution: UsageAttribution = {
        role: input.role,
        fallbackModel: input.fallbackModel,
      }

      const usageSummary = summarizeAssistantUsage(messages, attribution)

      if (usageSummary.perModel.length === 0) {
        logger.debug(`Loop: no assistant usage to capture for session ${input.sessionId}`)
        return
      }

      const rows = usageSummary.perModel.map((modelUsage) => ({
        projectId,
        loopName: input.loopName,
        sessionId: input.sessionId,
        role: input.role,
        model: modelUsage.model,
        cost: modelUsage.cost,
        inputTokens: modelUsage.tokens.input,
        outputTokens: modelUsage.tokens.output,
        reasoningTokens: modelUsage.tokens.reasoning,
        cacheReadTokens: modelUsage.tokens.cacheRead,
        cacheWriteTokens: modelUsage.tokens.cacheWrite,
        messageCount: modelUsage.messageCount,
        capturedAt: Date.now(),
      }))

      loopSessionUsageRepo.upsertSessionUsage(rows)
      logger.debug(`Loop: captured usage for session ${input.sessionId} (${input.role})`)
    } catch (err) {
      logger.error(`Loop: failed to capture usage for session ${input.sessionId}`, err)
    }
  }

  function detachFromWorkspace(
    loopName: string,
    state: LoopState,
    context?: string,
  ): void {
    loopService.clearWorkspaceId(loopName)
    state.workspaceId = undefined
    publishWorkspaceDetachedToast({
      v2: v2Client,
      directory: state.projectDir ?? state.worktreeDir,
      loopName,
      logger,
      context,
    })
  }

  async function recoverFromMissingWorkspace(
    loopName: string,
    state: LoopState,
    sessionId: string,
    contextLabel: string,
    bindError?: unknown,
  ): Promise<{ workspaceId?: string; recovered: boolean }> {
    if (!state.workspaceId) {
      return { recovered: false }
    }

    if (bindError && !isWorkspaceNotFoundError(bindError)) {
      logger.log(`Loop: skipping workspace re-provision for ${loopName} because bind error is not "workspace not found"`)
      return { recovered: false }
    }

    detachFromWorkspace(loopName, state, contextLabel)

    const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
    const projectDirectory = state.projectDir ?? state.worktreeDir
    if (!projectDirectory) {
      logger.log(`Loop: cannot recover workspace for ${loopName}: no projectDir/worktreeDir`)
      return { recovered: false }
    }
    const newWorkspace = await createBuiltinWorktreeWorkspace(
      v2Client,
      {
        loopName,
        directory: projectDirectory,
      },
      logger,
    )

    if (!newWorkspace) {
      logger.error(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      return { recovered: false }
    }

    try {
      await bindSessionToWorkspace(v2Client, newWorkspace.workspaceId, sessionId, logger, { loopName })
      loopService.setWorkspaceId(loopName, newWorkspace.workspaceId)
      state.workspaceId = newWorkspace.workspaceId
      if (newWorkspace.directory) state.worktreeDir = newWorkspace.directory
      if (newWorkspace.branch) state.worktreeBranch = newWorkspace.branch
      logger.log(`Loop: re-provisioned workspace ${newWorkspace.workspaceId} for ${loopName} after stale id`)
      return { workspaceId: newWorkspace.workspaceId, recovered: true }
    } catch (err) {
      logger.error(`Loop: failed to bind session to re-provisioned workspace ${newWorkspace.workspaceId}`, err)
      return { recovered: false }
    }
  }

  async function ensureWorkspaceForLoop(
    loopName: string,
    state: LoopState,
    contextLabel: string,
  ): Promise<{ workspaceId?: string }> {
    if (state.workspaceId) {
      return { workspaceId: state.workspaceId }
    }

    if (!state.worktree) {
      return {}
    }

    const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
    const projectDirectory = state.projectDir ?? state.worktreeDir
    if (!projectDirectory) {
      logger.log(`Loop: cannot provision workspace for ${loopName} (${contextLabel}): no projectDir/worktreeDir`)
      return {}
    }
    const workspace = await createBuiltinWorktreeWorkspace(
      v2Client,
      {
        loopName,
        directory: projectDirectory,
      },
      logger,
    )

    if (!workspace) {
      logger.log(`Loop: workspace creation failed for ${loopName} (${contextLabel}), continuing without workspace backing`)
      return {}
    }

    loopService.setWorkspaceId(loopName, workspace.workspaceId)
    state.workspaceId = workspace.workspaceId
    if (workspace.directory) state.worktreeDir = workspace.directory
    if (workspace.branch) state.worktreeBranch = workspace.branch
    logger.log(`Loop: provisioned workspace ${workspace.workspaceId} for ${loopName} (${contextLabel})`)
    return { workspaceId: workspace.workspaceId }
  }

  /**
   * Rotates to a new session in the same workspace. Creates and binds the new session FIRST,
   * then fire-and-forget deletes the old session. This ordering ensures the workspace always
   * has at least one bound session, preventing the host from pruning it from non-focused TUIs.
   */
  async function rotateSession(
    loopName: string,
    state: LoopState,
    titleContext?: { iteration?: number; currentSectionIndex?: number },
  ): Promise<string> {
    const oldSessionId = state.sessionId
    const sessionDir = state.worktreeDir

    clearPromptPending(loopName, logger)

    logger.log(
      `Loop: [perm-diag] rotate loop=${loopName} state.worktree=${String(state.worktree)} state.sandbox=${String(state.sandbox)}`
    )

    const permissionRuleset = buildLoopPermissionRuleset({ sandbox: state.sandbox ?? false })

    const ensured = await ensureWorkspaceForLoop(loopName, state, 'during session rotation')

    const createResult = await createLoopSessionWithWorkspace({
      v2: v2Client,
      title: formatLoopSessionTitle(state.loopName, {
        iteration: titleContext?.iteration ?? state.iteration ?? 0,
        currentSectionIndex: titleContext?.currentSectionIndex ?? state.currentSectionIndex ?? 0,
        totalSections: state.totalSections ?? 0,
      }),
      directory: sessionDir,
      permission: permissionRuleset,
      workspaceId: ensured.workspaceId ?? state.workspaceId,
      loopName: loopName,
      logPrefix: 'Loop',
      logger,
    })

    if (!createResult) {
      throw new Error('Failed to create new session.')
    }

    const newSessionId = createResult.sessionId

    if (createResult.bindFailed) {
      detachFromWorkspace(loopName, state, 'during session rotation')
    }

    const oldRetryTimeout = retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(loopName)
    }

    loopService.registerLoopSession(newSessionId, loopName)

    watchdog.stop(loopName)
    watchdog.start(loopName)

    void scheduleSessionDelete({ loopName, sessionId: oldSessionId, directory: sessionDir, context: 'after session rotation', phase: state.phase, state })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    return newSessionId
  }

  /**
   * Shared: handle assistant error detection and model failure.
   * Returns null if the loop was terminated (caller should return).
   * Returns updated { assistantErrorDetected, currentState }.
   */
  async function detectAndHandleAssistantError(
    loopName: string,
    currentState: LoopState,
    assistantError: string | null,
    phase: string,
  ): Promise<{ assistantErrorDetected: boolean; currentState: LoopState } | null> {
    if (!assistantError) {
      return { assistantErrorDetected: false, currentState }
    }

    logger.error(`Loop: assistant error detected in ${phase} phase: ${assistantError}`)
    const isModelError = /provider|auth|model|api\s*error/i.test(assistantError)
    if (isModelError) {
      const nextErrorCount = loopService.incrementError(loopName)
      if (nextErrorCount >= MAX_RETRIES) {
        await terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: `assistant error: ${assistantError}` })
        return null
      }
      loopService.setModelFailed(loopName, true)
      logger.log(`Loop: marking model as failed, will fall back to default model (error ${nextErrorCount}/${MAX_RETRIES})`)
      return { assistantErrorDetected: true, currentState: loopService.getActiveState(loopName)! }
    }

    return { assistantErrorDetected: true, currentState }
  }

  /**
   * Shared: check audit clear and terminate if ready.
   * Returns true if the loop was terminated (caller should return).
   */
  async function checkAuditClearAndTerminate(
    loopName: string,
    currentState: LoopState,
  ): Promise<boolean> {
    logger.debug(`Loop: checking audit clear loop=${loopName} auditCount=${currentState.auditCount ?? 0} loopName=${currentState.loopName ?? '(none)'}`)
    if ((currentState.auditCount ?? 0) < 1) {
      logger.debug(`Loop: audit clear gate blocked by auditCount<1`)
      return false
    }
    // For sectioned loops, require finalAuditDone === true before terminating
    if (currentState.totalSections > 0 && !currentState.finalAuditDone) {
      logger.debug(`Loop: audit clear gate blocked for sectioned loop — finalAuditDone=false`)
      return false
    }
    const findings = loopService.getOutstandingFindings(currentState.loopName)
    if (findings.length > 0) {
      logger.log(`Loop: audit complete but ${findings.length} review finding(s) remain, continuing`)
      return false
    }
    const bugFindings = loopService.getOutstandingFindings(currentState.loopName, 'bug')
    if (bugFindings.length > 0) {
      logger.log(`Loop: refused completion — ${bugFindings.length} bug finding(s) still open`)
      return false
    }
    logger.log(`Loop: audit all-clear, terminating loop=${loopName} iteration=${currentState.iteration} audits=${currentState.auditCount ?? 0}`)
    await terminateLoop(loopName, currentState, { kind: 'completed' })
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Shared: reset error count after a successful (non-error) iteration.
   */
  function resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.resetError(loopName)
      loopService.setModelFailed(loopName, false)
      logger.log(`Loop: resetting error count after successful retry in ${phase} phase`)
      return loopService.getActiveState(loopName)!
    }
    return currentState
  }

  /**
   * Shared: rotate session and send continuation prompt with model fallback.
   */
  async function rotateAndSendContinuation(
    loopName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
  ): Promise<void> {
    let activeSessionId = currentState.sessionId
    try {
      activeSessionId = await rotateSession(loopName, currentState, {
        iteration: stateUpdates.iteration ?? currentState.iteration,
        currentSectionIndex: stateUpdates.currentSectionIndex ?? currentState.currentSectionIndex,
      })
    } catch (err) {
      logger.error(`Loop: session rotation failed, continuing with existing session`, err)
    }

    loopService.replaceSession(loopName, {
      newSessionId: activeSessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError: !assistantErrorDetected && currentState.errorCount > 0,
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
    })

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, loopService, loopName)
    if (!loopModel) {
      logger.log(`Loop: configured model previously failed, using default model`)
    }

    const { error: promptResultError, usedModel: actualModel } = await sendPromptWithFallback({
      loopName,
      sessionId: activeSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: currentState.executionVariant,
    })

    if (promptResultError) {
      const retryFn = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        const { effectivePrompt: retryPrompt, consume: consumeRetryInterjections } = applyInterjections(loopName, continuationPrompt)
        try {
          await withInFlightGuard(loopName, activeSessionId, 'code', logger, async () => {
            const result = await v2Client.session.promptAsync({
              sessionID: activeSessionId,
              directory: freshState.worktreeDir,
              ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
              agent: 'code',
              parts: [{ type: 'text' as const, text: retryPrompt }],
            })
            if (result.error) {
              await handlePromptError(loopName, currentState, `retry failed ${errorContext}`, result.error)
              return
            }
            consumeRetryInterjections()
          })
        } catch (err) {
          if (err instanceof ConcurrentPromptError) { logger.log(`Loop: ${errorContext} — retry rejected as concurrent prompt (prior guard active), skipping`); return }
          throw err
        }
      }
      await handlePromptError(loopName, currentState, `failed to send continuation prompt ${errorContext}`, promptResultError, retryFn)
      return
    }
    if (actualModel) {
      logger.log(`${errorContext} using model: ${actualModel.providerID}/${actualModel.modelID}`)
    } else {
      logger.log(`${errorContext} using default model (fallback)`)
    }

    watchdog.recordActivity(loopName, 'phase-activity')
  }

  async function rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string): Promise<void> {
    const newSessionId = await rotateSession(loopName, state)

    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
    })
    loopService.setLastAuditResult(loopName, state.lastAuditResult ?? '')
    const isModelError = /provider|auth|model|api\s*error/i.test(reason)
    if (isModelError) {
      loopService.setModelFailed(loopName, true)
    }
    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...state, iteration: state.iteration ?? 0 },
      `\n[Auditor session failed: ${reason}. Continuing without new findings.]`,
    )

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const { error } = await sendPromptWithFallback({
      loopName,
      sessionId: newSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: state.executionVariant,
    })
    if (error) {
      logger.error(`rotateToCodingAfterAuditFailure: failed to send continuation prompt`, error)
    }
  }

  function buildCodingPromptForCurrentState(state: LoopState): string {
    if (pendingFinalAuditFix.has(state.loopName)) {
      return loopService.buildFinalAuditFixPrompt(state, state.lastAuditResult || '')
    }
    if (state.totalSections > 0) {
      if (state.lastAuditResult) {
        return loopService.buildSectionContinuationPrompt(state, state.lastAuditResult)
      }
      return loopService.buildSectionInitialPrompt(state)
    }
    return loopService.buildContinuationPrompt(state, state.lastAuditResult || undefined)
  }

  async function recoverCodeLaunchWithoutAssistant(loopName: string, state: LoopState, lastMessageRole: string): Promise<void> {
    const attempts = (codingLaunchRecoveryAttempts.get(loopName) ?? 0) + 1
    codingLaunchRecoveryAttempts.set(loopName, attempts)

    if (attempts > MAX_CODE_LAUNCH_RECOVERIES) {
      logger.error(`Loop: coding launch failed after ${attempts} no-assistant idle events for ${loopName} (last=${lastMessageRole})`)
      await terminateLoop(loopName, state, { kind: 'coding_no_assistant' })
      return
    }

    const recoveryPrompt = buildCodingPromptForCurrentState(state)
    logger.log(`Loop: recovering code launch for ${loopName} (attempt ${attempts}/${MAX_CODE_LAUNCH_RECOVERIES}, last=${lastMessageRole})`)

    const codeSessionId = state.sessionId

    try {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active || freshState.phase !== 'coding' || freshState.sessionId !== codeSessionId) return

      const currentConfig = getConfig()
      const { error: promptResultError } = await sendPromptWithFallback({
        loopName,
        sessionId: codeSessionId,
        promptText: recoveryPrompt,
        agent: 'code',
        model: resolveLoopModel(currentConfig, loopService, loopName),
        variant: freshState.executionVariant,
      })
      if (promptResultError) {
        clearPromptPending(loopName, logger)
        logger.error(`Loop: failed to send recovery prompt for ${loopName}`, promptResultError)
        const retryFn = async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== 'coding' || fresh.sessionId !== codeSessionId) throw new Error('loop_cancelled')
          const { effectivePrompt: retryPrompt, consume: consumeRetryInterjections } = applyInterjections(loopName, recoveryPrompt)
          try {
            await withInFlightGuard(loopName, codeSessionId, 'code', logger, async () => {
              const result = await v2Client.session.promptAsync({
                sessionID: codeSessionId,
                directory: fresh.worktreeDir,
                ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
                agent: 'code',
                parts: [{ type: 'text' as const, text: retryPrompt }],
              })
              if (result.error) throw result.error
              consumeRetryInterjections()
            })
          } catch (err) {
            if (err instanceof ConcurrentPromptError) { logger.log('Loop: failed to recover code launch — retry rejected as concurrent prompt (prior guard active), skipping'); return }
            throw err
          }
        }
        await handlePromptError(loopName, freshState ?? state, 'failed to recover code launch', promptResultError, retryFn)
      }
    } catch (err) {
      logger.error(`Loop: failed to recover code launch for ${loopName}`, err)
      await handlePromptError(loopName, state, 'failed to recover code launch', err)
    }
  }

  async function scheduleSessionDelete(input: {
    loopName: string
    sessionId: string
    directory: string
    context: string
    phase?: LoopState['phase']
    state?: LoopState
  }): Promise<void> {
    const { loopName, sessionId, directory, context, phase, state } = input
    const queue = loopRetainedSessions.get(loopName) ?? []
    
    // Check if already queued by sessionId
    if (queue.some(entry => entry.sessionId === sessionId)) return
    
    // Determine role and fallback model at queue time
    const role: 'code' | 'auditor' = phase && (phase === 'auditing' || phase === 'final_auditing') ? 'auditor' : 'code'
    const fallbackModel = phase && state ? getFallbackModelForSession(state, phase) : undefined
    
    queue.push({ sessionId, role, fallbackModel, directory })
    loopRetainedSessions.set(loopName, queue)
    logger.debug(`Loop: queued session ${sessionId} for retention (loop=${loopName}, context=${context}, queue=${queue.length})`)

    while (queue.length > SESSION_RETENTION) {
      const oldest = queue.shift()!
      logger.log(`Loop: trimming session ${oldest.sessionId} (loop=${loopName}, retention=${SESSION_RETENTION})`)
      
      // Capture usage before deletion using stored metadata
      await captureLoopSessionUsage({
        loopName,
        sessionId: oldest.sessionId,
        directory: oldest.directory,
        role: oldest.role,
        fallbackModel: oldest.fallbackModel,
      })
      
      void v2Client.session.delete({ sessionID: oldest.sessionId, directory: oldest.directory }).catch((err: unknown) => {
        logger.error(`Loop: failed to delete trimmed session ${oldest.sessionId} (loop=${loopName})`, err)
      })
    }
  }

  async function terminateLoop(loopName: string, state: LoopState, reason: TerminationReason): Promise<void> {
    const sessionId = state.sessionId
    watchdog.stop(loopName)
    loopRegistry.remove(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)
    codingLaunchRecoveryAttempts.delete(loopName)
    pendingFinalAuditFix.delete(loopName)
    interjections.clear(loopName)
    clearPromptPending(loopName, logger)
    clearPromptInFlight(loopName)

    const retained = loopRetainedSessions.get(loopName)
    if (retained) {
      // Capture usage for retained sessions before deletion using stored metadata
      for (const entry of retained) {
        if (entry.sessionId === sessionId) continue
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
        }).catch((err: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on terminate (loop=${loopName})`, err)
        })
        void v2Client.session.delete({ sessionID: entry.sessionId, directory: entry.directory }).catch((err: unknown) => {
          logger.error(`Loop: failed to delete retained session ${entry.sessionId} on terminate (loop=${loopName})`, err)
        })
      }
      loopRetainedSessions.delete(loopName)
    }

    // Capture usage for the final active session before termination
    const fallbackModel = getFallbackModelForSession(state, state.phase)
    const role: 'code' | 'auditor' = state.phase === 'auditing' || state.phase === 'final_auditing' ? 'auditor' : 'code'
    await captureLoopSessionUsage({
      loopName,
      sessionId: state.sessionId,
      directory: state.worktreeDir,
      role,
      fallbackModel,
    })

    const now = Date.now()
    loopService.terminate(loopName, {
      status: terminationStatusFor(reason),
      reason: terminationReasonToString(reason),
      completedAt: now,
    })

    try {
      await v2Client.session.abort({ sessionID: sessionId })
    } catch {
      // Session may already be idle
    }

    logger.log(`Loop terminated: reason="${terminationReasonToString(reason)}", loop="${state.loopName}", iteration=${state.iteration}`)

    logger.debug(`Loop: terminateLoop reason=${terminationReasonToString(reason)} worktree=${!!state.worktree} logEligible=${reason.kind === 'completed' && !!state.worktree}`)

    // Delegate host-specific side-effects to the provided callback.
    // This keeps worktree teardown, completion log, sandbox stop, TUI toast outside the core module.
    if (onTerminated) {
      await onTerminated(state, reason)
    }
  }

  async function handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
    if (err instanceof ConcurrentPromptError) {
      logger.log(`Loop: ${context} — rejected as concurrent prompt (prior guard active), skipping retry/termination`)
      return
    }

    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} already terminated, ignoring error: ${context}`)
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1
    
    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, err)
      loopService.incrementError(loopName)
      if (retryFn) {
        const retryTimeout = setTimeout(async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) {
            logger.log(`Loop: loop cancelled, skipping retry`)
            retryTimeouts.delete(loopName)
            return
          }
          try {
            await retryFn()
          } catch (retryErr) {
            await handlePromptError(loopName, freshState, context, retryErr, retryFn)
          }
        }, 2000)
        retryTimeouts.set(loopName, retryTimeout)
      }
    } else {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, err)
      await terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: context })
    }
  }

  async function createAuditSessionWithFallback(input: {
    loopName: string
    iteration: number
    currentSectionIndex: number
    totalSections: number
    worktreeDir: string
    workspaceId?: string
    isSandbox: boolean
    auditorModel?: { providerID: string; modelID: string }
    prompt: string
  }): Promise<{ auditSessionId: string; boundWorkspaceId?: string; bindFailed: boolean; bindError?: unknown } | null> {
    const created = await createAuditSession({
      v2: v2Client,
      loopName: input.loopName,
      iteration: input.iteration,
      currentSectionIndex: input.currentSectionIndex,
      totalSections: input.totalSections,
      worktreeDir: input.worktreeDir,
      workspaceId: input.workspaceId,
      isSandbox: input.isSandbox,
      auditorModel: input.auditorModel,
      prompt: input.prompt,
      logger,
    })
    if (created) {
      return {
        auditSessionId: created.auditSessionId,
        boundWorkspaceId: created.boundWorkspaceId,
        bindFailed: created.bindFailed,
        bindError: created.bindError,
      }
    }

    try {
      logger.log(`Loop: falling back to plugin client for audit session creation (${input.loopName})`)
      const result = await client.session.create({
        body: {
          title: formatAuditSessionTitle(input.loopName, {
            iteration: input.iteration,
            currentSectionIndex: input.currentSectionIndex,
            totalSections: input.totalSections,
          }),
          permission: buildAuditSessionPermissionRuleset({ sandbox: input.isSandbox }),
          ...(input.workspaceId ? { workspaceID: input.workspaceId } : {}),
        },
        query: {
          directory: input.worktreeDir,
          ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
        },
      } as Parameters<typeof client.session.create>[0])
      const session = result.data as { id?: string } | undefined
      if (!session?.id) return null
      return { auditSessionId: session.id, bindFailed: false }
    } catch (err) {
      logger.error(`Loop: plugin client audit session creation failed`, err)
      return null
    }
  }

  async function promptAuditSessionWithFallback(input: {
    sessionId: string
    worktreeDir: string
    workspaceId?: string
    prompt: string
    auditorModel?: { providerID: string; modelID: string }
    auditorVariant?: string
  }): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const result = await promptAuditSession(v2Client, input)
    if (result.ok) return result

    try {
      logger.log(`Loop: falling back to plugin client for audit prompt (${input.sessionId})`)
      const legacyResult = await client.session.promptAsync({
        path: { id: input.sessionId },
        query: { directory: input.worktreeDir, ...(input.workspaceId ? { workspace: input.workspaceId } : {}) },
        body: {
          agent: 'auditor-loop',
          parts: [{ type: 'text' as const, text: input.prompt }],
          ...(input.auditorModel ? { model: input.auditorModel, ...(input.auditorVariant ? { variant: input.auditorVariant } : {}) } : {}),
        },
      })
      if (legacyResult.error) return { ok: false, error: legacyResult.error }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err }
    }
  }

  async function recoverWatchdogStall(
    loopName: string,
    _state: LoopState,
    context: LoopWatchdogRecoveryContext,
  ): Promise<void> {
    await withStateLock(loopName, async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) return

      try {
        if (freshState.phase === 'auditing') {
          await runAuditingPhase(loopName, freshState)
        } else if (freshState.phase === 'final_auditing') {
          await runFinalAuditPhase(loopName, freshState)
        } else {
          await runCodingPhase(loopName, freshState)
        }
      } catch (err) {
        await handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase (${context.reason})`, err)
      }
    })
  }

  const watchdog = createLoopWatchdog({
    loopService,
    v2Client,
    logger,
    recover: recoverWatchdogStall,
    terminate: terminateLoop,
  })

  async function startFinalAuditTransition(loopName: string, currentState: LoopState): Promise<boolean> {
    const finalAuditState = loopService.getActiveState(loopName) ?? { ...currentState, phase: 'final_auditing' }
    const finalAuditPrompt = loopService.buildFinalAuditPrompt(finalAuditState)
    const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName, logger)

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before final audit creation')
    const created = await createAuditSessionWithFallback({
      loopName,
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      isSandbox: currentState.sandbox ?? false,
      auditorModel,
      prompt: finalAuditPrompt,
    })
    if (!created) {
      logger.error(`Loop: final audit session creation failed for ${loopName}`)
      await handlePromptError(loopName, finalAuditState, 'failed to create final audit session', new Error('audit session creation failed'))
      return false
    }

    loopService.setPhaseAndResetError(loopName, 'final_auditing')

    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'final_auditing',
    })

    // The retired session is a code session (pre-final-audit)
    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after final audit creation', phase: 'coding', state: currentState })

    const { error: finalAuditPromptErr } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: finalAuditPrompt,
      agent: 'auditor-loop',
      model: auditorModel,
      variant: currentState.auditorVariant,
    })

    if (finalAuditPromptErr) {
      logger.error(`Loop: failed to send final audit prompt for ${loopName}`, finalAuditPromptErr)
      await handlePromptError(loopName, finalAuditState, 'failed to send final audit prompt', finalAuditPromptErr)
      return false
    }
    watchdog.recordActivity(loopName, 'final-audit-prompt-sent')
    return true
  }

  async function runCodingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping coding phase`)
      return
    }

    if (currentState.phase !== 'coding') {
      logger.log(`Loop: runCodingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
    const assistantError = assistantInfo.error
    const lastMessageRole = assistantInfo.lastMessageRole
    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts < MAX_IDLE_RETRIES) {
        logger.log(`Loop: coding idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
        idleRetryAttempts.set(loopName, attempts + 1)
        const sessionId = currentState.sessionId
        const t = setTimeout(async () => {
          idleRetryTimeouts.delete(loopName)
          await withStateLock(loopName, async () => {
            const retryState = loopService.getActiveState(loopName)
            if (!retryState?.active || retryState.phase !== 'coding' || retryState.sessionId !== sessionId) return
            await runCodingPhase(loopName, retryState)
          })
        }, IDLE_RETRY_DELAY_MS)
        idleRetryTimeouts.set(loopName, t)
        return
      }

      logger.log(`Loop: coding phase has no assistant response for ${loopName} after retry (last message: ${lastMessageRole}); recovering code launch`)
      idleRetryAttempts.delete(loopName)
      await recoverCodeLaunchWithoutAssistant(loopName, currentState, lastMessageRole)
      return
    }

    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }
    codingLaunchRecoveryAttempts.delete(loopName)

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'coding')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')

    // Parse coder decisions from the coding assistant's response and store for the audit prompt.
    // This must happen before the pendingFinalAuditFix early return so that decisions emitted
    // during a final-audit fix coding session reach the subsequent final audit prompt.
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    // If this coding pass was a final-audit fix, skip the per-section audit and
    // transition straight back to final_auditing.
    if (pendingFinalAuditFix.has(loopName)) {
      pendingFinalAuditFix.delete(loopName)
      logger.log(`Loop: final-audit fix coding complete for ${loopName}, transitioning back to final_auditing`)
      const started = await startFinalAuditTransition(loopName, currentState)
      if (!started) {
        logger.error(`Loop: failed to restart final audit after fix for ${loopName}`)
      }
      return
    }

    const currentConfig = getConfig()
    const auditorModel = resolveLoopAuditorModel(currentConfig, loopService, loopName, logger)
    const auditPrompt = loopService.buildAuditPrompt(currentState)
    const codeSessionId = currentState.sessionId

    async function createAuditWithRetry(input: {
      loopName: string
      iteration: number
      currentSectionIndex: number
      totalSections: number
      worktreeDir: string
      workspaceId?: string
      isSandbox: boolean
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
    }, attempts = MAX_RETRIES): Promise<{ auditSessionId: string; boundWorkspaceId?: string; bindFailed: boolean; bindError?: unknown } | null> {
      for (let i = 0; i < attempts; i++) {
        const created = await createAuditSessionWithFallback(input)
        if (created) return created
        loopService.incrementError(loopName)
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return null
        if ((state.errorCount ?? 0) >= MAX_RETRIES) return null
        await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      }
      return null
    }

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before audit creation')
    const created = await createAuditWithRetry({
      loopName,
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      isSandbox: currentState.sandbox ?? false,
      auditorModel,
      prompt: auditPrompt,
    })

    if (!created) {
      logger.error(`Loop: audit session creation failed after ${MAX_RETRIES} attempts for ${loopName}, rotating to fresh code session`)
      try {
        const rotatedSessionId = await rotateSession(loopName, currentState)
        loopService.replaceSession(loopName, {
          newSessionId: rotatedSessionId,
          phase: 'coding',
          resetError: false,
        })
        const continuationPrompt = loopService.buildContinuationPrompt(
          { ...currentState, iteration: currentState.iteration ?? 0 },
          'Audit could not be started after retries — continue iterating, the auditor will be reattempted next round.',
        )
        const { error: promptErr } = await sendPromptWithFallback({
          loopName,
          sessionId: rotatedSessionId,
          promptText: continuationPrompt,
          agent: 'code',
          variant: currentState.executionVariant,
        })
        if (promptErr) {
          logger.error(`Loop: failed to send continuation prompt after audit creation failure`, promptErr)
        }
        return
      } catch (err) {
        logger.error(`Loop: failed to rotate after audit creation failure`, err)
        await handlePromptError(loopName, currentState, 'failed to rotate after audit creation failure', err)
        return
      }
    }

    if (created.bindFailed && currentState.workspaceId) {
      const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit bind', created.bindError)
      currentState = loopService.getActiveState(loopName) ?? currentState
      if (!recovered.recovered) {
        logger.log(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      }
    }

    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })

    // The retired session is a code session
    void scheduleSessionDelete({ loopName, sessionId: codeSessionId, directory: currentState.worktreeDir, context: 'after audit creation', phase: 'coding', state: currentState })

    const { error: auditPromptErr, usedModel: actualAuditorModel } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: loopService.buildAuditPrompt(currentState),
      agent: 'auditor-loop',
      model: auditorModel,
      variant: currentState.auditorVariant,
    })

    if (auditPromptErr) {
      if (isWorkspaceNotFoundError(auditPromptErr) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const auditPromptText = loopService.buildAuditPrompt(currentState)
          const { effectivePrompt: retryPrompt, consume: consumeRetryInterjections } = applyInterjections(loopName, auditPromptText)
          const retryResult = await promptAuditSessionWithFallback({
            sessionId: created.auditSessionId,
            worktreeDir: currentState.worktreeDir,
            workspaceId: currentState.workspaceId,
            prompt: retryPrompt,
            auditorModel,
            auditorVariant: currentState.auditorVariant,
          })
          if (retryResult.ok) {
            consumeRetryInterjections()
            logger.log(`Loop: recovered audit prompt after workspace re-bind for ${loopName}`)
            watchdog.recordActivity(loopName, 'audit-recover')
            return
          }
        }
      }
      const retryFn = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        const auditPromptText = loopService.buildAuditPrompt(fresh)
        const { effectivePrompt: retryPrompt, consume: consumeRetryInterjections } = applyInterjections(loopName, auditPromptText)
        try {
          await withInFlightGuard(loopName, created.auditSessionId, 'auditor-loop', logger, async () => {
            const retryResult = await promptAuditSessionWithFallback({
              sessionId: created.auditSessionId,
              worktreeDir: fresh.worktreeDir,
              workspaceId: fresh.workspaceId,
              prompt: retryPrompt,
              auditorModel,
              auditorVariant: fresh.auditorVariant,
            })
            if (!retryResult.ok) throw retryResult.error
            consumeRetryInterjections()
          })
        } catch (err) {
          if (err instanceof ConcurrentPromptError) { logger.log('Loop: failed to send audit prompt — retry rejected as concurrent prompt (prior guard active), skipping'); return }
          throw err
        }
      }
      await handlePromptError(loopName, { ...currentState, phase: 'auditing' }, 'failed to send audit prompt', auditPromptErr, retryFn)
      return
    }
    if (actualAuditorModel) {
      logger.log(`auditor using model: ${actualAuditorModel.providerID}/${actualAuditorModel.modelID} (session ${created.auditSessionId})`)
    } else {
      logger.log(`auditor using default model (fallback) (session ${created.auditSessionId})`)
    }

    watchdog.recordActivity(loopName, 'audit-created')
  }

  async function runAuditingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping auditing phase`)
      return
    }

    if (currentState.phase !== 'auditing') {
      logger.log(`Loop: runAuditingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in auditing phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: auditing phase retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, { kind: 'audit_retry_exhausted' })
        return
      }
      logger.log(`Loop: auditing idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      idleRetryAttempts.set(loopName, attempts + 1)
      const t = setTimeout(() => {
        void withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== 'auditing') return
          await runAuditingPhase(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      idleRetryTimeouts.set(loopName, t)
      return
    }
    
    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing')
    if (!errorResult) {
      return
    }
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    if (!assistantErrorDetected) {
      const newAuditCount = (currentState.auditCount ?? 0) + 1
      logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

      if (currentState.totalSections > 0) {
        const idx = currentState.currentSectionIndex
        const sectionSummary = loopService.parseSectionSummary(auditText || '')
        const sectionAllBugFindings = loopService.getOutstandingFindings(loopName, 'bug')
        const sectionBugFindings = sectionAllBugFindings.filter(f => f.sectionIndex === idx)

        if (sectionSummary && sectionBugFindings.length === 0) {
          logger.log(`Loop: section ${idx} audit clean, marking completed`)

          // Reset recurrence for this section so resolved findings don't falsely escalate later
          loopService.resetSectionRecurrence(loopName, idx)

          loopService.setLastAuditResult(loopName, auditText || '')
          loopService.completeSection(loopName, idx, sectionSummary)

          if (idx < currentState.totalSections - 1) {
            const allCompleted = loopService.getCompletedSectionDigest(currentState).length === currentState.totalSections
            if (allCompleted) {
              logger.log(`Loop: all ${currentState.totalSections} sections completed after rewind, jumping straight to final audit`)
              await startFinalAuditTransition(loopName, currentState)
              return
            }
          }

          const nextIdx = idx + 1
          if (nextIdx < currentState.totalSections) {
            const nextIter = (currentState.iteration ?? 0) + 1
            if ((currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations) {
              logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
              await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
              return
            }
            logger.log(`Loop: advancing from section ${idx} to section ${nextIdx}`)
            loopService.setCurrentSectionIndex(loopName, nextIdx)
            loopService.startSection(loopName, nextIdx)

            loopService.replaceSession(loopName, {
              newSessionId: currentState.sessionId,
              phase: 'coding',
              iteration: nextIter,
            })

            const updatedState = loopService.getActiveState(loopName) ?? { ...currentState, currentSectionIndex: nextIdx }
            const continuationPrompt = loopService.buildSectionInitialPrompt(updatedState)
            await rotateAndSendContinuation(
              loopName,
              currentState,
              {
                iteration: nextIter,
                currentSectionIndex: nextIdx,
                phase: 'coding',
                lastAuditResult: auditText || undefined,
                auditCount: newAuditCount,
              },
              continuationPrompt,
              assistantErrorDetected,
              'section coding continuation',
            )
            return
          } else {
            logger.log(`Loop: all ${currentState.totalSections} sections completed, transitioning to final-audit`)
            await startFinalAuditTransition(loopName, currentState)
            return
          }
        }

        logger.log(`Loop: section ${idx} audit dirty, retrying same section`)

        const nextIter = (currentState.iteration ?? 0) + 1
        if ((currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations) {
          logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
          await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
          return
        }

        loopService.incrementSectionAttempts(loopName, idx)

        loopService.bumpFindingRecurrence(loopName, sectionBugFindings)

        loopService.setLastAuditResult(loopName, auditText || '')
        loopService.replaceSession(loopName, {
          newSessionId: currentState.sessionId,
          phase: 'coding',
          iteration: nextIter,
        })

        const continuationPrompt = loopService.buildSectionContinuationPrompt(currentState, auditText || '', sectionAllBugFindings)
        await rotateAndSendContinuation(
          loopName,
          currentState,
          {
            iteration: nextIter,
            phase: 'coding',
            lastAuditResult: auditText || undefined,
            auditCount: newAuditCount,
          },
          continuationPrompt,
          assistantErrorDetected,
          'section retry continuation',
        )
        return
      }

      const candidateState = { ...currentState, auditCount: newAuditCount }
      if (await checkAuditClearAndTerminate(loopName, candidateState)) return

      const nextIteration = (currentState.iteration ?? 0) + 1
      if ((currentState.maxIterations ?? 0) > 0 && nextIteration > (currentState.maxIterations ?? 0)) {
        await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
        return
      }

      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      loopService.bumpFindingRecurrence(loopName, outstandingBugs)

      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
        outstandingBugs,
      )

      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: newAuditCount,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    } else {
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      const nextIteration = (currentState.iteration ?? 0) + 1
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )
      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: currentState.auditCount ?? 0,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    }
  }

  async function runFinalAuditPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping final audit phase`)
      return
    }

    if (currentState.phase !== 'final_auditing') {
      logger.log(`Loop: runFinalAuditPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final audit phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: final audit phase retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, { kind: 'final_audit_retry_exhausted' })
        return
      }
      logger.log(`Loop: final audit idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      idleRetryAttempts.set(loopName, attempts + 1)
      const t = setTimeout(() => {
        void withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== 'final_auditing') return
          await runFinalAuditPhase(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      idleRetryTimeouts.set(loopName, t)
      return
    }

    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'final_auditing')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'final_auditing')

    if (!assistantErrorDetected) {
      const hasOutstandingBugs = loopService.hasOutstandingFindings(loopName, 'bug')

      const trans = nextTransition(currentState, { type: hasOutstandingBugs ? 'final-audit-dirty' : 'final-audit-clean' })
      if (trans.kind === 'terminate') {
        logger.log(`Loop: final audit clean for ${loopName} (no outstanding bug findings), completing`)
        loopService.setFinalAuditDone(loopName, true)
        await terminateLoop(loopName, currentState, trans.reason)
        return
      }

      // Dirty final audit: rotate to a coding session that fixes the findings,
      // then on coding idle return straight to final_auditing (no section rewind).
      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      logger.log(`Loop: final audit dirty (${outstandingBugs.length} outstanding bug findings), rotating to coding for fix for ${loopName}`)

      const nextIter = (currentState.iteration ?? 0) + 1
      if ((currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations) {
        logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
        await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
        return
      }

      // Persist the audit text so recovery paths can rebuild the fix prompt if needed.
      if (auditText) loopService.setLastAuditResult(loopName, auditText)

      // Bump recurrence counts for outstanding bugs so escalation surfaces after N consecutive final-audit dirty cycles.
      loopService.bumpFindingRecurrence(loopName, outstandingBugs)

      const fixPrompt = loopService.buildFinalAuditFixPrompt(currentState, auditText || '', outstandingBugs)

      let newCodeSessionId: string
      try {
        newCodeSessionId = await rotateSession(loopName, currentState, {
          iteration: nextIter,
        })
      } catch (err) {
        logger.error(`Loop: session rotation failed during final audit fix, aborting rotation`, err)
        return
      }

      // Mark this loop before phase/session transitions so any idle event observed
      // mid-rotation is handled as a final-audit fix.
      pendingFinalAuditFix.add(loopName)

      loopService.setPhase(loopName, 'coding')

      loopService.replaceSession(loopName, {
        newSessionId: newCodeSessionId,
        phase: 'coding',
        iteration: nextIter,
        resetError: currentState.errorCount > 0,
      })

      const { error: promptErr } = await sendPromptWithFallback({
        loopName,
        sessionId: newCodeSessionId,
        promptText: fixPrompt,
        agent: 'code',
        variant: currentState.executionVariant,
      })
      if (promptErr) {
        logger.error(`Loop: failed to send final-audit fix prompt for ${loopName}`, promptErr)
        pendingFinalAuditFix.delete(loopName)
        await handlePromptError(loopName, currentState, 'failed to send final-audit fix prompt', promptErr)
        return
      }
      watchdog.recordActivity(loopName, 'final-audit-fix-prompt-sent')
    }
  }

  async function tick(event: LoopEvent): Promise<void> {
    if (event.type === 'worktree.failed') {
      const message = event.properties?.message as string
      const directory = event.properties?.directory as string
      logger.error(`Loop: worktree failed: ${message}`)
      
      if (directory) {
        const activeLoops = loopService.listActive()
        const affectedLoop = activeLoops.find((s) => s.worktreeDir === directory)
        if (affectedLoop) {
          await terminateLoop(affectedLoop.loopName!, affectedLoop, { kind: 'worktree_failed', message })
        }
      }
      return
    }

    if (event.type === 'session.error') {
      const errorProps = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string } } }
      const eventSessionId = errorProps?.sessionID
      const errorName = errorProps?.error?.name
      const isAbort = errorName === 'MessageAbortedError' || errorName === 'AbortError'

      if (!eventSessionId) return

      if (isAbort) {
        const loopName = loopService.resolveLoopName(eventSessionId)
        if (!loopName) return
        await withStateLock(loopName, async () => {
          const state = loopService.getActiveState(loopName)
          if (!state?.active) return
          const isCurrentSession = state.sessionId === eventSessionId
          if (!isCurrentSession) {
            logger.log(`Loop: ignoring stale aborted event for session ${eventSessionId} (current=${state.sessionId})`)
            return
          }
          if (state.phase === 'auditing') {
            const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
            if (lastMessageRole === 'assistant') {
              logger.log(`Loop: audit session ${eventSessionId} aborted after assistant response, processing audit result`)
              await runAuditingPhase(loopName, state)
              return
            }
            logger.log(`Loop: audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`)
            await rotateToCodingAfterAuditFailure(loopName, state, 'aborted')
            return
          }
          if (state.phase === 'final_auditing') {
            const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
            if (lastMessageRole === 'assistant') {
              logger.log(`Loop: final audit session ${eventSessionId} aborted after assistant response, processing audit result`)
              await runFinalAuditPhase(loopName, state)
              return
            }
            logger.log(`Loop: final audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`)
            await rotateToCodingAfterAuditFailure(loopName, state, 'aborted')
            return
          }
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(loopName, state, { kind: 'user_aborted' })
        })
        return
      }

      const loopName = loopService.resolveLoopName(eventSessionId)
      if (!loopName) return
      await withStateLock(loopName, async () => {
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return
        const isCurrentSession = state.sessionId === eventSessionId
        if (!isCurrentSession) {
          logger.log(`Loop: ignoring stale error event for session ${eventSessionId} (current=${state.sessionId})`)
          return
        }
        if (state.phase === 'auditing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          logger.error(`Loop: audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        if (state.phase === 'final_auditing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
          if (lastMessageRole === 'assistant') {
            logger.log(`Loop: final audit session ${eventSessionId} error after assistant response, processing audit result`)
            await runFinalAuditPhase(loopName, state)
            return
          }
          logger.error(`Loop: final audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        logger.error(`Loop: session error for ${eventSessionId}: ${errorMessage}`)
        const isModelError = /provider|auth|model|api\s*error/i.test(errorMessage)
        if (isModelError && !state.modelFailed) {
          logger.log(`Loop: marking model as failed, will fall back to default on next iteration`)
          loopService.setModelFailed(loopName, true)
        }
      })
      return
    }

    if (event.type !== 'session.status') return

    const status = event.properties?.status as { type?: string } | undefined
    const sessionId = event.properties?.sessionID as string
    if (!sessionId) return

    if (status?.type === 'busy') {
      const loopName = loopService.resolveLoopName(sessionId)
      if (loopName && isAwaitingBusy(loopName, sessionId)) {
        logger.debug(`[idle-gate] busy observed for ses=${sessionId} loop=${loopName}, clearing pending`)
        clearPromptPending(loopName, logger)
      }
      if (loopName) {
        clearPromptInFlightBySession(loopName, sessionId)
      }
      return
    }

    if (status?.type !== 'idle') return

    logger.debug(`Loop: received idle event for session=${sessionId}`)

    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) {
      logger.debug(`Loop: no loop found for session=${sessionId}, ignoring idle event`)
      return
    }
    logger.debug(`Loop: idle event matched loop=${loopName}`)

    if (isAwaitingBusy(loopName, sessionId)) {
      if (!isAwaitingBusyExpired(loopName)) {
        logger.debug(`[idle-gate] suppressing premature idle loop=${loopName} session=${sessionId} (no busy yet)`)
        return
      }
      logger.log(`[idle-gate] awaiting-busy expired for loop=${loopName}, dispatching idle anyway`)
      clearPromptPending(loopName, logger)
    }

    await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      const isCurrentSession = state.sessionId === sessionId
      if (!isCurrentSession) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current=${state.sessionId})`)
        return
      }

      try {
        watchdog.start(loopName)
        
        if (state.phase === 'auditing') {
          await runAuditingPhase(loopName, state)
        } else if (state.phase === 'final_auditing') {
          await runFinalAuditPhase(loopName, state)
        } else {
          await runCodingPhase(loopName, state)
        }
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
  }

  async function terminateAll(): Promise<void> {
    await loopService.terminateAll()
  }

  function clearAllRetryTimeouts(): void {
    for (const [worktreeName, timeout] of retryTimeouts.entries()) {
      clearTimeout(timeout)
      retryTimeouts.delete(worktreeName)
    }
    for (const [worktreeName, timeout] of idleRetryTimeouts.entries()) {
      clearTimeout(timeout)
      idleRetryTimeouts.delete(worktreeName)
    }
    idleRetryAttempts.clear()
    codingLaunchRecoveryAttempts.clear()
    loopRetainedSessions.clear()
    watchdog.clearAll()
    stateLocks.clear()
    sessionsAwaitingBusy.clear()
    logger.log('Loop: cleared all retry timeouts')
  }

  async function cancelBySessionId(sessionId: string): Promise<boolean> {
    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, { kind: 'user_aborted' })
    return true
  }

  async function terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, reason)
    return true
  }

  async function clearLoopTimers(loopName: string): Promise<void> {
    watchdog.stop(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)
    codingLaunchRecoveryAttempts.delete(loopName)

    const retained = loopRetainedSessions.get(loopName)
    if (retained) {
      // Capture usage for retained sessions before deletion using stored metadata
      for (const entry of retained) {
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
        }).catch((err: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on clear (loop=${loopName})`, err)
        })
        void v2Client.session.delete({ sessionID: entry.sessionId, directory: entry.directory }).catch(() => {})
      }
      loopRetainedSessions.delete(loopName)
    }
  }

  function runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    return withStateLock<T>(loopName, fn)
  }

  function inspect(name: string): LoopState | null {
    return loopService.getAnyState(name)
  }

  function listActive(): LoopState[] {
    return loopService.listActive()
  }

  function listRecent(): LoopState[] {
    return loopService.listRecent()
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    return loopService.findMatchByName(name)
  }

  function hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean {
    return loopService.hasOutstandingFindings(loopName, severity)
  }

  async function cancel(name: string): Promise<void> {
    await terminateLoopByName(name, { kind: 'user_aborted' })
  }

  async function terminate(name: string, reason: TerminationReason): Promise<boolean> {
    return await terminateLoopByName(name, reason)
  }

  function recordActivity(name: string, source?: string): void {
    watchdog.recordActivity(name, source)
  }

  function recordUserMessage(sessionId: string, text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed || isLoopGeneratedPrompt(trimmed)) return false
    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    const state = loopService.getActiveState(loopName)
    if (!state?.active || state.sessionId !== sessionId) return false
    const entry = interjections.enqueue(loopName, trimmed)
    if (entry) logger.log(`Loop: captured user interjection loop=${loopName} id=${entry.id}`)
    return entry != null
  }

  function startWatchdog(name: string): void {
    watchdog.start(name)
  }

  function getStallInfo(name: string): LoopWatchdogStallInfo | null {
    return watchdog.getStallInfo(name)
  }

  function generateUniqueLoopName(baseName: string): string {
    const existing = listActive()
      .map(s => s.loopName)
    const recent = listRecent()
      .map(s => s.loopName)
    return generateUniqueName(baseName, [...existing, ...recent])
  }

  function start(input: StartLoopInput): void {
    const { state } = input

    const allNames = [...listActive(), ...listRecent()].map(s => s.loopName)
    if (allNames.includes(state.loopName)) {
      state.loopName = generateUniqueName(state.loopName, allNames)
      logger.log(`Loop: auto-renamed to ${state.loopName} because requested name already exists`)
    }

    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)
    loopRegistry.add(state.loopName)
    logger.log(`Loop: started loop=${state.loopName} session=${state.sessionId}`)
  }

  function restart(name: string, params: { newState: LoopState; newSessionId: string }): void {
    loopService.deleteState(name)
    loopService.setState(name, params.newState)
    loopService.registerLoopSession(params.newSessionId, name)
    loopRegistry.add(name)
  }

  function setPhase(name: string, phase: LoopState['phase']): void {
    loopService.setPhase(name, phase)
  }

  return {
    tick,
    start,
    cancel,
    inspect,
    listActive,
    listRecent,
    findMatchByName,
    hasOutstandingFindings,
    terminateAll,
    terminate,
    cancelBySessionId,
    runExclusive,
    clearLoopTimers,
    clearAllRetryTimeouts,
    recordActivity,
    recordUserMessage,
    startWatchdog,
    getStallInfo,
    restart,
    generateUniqueLoopName,
    setPhase,

    // State management methods (delegated from loopService)
    resolveLoopName: (sessionId: string) => loopService.resolveLoopName(sessionId),
    getActiveState: (name: string) => loopService.getActiveState(name),
    getAnyState: (name: string) => loopService.getAnyState(name),
    setState: (name: string, state: LoopState) => loopService.setState(name, state),
    deleteState: (name: string) => loopService.deleteState(name),
    registerLoopSession: (sessionId: string, loopName: string) => loopService.registerLoopSession(sessionId, loopName),
    replaceSession: (name: string, opts: { newSessionId: string; phase: LoopState['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }) => loopService.replaceSession(name, opts),
    setStatus: (name: string, status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled') => loopService.setStatus(name, status),
    setPhaseAndResetError: (name: string, phase: LoopState['phase']) => loopService.setPhaseAndResetError(name, phase),
    setModelFailed: (name: string, failed: boolean) => loopService.setModelFailed(name, failed),
    setLastAuditResult: (name: string, text: string) => loopService.setLastAuditResult(name, text),
    clearLastAuditResult: (name: string) => loopService.clearLastAuditResult(name),
    setSandboxContainer: (name: string, containerName: string | null) => loopService.setSandboxContainer(name, containerName),
    clearWorkspaceId: (name: string) => loopService.clearWorkspaceId(name),
    setWorkspaceId: (name: string, workspaceId: string) => loopService.setWorkspaceId(name, workspaceId),
    incrementError: (name: string) => loopService.incrementError(name),
    resetError: (name: string) => loopService.resetError(name),
    terminateLoop: (name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number; summary?: string }) => loopService.terminate(name, opts),
    getOutstandingFindings: (loopName?: string, severity?: 'bug' | 'warning') => loopService.getOutstandingFindings(loopName, severity),
    bumpFindingRecurrence: (name: string, findings: ReviewFindingRow[]) => loopService.bumpFindingRecurrence(name, findings),
    resetSectionRecurrence: (name: string, sectionIndex: number) => loopService.resetSectionRecurrence(name, sectionIndex),
    getStallTimeoutMs: () => loopService.getStallTimeoutMs(),
    getMaxConsecutiveStalls: () => loopService.getMaxConsecutiveStalls(),

    // Prompt building methods (delegated from loopService)
    buildContinuationPrompt: (state: LoopState, auditFindings?: string) => loopService.buildContinuationPrompt(state, auditFindings),
    buildAuditPrompt: (state: LoopState) => loopService.buildAuditPrompt(state),
    buildSectionInitialPrompt: (state: LoopState) => loopService.buildSectionInitialPrompt(state),
    buildSectionAuditPrompt: (state: LoopState) => loopService.buildSectionAuditPrompt(state),
    buildSectionContinuationPrompt: (state: LoopState, auditText: string) => loopService.buildSectionContinuationPrompt(state, auditText),
    buildFinalAuditPrompt: (state: LoopState) => loopService.buildFinalAuditPrompt(state),
    buildFinalAuditFixPrompt: (state: LoopState, auditText: string) => loopService.buildFinalAuditFixPrompt(state, auditText),

    // Plan and section methods (delegated from loopService)
    getPlanText: (loopName: string, sessionId: string) => loopService.getPlanText(loopName, sessionId),
    getSectionPlan: (state: LoopState, index: number) => loopService.getSectionPlan(state, index),
    getNextIncompleteSectionPlan: (state: LoopState) => loopService.getNextIncompleteSectionPlan(state),
    getCompletedSectionDigest: (state: LoopState) => loopService.getCompletedSectionDigest(state),
    parseSectionSummary: (text: string) => loopService.parseSectionSummary(text),
    completeSection: (loopName: string, index: number, summary: { done: string | null; deviations: string | null; followUps: string | null }) => loopService.completeSection(loopName, index, summary),
    incrementSectionAttempts: (loopName: string, index: number) => loopService.incrementSectionAttempts(loopName, index),
    resetSectionForRewind: (loopName: string, index: number) => loopService.resetSectionForRewind(loopName, index),
    setCurrentSectionIndex: (loopName: string, index: number) => loopService.setCurrentSectionIndex(loopName, index),
    setFinalAuditDone: (loopName: string, done: boolean) => loopService.setFinalAuditDone(loopName, done),
    startSection: (loopName: string, index: number) => loopService.startSection(loopName, index),
    bulkInsertSections: (loopName: string, sections: { index: number; title: string; content: string }[]) => loopService.bulkInsertSections(loopName, sections),
    setTotalSections: (loopName: string, total: number) => loopService.setTotalSections(loopName, total),
  }
}
