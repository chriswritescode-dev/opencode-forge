import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService, LoopState } from '../services/loop'
import { MAX_RETRIES } from '../services/loop'
import type { Logger, PluginConfig } from '../types'
import { createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
import { retryWithModelFallback, resolveDecomposerModel } from '../utils/model-fallback'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import type { createSandboxManager } from '../sandbox/manager'
import { buildWorktreeCompletionPayload, writeWorktreeCompletionLog } from '../services/worktree-log'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { teardownWorktreeArtifacts } from '../utils/worktree-cleanup'
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { formatAuditSessionTitle, formatLoopSessionTitle } from '../utils/session-titles'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { extractSections } from '../utils/section-capture'
import { decomposeDeterministically } from '../services/deterministic-decomposer'
import { markPromptSent, clearPromptPending, sessionsAwaitingBusy, isAwaitingBusy, isAwaitingBusyExpired } from './idle-gate'
import type { TerminationReason } from './termination'
import { terminationStatusFor, terminationReasonToString } from './termination'
import { nextTransition } from './transitions'

export interface LoopEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface LoopRuntimeDeps {
  loopService: LoopService
  client: PluginInput['client']
  v2Client: OpencodeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
}

export interface Loop {
  tick(event: LoopEvent): Promise<void>
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
  clearLoopTimers(name: string): void
  clearAllRetryTimeouts(): void
  recordActivity(name: string): void
  startWatchdog(name: string): void
  getStallInfo(name: string): LoopWatchdogStallInfo | null
}

export function isWorkspaceNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /Workspace not found/i.test(msg)
}

export function createLoop(deps: LoopRuntimeDeps): Loop {
  const { loopService, client, v2Client, logger, getConfig, sandboxManager, dataDir } = deps

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryAttempts = new Map<string, number>()
  const stateLocks = new Map<string, Promise<unknown>>()

  const IDLE_RETRY_DELAY_MS = 1500
  const MAX_IDLE_RETRIES = 1
  const MAX_CODE_LAUNCH_RECOVERIES = MAX_RETRIES
  const DELAYED_SESSION_DELETE_MS = 15_000

  const codingLaunchRecoveryAttempts = new Map<string, number>()
  const delayedSessionDeleteTimeouts = new Map<string, NodeJS.Timeout>()
  const loopDelayedDeletes = new Map<string, Set<string>>()

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
  }): Promise<{ error?: unknown; usedModel?: { providerID: string; modelID: string } | undefined }> {
    const { loopName, sessionId, promptText, agent } = input

    if (agent === 'auditor-loop') {
      const auditorModel = input.model != null ? input.model : undefined

      const sendWithModel = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        markPromptSent(loopName, sessionId, logger)
        const result = await promptAuditSessionWithFallback({
          sessionId,
          worktreeDir: freshState.worktreeDir,
          workspaceId: freshState.workspaceId,
          prompt: promptText,
          auditorModel,
        })
        return result.ok ? { data: true } : { error: result.error }
      }

      const sendWithoutModel = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        markPromptSent(loopName, sessionId, logger)
        const result = await promptAuditSessionWithFallback({
          sessionId,
          worktreeDir: freshState.worktreeDir,
          workspaceId: freshState.workspaceId,
          prompt: promptText,
        })
        return result.ok ? { data: true } : { error: result.error }
      }

      const { result, usedModel } = await retryWithModelFallback(sendWithModel, sendWithoutModel, auditorModel, logger)
      if (result.error) clearPromptPending(loopName, logger)
      return { error: result.error, usedModel }
    }

    const effectiveModel = input.model != null ? input.model : resolveLoopModel(getConfig(), loopService, loopName)

    const sendWithModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) throw new Error('loop_cancelled')
      markPromptSent(loopName, sessionId, logger)
      return v2Client.session.promptAsync({
        sessionID: sessionId,
        directory: freshState.worktreeDir,
        ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: promptText }],
        model: effectiveModel,
      })
    }

    const sendWithoutModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) throw new Error('loop_cancelled')
      markPromptSent(loopName, sessionId, logger)
      return v2Client.session.promptAsync({
        sessionID: sessionId,
        directory: freshState.worktreeDir,
        ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
        agent: 'code',
        parts: [{ type: 'text' as const, text: promptText }],
      })
    }

    const { result, usedModel } = await retryWithModelFallback(sendWithModel, sendWithoutModel, effectiveModel, logger)
    if (result.error) clearPromptPending(loopName, logger)
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
      const lastAssistant = [...messages].reverse().find((m) => m.info.role === 'assistant')

      if (!lastAssistant) {
        const role = lastMessage?.info.role ?? 'none'
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${role}`)
        return { text: null, error: null, lastMessageRole: role }
      }

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

    const createLoopWorkspaceMod = await import('../workspace/forge-worktree')
    const newWorkspace = await createLoopWorkspaceMod.createLoopWorkspace(
      v2Client,
      {
        loopName,
        directory: state.worktreeDir,
        branch: state.worktreeBranch ?? null,
      },
      logger,
    )

    if (!newWorkspace) {
      logger.error(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      return { recovered: false }
    }

    try {
      await bindSessionToWorkspace(v2Client, newWorkspace.workspaceId, sessionId, logger)
      loopService.setWorkspaceId(loopName, newWorkspace.workspaceId)
      state.workspaceId = newWorkspace.workspaceId
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

    const createLoopWorkspaceMod = await import('../workspace/forge-worktree')
    const workspace = await createLoopWorkspaceMod.createLoopWorkspace(
      v2Client,
      {
        loopName,
        directory: state.worktreeDir,
        branch: state.worktreeBranch ?? null,
      },
      logger,
    )

    if (!workspace) {
      logger.log(`Loop: workspace creation failed for ${loopName} (${contextLabel}), continuing without workspace backing`)
      return {}
    }

    loopService.setWorkspaceId(loopName, workspace.workspaceId)
    state.workspaceId = workspace.workspaceId
    logger.log(`Loop: provisioned workspace ${workspace.workspaceId} for ${loopName} (${contextLabel})`)
    return { workspaceId: workspace.workspaceId }
  }

  /**
   * Rotates to a new session in the same workspace. Creates and binds the new session FIRST,
   * then fire-and-forget deletes the old session. This ordering ensures the workspace always
   * has at least one bound session, preventing the host from pruning it from non-focused TUIs.
   */
  async function rotateSession(loopName: string, state: LoopState): Promise<string> {
    const oldSessionId = state.sessionId
    const sessionDir = state.worktreeDir

    clearPromptPending(loopName, logger)

    logger.log(
      `Loop: [perm-diag] rotate loop=${loopName} state.worktree=${String(state.worktree)} state.sandbox=${String(state.sandbox)}`
    )

    const permissionRuleset = buildLoopPermissionRuleset({
      isWorktree: !!state.worktree,
      isSandbox: !!state.sandbox,
    })

    const ensured = await ensureWorkspaceForLoop(loopName, state, 'during session rotation')

    const createResult = await createLoopSessionWithWorkspace({
      v2: v2Client,
      title: formatLoopSessionTitle(state.loopName),
      directory: sessionDir,
      permission: permissionRuleset,
      workspaceId: ensured.workspaceId ?? state.workspaceId,
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

    v2Client.session.delete({ sessionID: oldSessionId, directory: sessionDir }).catch((err: unknown) => {
      logger.error(`Loop: failed to delete old session ${oldSessionId}`, err)
    })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    if (!state.worktree && v2Client.tui) {
      v2Client.tui.selectSession({ sessionID: newSessionId }).catch((err: unknown) => {
        logger.error(`Loop: failed to navigate TUI to rotated session`, err)
      })
    }

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
    // Hard gate: refuse completion if any bug-severity findings remain
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
      activeSessionId = await rotateSession(loopName, currentState)
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
    })

    if (promptResultError) {
      const retryFn = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) throw new Error('loop_cancelled')
        const result = await v2Client.session.promptAsync({
          sessionID: activeSessionId,
          directory: freshState.worktreeDir,
          ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: continuationPrompt }],
        })
        if (result.error) {
          await handlePromptError(loopName, currentState, `retry failed ${errorContext}`, result.error)
          return
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
    })
    if (error) {
      logger.error(`rotateToCodingAfterAuditFailure: failed to send continuation prompt`, error)
    }
  }

  function buildCodingPromptForCurrentState(state: LoopState): string {
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
      const sendWithModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active || fresh.phase !== 'coding' || fresh.sessionId !== codeSessionId) throw new Error('loop_cancelled')
        markPromptSent(loopName, codeSessionId, logger)
        return v2Client.session.promptAsync({
          sessionID: codeSessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: recoveryPrompt }],
          model: resolveLoopModel(currentConfig, loopService, loopName),
        })
      }
      const sendWithoutModel = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active || fresh.phase !== 'coding' || fresh.sessionId !== codeSessionId) throw new Error('loop_cancelled')
        markPromptSent(loopName, codeSessionId, logger)
        return v2Client.session.promptAsync({
          sessionID: codeSessionId,
          directory: fresh.worktreeDir,
          ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
          agent: 'code',
          parts: [{ type: 'text' as const, text: recoveryPrompt }],
        })
      }
      const { result: promptResult } = await retryWithModelFallback(
        sendWithModel,
        sendWithoutModel,
        resolveLoopModel(currentConfig, loopService, loopName),
        logger,
      )
      if (promptResult.error) {
        clearPromptPending(loopName, logger)
        logger.error(`Loop: failed to send recovery prompt for ${loopName}`, promptResult.error)
        const retryFn = async () => {
          const retry = await sendWithoutModel()
          if ('error' in retry && retry.error) throw retry.error
        }
        await handlePromptError(loopName, freshState ?? state, 'failed to recover code launch', promptResult.error, retryFn)
      }
    } catch (err) {
      logger.error(`Loop: failed to recover code launch for ${loopName}`, err)
      await handlePromptError(loopName, state, 'failed to recover code launch', err)
    }
  }

  function scheduleSessionDelete(input: {
    loopName: string
    sessionId: string
    directory: string
    context: string
  }): void {
    const { loopName, sessionId, directory, context } = input

    const existingTimeout = delayedSessionDeleteTimeouts.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      delayedSessionDeleteTimeouts.delete(sessionId)
    }

    const loopSet = loopDelayedDeletes.get(loopName)
    if (!loopSet) {
      loopDelayedDeletes.set(loopName, new Set())
    }
    loopDelayedDeletes.get(loopName)!.add(sessionId)

    const timeout = setTimeout(async () => {
      delayedSessionDeleteTimeouts.delete(sessionId)
      const loopSetForCleanup = loopDelayedDeletes.get(loopName)
      if (loopSetForCleanup) {
        loopSetForCleanup.delete(sessionId)
        if (loopSetForCleanup.size === 0) loopDelayedDeletes.delete(loopName)
      }

      try {
        const activeState = loopService.getActiveState(loopName)
        if (activeState?.active && activeState.sessionId === sessionId) {
          logger.debug(`Loop: skipping delayed delete for active session ${sessionId} (${context})`)
          return
        }
        await v2Client.session.delete({ sessionID: sessionId, directory })
      } catch (err) {
        logger.error(`Loop: delayed delete failed for ${sessionId} (${context})`, err)
      }
    }, DELAYED_SESSION_DELETE_MS)

    delayedSessionDeleteTimeouts.set(sessionId, timeout)
  }

  async function transitionToCoding(loopName: string, state: LoopState): Promise<void> {
    loopService.startSection(loopName, 0)
    loopService.setCurrentSectionIndex(loopName, 0)

    const updatedState = loopService.getActiveState(loopName) ?? state
    loopService.setPhase(loopName, 'coding')

    const codeSessionResult = await createLoopSessionWithWorkspace({
      v2: v2Client,
      title: formatLoopSessionTitle(loopName),
      directory: updatedState.worktreeDir,
      permission: buildLoopPermissionRuleset({ isWorktree: !!updatedState.worktree, isSandbox: !!updatedState.sandbox }),
      workspaceId: updatedState.workspaceId,
      logPrefix: 'Loop',
      logger,
    })

    if (!codeSessionResult) {
      logger.error(`Loop: failed to create code session after decomposition for ${loopName}`)
      await terminateLoop(loopName, updatedState, { kind: 'session_creation_failed' })
      return
    }

    const codeSessionId = codeSessionResult.sessionId
    loopService.replaceSession(loopName, {
      newSessionId: codeSessionId,
      phase: 'coding',
      resetError: false,
    })

    const codeState = loopService.getActiveState(loopName) ?? updatedState
    const sectionPrompt = loopService.buildSectionInitialPrompt(codeState)

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const { error } = await sendPromptWithFallback({
      loopName,
      sessionId: codeSessionId,
      promptText: sectionPrompt,
      agent: 'code',
      model: loopModel,
    })
    if (error) {
      logger.error(`Loop: failed to send initial section prompt for ${loopName}`, error)
      await handlePromptError(loopName, codeState, 'failed to send initial section prompt', error)
      return
    }
    watchdog.recordActivity(loopName, 'section-prompt-sent')
  }

  async function trySalvageDecomposerTranscript(loopName: string, state: LoopState): Promise<import('../utils/section-capture').ParsedSection[] | null> {
    try {
      if (!state.decompositionSessionId) return null

      const messagesResult = await v2Client.session.messages({
        sessionID: state.decompositionSessionId,
        directory: state.worktreeDir || '',
        limit: 4,
      })
      const messages = (messagesResult.data ?? []) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>
      const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
      if (!lastAssistant) return null

      const transcript = lastAssistant.parts
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('\n')

      if (transcript.length === 0) return null

      const maxSections = getConfig().decomposer?.maxSections ?? 12

      const markerSections = extractSections(transcript, { maxSections })
      if (markerSections.length > 0) return markerSections

      const deterministicSections = decomposeDeterministically(transcript, { maxSections })
      if (deterministicSections.length > 0) return deterministicSections

      return null
    } catch (err) {
      logger.error(`Loop: trySalvageDecomposerTranscript failed for ${loopName}`, err)
      return null
    }
  }

  async function terminateLoop(loopName: string, state: LoopState, reason: TerminationReason): Promise<void> {
    const sessionId = state.sessionId
    const projectDir = state.projectDir ?? state.worktreeDir
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
    clearPromptPending(loopName, logger)

    const loopDeleteSet = loopDelayedDeletes.get(loopName)
    if (loopDeleteSet) {
      for (const sid of loopDeleteSet) {
        const t = delayedSessionDeleteTimeouts.get(sid)
        if (t) {
          clearTimeout(t)
          delayedSessionDeleteTimeouts.delete(sid)
        }
      }
      loopDelayedDeletes.delete(loopName)
    }

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

    if (reason.kind === 'completed' && state.worktree) {
      const completionTimestamp = new Date()
      const planText = loopService.getPlanText(state.loopName, state.sessionId)

      const completionResult = buildWorktreeCompletionPayload(
        getConfig(),
        {
          projectDir,
          loopName: state.loopName,
          completionTimestamp,
          iteration: state.iteration,
          worktreeBranch: state.worktreeBranch,
          dataDir,
        },
        logger,
      )

      if (completionResult) {
        completionResult.payload.planText = planText
        const written = writeWorktreeCompletionLog(completionResult.payload, logger)
        if (written) {
          logger.log(`Loop: worktree completion log written to ${completionResult.hostPath}`)
        } else {
          logger.error(`Loop: failed to write worktree completion log to ${completionResult.hostPath}`)
        }
      } else {
        logger.log(`Loop: worktree completion logging skipped (payload build failed or disabled)`)
      }
    }

    if (v2Client.tui) {
      const toastVariant = reason.kind === 'completed' ? 'success'
        : reason.kind === 'cancelled' || reason.kind === 'user_aborted' ? 'info'
        : reason.kind === 'max_iterations' ? 'warning'
        : reason.kind === 'stall_timeout' ? 'error'
        : 'error'

      const toastMessage = reason.kind === 'completed' ? `Completed after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason.kind === 'cancelled' ? 'Loop cancelled'
        : reason.kind === 'max_iterations' ? `Reached max iterations (${state.maxIterations})`
        : reason.kind === 'stall_timeout' ? `Stalled after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason.kind === 'user_aborted' ? 'Loop aborted by user'
        : `Loop ended: ${terminationReasonToString(reason)}`

      v2Client.tui.publish({
        directory: state.projectDir ?? state.worktreeDir,
        body: {
          type: 'tui.toast.show',
          properties: {
            title: state.loopName,
            message: toastMessage,
            variant: toastVariant,
            duration: reason.kind === 'completed' ? 5000 : 3000,
          },
        },
      }).catch((err: unknown) => {
        logger.error('Loop: failed to publish toast notification', err)
      })
    }

    if (state.worktree) {
      const reasonLabel =
        reason.kind === 'completed' ? 'completed'
        : reason.kind === 'cancelled' ? 'cancelled'
        : reason.kind === 'stall_timeout' ? 'stalled'
        : reason.kind === 'error_max_retries' || reason.kind === 'decomposer_error' || reason.kind === 'worktree_failed' ? 'errored'
        : reason.kind

      const doCommit = reason.kind !== 'missing_worktree_dir'
      const doRemoveWorktree = reason.kind !== 'missing_worktree_dir'

      const teardown = await teardownWorktreeArtifacts({
        v2: v2Client,
        loopName: state.loopName,
        sessionId,
        workspaceId: state.workspaceId,
        worktreeDir: state.worktreeDir,
        projectDir: state.projectDir,
        worktree: true,
        doCommit,
        doRemoveWorktree,
        reasonLabel,
        worktreeBranch: state.worktreeBranch,
        iteration: state.iteration,
        logPrefix: 'Loop',
        logger,
      })

      logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=${teardown.sessionDeleted} workspaceDeleted=${teardown.workspaceDeleted} worktreeRemoved=${teardown.worktreeRemoved}`)
    }

    if (state.sandbox && state.sandboxContainer && sandboxManager) {
      try {
        await sandboxManager.stop(state.loopName!)
        logger.log(`Loop: stopped sandbox container for ${state.loopName}`)
      } catch (err) {
        logger.error(`Loop: failed to stop sandbox container`, err)
      }
    }
  }

  async function handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
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
    worktreeDir: string
    workspaceId?: string
    isSandbox: boolean
    auditorModel?: { providerID: string; modelID: string }
    prompt: string
  }): Promise<{ auditSessionId: string; bindFailed: boolean; bindError?: unknown } | null> {
    const created = await createAuditSession({
      v2: v2Client,
      loopName: input.loopName,
      iteration: input.iteration,
      worktreeDir: input.worktreeDir,
      workspaceId: input.workspaceId,
      isSandbox: input.isSandbox,
      auditorModel: input.auditorModel,
      prompt: input.prompt,
      logger,
    })
    if (created) return { auditSessionId: created.auditSessionId, bindFailed: created.bindFailed, bindError: created.bindError }

    try {
      logger.log(`Loop: falling back to plugin client for audit session creation (${input.loopName})`)
      const result = await client.session.create({
        body: {
          title: formatAuditSessionTitle(input.loopName, input.iteration),
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
          ...(input.auditorModel ? { model: input.auditorModel } : {}),
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
        } else if (freshState.phase === 'decomposing') {
          await runDecomposingPhase(loopName, freshState)
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

    maybeSelectTuiSession(currentState, created.auditSessionId)

    scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after final audit creation' })

    const { error: finalAuditPromptErr } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: finalAuditPrompt,
      agent: 'auditor-loop',
      model: auditorModel,
    })

    if (finalAuditPromptErr) {
      logger.error(`Loop: failed to send final audit prompt for ${loopName}`, finalAuditPromptErr)
      await handlePromptError(loopName, finalAuditState, 'failed to send final audit prompt', finalAuditPromptErr)
      return false
    }
    watchdog.recordActivity(loopName, 'final-audit-prompt-sent')
    return true
  }

  function maybeSelectTuiSession(state: LoopState, sessionId: string): void {
    if (state.worktree) return
    if (!v2Client.tui) return
    v2Client.tui.selectSession({ sessionID: sessionId }).catch((err: unknown) => {
      logger.error(`Loop: failed to navigate TUI to session ${sessionId}`, err)
    })
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

    const currentConfig = getConfig()
    const auditorModel = resolveLoopAuditorModel(currentConfig, loopService, loopName, logger)
    const auditPrompt = loopService.buildAuditPrompt(currentState)
    const codeSessionId = currentState.sessionId

    // Create audit session with retry
    async function createAuditWithRetry(input: {
      loopName: string
      iteration: number
      worktreeDir: string
      workspaceId?: string
      isSandbox: boolean
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
    }, attempts = MAX_RETRIES): Promise<{ auditSessionId: string; bindFailed: boolean; bindError?: unknown } | null> {
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

    maybeSelectTuiSession(currentState, created.auditSessionId)

    scheduleSessionDelete({ loopName, sessionId: codeSessionId, directory: currentState.worktreeDir, context: 'after audit creation' })

    const { error: auditPromptErr, usedModel: actualAuditorModel } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: loopService.buildAuditPrompt(currentState),
      agent: 'auditor-loop',
      model: auditorModel,
    })

    if (auditPromptErr) {
      if (isWorkspaceNotFoundError(auditPromptErr) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const retryResult = await promptAuditSessionWithFallback({
            sessionId: created.auditSessionId,
            worktreeDir: currentState.worktreeDir,
            workspaceId: currentState.workspaceId,
            prompt: loopService.buildAuditPrompt(currentState),
          })
          if (retryResult.ok) {
            logger.log(`Loop: recovered audit prompt after workspace re-bind for ${loopName}`)
            watchdog.recordActivity(loopName, 'audit-recover')
            return
          }
        }
      }
      const retryFn = async () => {
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active) throw new Error('loop_cancelled')
        const retry = await promptAuditSessionWithFallback({
          sessionId: created.auditSessionId,
          worktreeDir: fresh.worktreeDir,
          workspaceId: fresh.workspaceId,
          prompt: loopService.buildAuditPrompt(fresh),
        })
        if (!retry.ok) throw retry.error
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
        const sectionBugFindings = loopService.getOutstandingFindings(loopName, 'bug')
          .filter(f => f.sectionIndex === idx)

        if (sectionSummary && sectionBugFindings.length === 0) {
          logger.log(`Loop: section ${idx} audit clean, marking completed`)

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

        loopService.setLastAuditResult(loopName, auditText || '')
        loopService.replaceSession(loopName, {
          newSessionId: currentState.sessionId,
          phase: 'coding',
          iteration: nextIter,
        })

        const continuationPrompt = loopService.buildSectionContinuationPrompt(currentState, auditText || '')
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

  async function runDecomposingPhase(loopName: string, _state: LoopState): Promise<void> {
    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping decomposing phase`)
      return
    }

    if (currentState.phase !== 'decomposing') {
      logger.log(`Loop: runDecomposingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in decomposing phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const decompStatus = currentState.decompositionStatus
    const totalSections = currentState.totalSections

    if (decompStatus === 'running' || decompStatus === 'pending') {
      logger.log(`Loop: decomposing phase still running/pending for ${loopName}, waiting`)
      return
    }

    if (decompStatus === 'completed' && totalSections > 0) {
      logger.log(`Loop: decomposing phase completed with ${totalSections} sections for ${loopName}, transitioning to coding`)
      await transitionToCoding(loopName, currentState)
      return
    }

    if (decompStatus === 'completed' && totalSections === 0) {
      logger.log(`Loop: decomposition completed but produced 0 sections, falling back to legacy for ${loopName}`)
      loopService.setDecompositionStatus(loopName, 'skipped')
      loopService.setPhase(loopName, 'coding')

      const fallbackState = loopService.getActiveState(loopName) ?? currentState
      const codeSessionResult = await createLoopSessionWithWorkspace({
        v2: v2Client,
        title: formatLoopSessionTitle(loopName),
        directory: fallbackState.worktreeDir,
        permission: buildLoopPermissionRuleset({ isWorktree: !!fallbackState.worktree, isSandbox: !!fallbackState.sandbox }),
        workspaceId: fallbackState.workspaceId,
        logPrefix: 'Loop',
        logger,
      })

      if (!codeSessionResult) {
        logger.error(`Loop: failed to create code session for legacy fallback for ${loopName}`)
        await terminateLoop(loopName, fallbackState, { kind: 'session_creation_failed' })
        return
      }

      loopService.replaceSession(loopName, {
        newSessionId: codeSessionResult.sessionId,
        phase: 'coding',
        resetError: false,
      })

      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...fallbackState, iteration: fallbackState.iteration ?? 0 },
        undefined,
      )

      const { error } = await sendPromptWithFallback({
        loopName,
        sessionId: codeSessionResult.sessionId,
        promptText: continuationPrompt,
        agent: 'code',
      })
      if (error) {
        logger.error(`Loop: failed to send legacy fallback prompt for ${loopName}`, error)
        await handlePromptError(loopName, fallbackState, 'failed to send legacy fallback prompt', error)
        return
      }
      watchdog.recordActivity(loopName, 'fallback-prompt-sent')
      return
    }

    if (decompStatus === 'failed') {
      const errorCount = currentState.errorCount ?? 0

      if (errorCount === 0 && currentState.totalSections === 0) {
        const salvaged = await trySalvageDecomposerTranscript(loopName, currentState)
        if (salvaged && salvaged.length > 0) {
          loopService.bulkInsertSections(loopName, salvaged)
          loopService.setDecompositionStatus(loopName, 'completed')
          loopService.setTotalSections(loopName, salvaged.length)
          logger.log(`Loop: salvaged ${salvaged.length} sections from decomposer transcript for ${loopName}`)
          const refreshed = loopService.getActiveState(loopName)
          if (refreshed) await transitionToCoding(loopName, refreshed)
          return
        }
      }

      if (errorCount >= MAX_RETRIES) {
        logger.error(`Loop: decomposition failed after ${MAX_RETRIES} retries for ${loopName}`)
        await terminateLoop(loopName, currentState, { kind: 'decomposition_failed' })
        return
      }
      loopService.incrementError(loopName)
      logger.log(`Loop: decomposition failed, retrying (attempt ${errorCount + 1}/${MAX_RETRIES}) for ${loopName}`)

      const freshState = loopService.getActiveState(loopName) ?? currentState
      loopService.setDecompositionStatus(loopName, 'running')

      const decomposerSessionResult = await createLoopSessionWithWorkspace({
        v2: v2Client,
        title: `decomposer-${loopName}`,
        directory: freshState.worktreeDir,
        permission: buildLoopPermissionRuleset({ isWorktree: !!freshState.worktree, isSandbox: !!freshState.sandbox }),
        workspaceId: freshState.workspaceId,
        logPrefix: 'Loop',
        logger,
      })

      if (!decomposerSessionResult) {
        logger.error(`Loop: failed to re-create decomposer session for ${loopName}`)
        await terminateLoop(loopName, freshState, { kind: 'session_creation_failed' })
        return
      }

      const decomposerSessionId = decomposerSessionResult.sessionId
      loopService.setDecompositionSessionId(loopName, decomposerSessionId)
      loopService.registerLoopSession(decomposerSessionId, loopName)
      loopService.setPhase(loopName, 'decomposing')

      const decomposerPrompt = loopService.buildDecomposerInitialPrompt(freshState)
      try {
        markPromptSent(loopName, decomposerSessionId, logger)
        await v2Client.session.promptAsync({
          sessionID: decomposerSessionId,
          directory: freshState.worktreeDir,
          ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
          agent: 'decomposer',
          parts: [{ type: 'text' as const, text: decomposerPrompt }],
          ...(() => {
            const cfg = getConfig()
            const m = resolveDecomposerModel({
              decomposerModel: cfg.decomposer?.model,
              auditorModel: freshState.auditorModel ?? cfg.auditorModel,
              executionModel: freshState.executionModel ?? cfg.executionModel,
            })
            return m ? { model: m } : {}
          })(),
        })
      } catch (err) {
        clearPromptPending(loopName, logger)
        logger.error(`Loop: failed to re-prompt decomposer for ${loopName}`, err)
        await terminateLoop(loopName, freshState, { kind: 'decomposer_prompt_failed' })
        return
      }
      return
    }

    logger.debug(`Loop: decomposing phase unknown state for ${loopName}: status=${decompStatus} totalSections=${totalSections}, waiting`)
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

      // Dirty audit: rewind to the offending section
      const allFindings = loopService.getOutstandingFindings(loopName, 'bug')
      const rawOffendingIdx = allFindings.length > 0
        ? (allFindings[0].sectionIndex ?? currentState.currentSectionIndex)
        : currentState.currentSectionIndex

      // Clamp to valid section range
      const offendingIdx = (rawOffendingIdx >= 0 && rawOffendingIdx < currentState.totalSections)
        ? rawOffendingIdx
        : currentState.currentSectionIndex

      logger.log(`Loop: final audit dirty, rewinding to section ${offendingIdx} for ${loopName}`)

      const nextIter = (currentState.iteration ?? 0) + 1
      if ((currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations) {
        logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
        await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
        return
      }

      loopService.resetSectionForRewind(loopName, offendingIdx)

      const synthState = { ...currentState, phase: 'coding' as const, currentSectionIndex: offendingIdx }
      const continuationPrompt = loopService.buildSectionContinuationPrompt(synthState, auditText || '')

      let newCodeSessionId: string
      try {
        newCodeSessionId = await rotateSession(loopName, currentState)
      } catch (err) {
        logger.error(`Loop: session rotation failed during final audit rewind, aborting rewind`, err)
        return
      }

      loopService.setCurrentSectionIndex(loopName, offendingIdx)
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
        promptText: continuationPrompt,
        agent: 'code',
      })
      if (promptErr) {
        logger.error(`Loop: failed to send rewind continuation prompt for ${loopName}`, promptErr)
        await handlePromptError(loopName, currentState, 'failed to send rewind continuation', promptErr)
        return
      }
      watchdog.recordActivity(loopName, 'rewind-prompt-sent')
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
          if (state.phase === 'decomposing') {
            logger.log(`Loop: decomposer session ${eventSessionId} aborted, terminating loop`)
            await terminateLoop(loopName, state, { kind: 'user_aborted' })
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
        if (state.phase === 'decomposing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          logger.error(`Loop: decomposer session error for ${eventSessionId}: ${errorMessage}, terminating loop`)
          await terminateLoop(loopName, state, { kind: 'decomposer_error', message: errorMessage })
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
        } else if (state.phase === 'decomposing') {
          await runDecomposingPhase(loopName, state)
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
    for (const [, timeout] of delayedSessionDeleteTimeouts) {
      clearTimeout(timeout)
    }
    delayedSessionDeleteTimeouts.clear()
    loopDelayedDeletes.clear()
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
    await terminateLoop(loopName, state, { kind: 'cancelled' })
    return true
  }

  async function terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, reason)
    return true
  }

  function clearLoopTimers(loopName: string): void {
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

    const loopDeleteSet = loopDelayedDeletes.get(loopName)
    if (loopDeleteSet) {
      for (const sid of loopDeleteSet) {
        const t = delayedSessionDeleteTimeouts.get(sid)
        if (t) {
          clearTimeout(t)
          delayedSessionDeleteTimeouts.delete(sid)
        }
      }
      loopDelayedDeletes.delete(loopName)
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
    await terminateLoopByName(name, { kind: 'cancelled' })
  }

  async function terminate(name: string, reason: TerminationReason): Promise<boolean> {
    return await terminateLoopByName(name, reason)
  }

  function recordActivity(name: string): void {
    watchdog.recordActivity(name)
  }

  function startWatchdog(name: string): void {
    watchdog.start(name)
  }

  function getStallInfo(name: string): LoopWatchdogStallInfo | null {
    return watchdog.getStallInfo(name)
  }

  return {
    tick,
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
    startWatchdog,
    getStallInfo,
  }
}
