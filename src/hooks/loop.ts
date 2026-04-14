import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService, LoopState } from '../services/loop'
import { MAX_RETRIES, MAX_CONSECUTIVE_STALLS, fetchSessionOutput } from '../services/loop'
import type { Logger, PluginConfig } from '../types'
import { retryWithModelFallback } from '../utils/model-fallback'
import { resolveLoopModel } from '../utils/loop-helpers'
import { execSync, spawnSync } from 'child_process'
import { resolve } from 'path'
import type { createSandboxManager } from '../sandbox/manager'
import { logWorktreeCompletion, resolveWorktreeLogTarget } from '../services/worktree-log'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { agents } from '../agents'

export interface LoopEventHandler {
  onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void>
  terminateAll(): void
  clearAllRetryTimeouts(): void
  startWatchdog(loopName: string): void
  getStallInfo(loopName: string): { consecutiveStalls: number; lastActivityTime: number } | null
  cancelBySessionId(sessionId: string): Promise<boolean>
}

export function createLoopEventHandler(
  loopService: LoopService,
  _client: PluginInput['client'],
  v2Client: OpencodeClient,
  logger: Logger,
  getConfig: () => PluginConfig,
  sandboxManager?: ReturnType<typeof createSandboxManager>,
  projectId?: string,
  dataDir?: string,
): LoopEventHandler {
  const minAudits = loopService.getMinAudits()
  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const lastActivityTime = new Map<string, number>()
  const stallWatchdogs = new Map<string, NodeJS.Timeout>()
  const consecutiveStalls = new Map<string, number>()
  const watchdogRunning = new Map<string, boolean>()
  const stateLocks = new Map<string, Promise<void>>()

  function withStateLock(loopName: string, fn: () => Promise<void>): Promise<void> {
    const prev = stateLocks.get(loopName) ?? Promise.resolve()
    const next = prev.then(fn, fn).finally(() => {
      if (stateLocks.get(loopName) === next) {
        stateLocks.delete(loopName)
      }
    })
    stateLocks.set(loopName, next)
    return next
  }

  async function commitAndCleanupWorktree(state: LoopState): Promise<{ committed: boolean; cleaned: boolean }> {
    if (!state.worktree) {
      logger.log(`Loop: in-place mode, skipping commit and cleanup`)
      return { committed: false, cleaned: false }
    }

    let committed = false
    let cleaned = false

    try {
      const addResult = spawnSync('git', ['add', '-A'], { cwd: state.worktreeDir, encoding: 'utf-8' })
      if (addResult.status !== 0) {
        throw new Error(addResult.stderr || 'git add failed')
      }

      const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: state.worktreeDir, encoding: 'utf-8' })
      if (statusResult.status !== 0) {
        throw new Error(statusResult.stderr || 'git status failed')
      }
      const status = statusResult.stdout.trim()

      if (status) {
        const message = `loop: ${state.loopName} completed after ${state.iteration} iterations`
        const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: state.worktreeDir, encoding: 'utf-8' })
        if (commitResult.status !== 0) {
          throw new Error(commitResult.stderr || 'git commit failed')
        }
        committed = true
        logger.log(`Loop: committed changes on branch ${state.worktreeBranch}`)
      } else {
        logger.log(`Loop: no uncommitted changes to commit on branch ${state.worktreeBranch}`)
      }
    } catch (err) {
      logger.error(`Loop: failed to commit changes in worktree ${state.worktreeDir}`, err)
    }

    if (state.worktreeDir && state.worktreeBranch) {
      try {
        const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: state.worktreeDir, encoding: 'utf-8' }).trim()
        const gitRoot = resolve(state.worktreeDir, gitCommonDir, '..')
        const removeResult = spawnSync('git', ['worktree', 'remove', '-f', state.worktreeDir], { cwd: gitRoot, encoding: 'utf-8' })
        if (removeResult.status !== 0) {
          throw new Error(removeResult.stderr || 'git worktree remove failed')
        }
        cleaned = true
        logger.log(`Loop: removed worktree ${state.worktreeDir}, branch ${state.worktreeBranch} preserved`)
        
        // Delete graph cache for this worktree scope after successful worktree removal
        if (state.worktreeDir && projectId && dataDir) {
          try {
            const { deleteGraphCacheScope } = await import('../storage/graph-projects')
            const deleted = deleteGraphCacheScope(projectId, state.worktreeDir, dataDir)
            if (deleted) {
              logger.log(`Loop: deleted graph cache for worktree ${state.worktreeDir}`)
            }
          } catch (err) {
            logger.error(`Loop: failed to delete graph cache for worktree ${state.worktreeDir}`, err)
          }
        }
      } catch (err) {
        logger.error(`Loop: failed to remove worktree ${state.worktreeDir}`, err)
      }
    }

    return { committed, cleaned }
  }

  function stopWatchdog(loopName: string): void {
    const interval = stallWatchdogs.get(loopName)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(loopName)
    }
    lastActivityTime.delete(loopName)
    consecutiveStalls.delete(loopName)
    watchdogRunning.delete(loopName)
  }

  function startWatchdog(loopName: string): void {
    stopWatchdog(loopName)
    lastActivityTime.set(loopName, Date.now())
    consecutiveStalls.set(loopName, 0)

    const stallTimeout = loopService.getStallTimeoutMs()

    const interval = setInterval(async () => {
      if (watchdogRunning.get(loopName)) return
      watchdogRunning.set(loopName, true)
      try {
        const lastActivity = lastActivityTime.get(loopName)
        if (!lastActivity) return

        const elapsed = Date.now() - lastActivity
        if (elapsed < stallTimeout) return

        const state = loopService.getActiveState(loopName)
        if (!state?.active) {
          stopWatchdog(loopName)
          return
        }

        const sessionId = state.sessionId
        let statusCheckFailed = false
        try {
          const statusResult = await v2Client.session.status({ directory: state.worktreeDir })
          const statuses = (statusResult.data ?? {}) as Record<string, { type: string }>

          const status = statuses[sessionId]?.type
          const hasActiveWork = status === 'busy' || status === 'retry'

          if (hasActiveWork) {
            lastActivityTime.set(loopName, Date.now())
            logger.log(`Loop watchdog: loop ${loopName} has active work (${status}), resetting timer`)
            return
          }
        } catch (err) {
          logger.error(`Loop watchdog: failed to check session status, treating as stall`, err)
          statusCheckFailed = true
        }

        const stallCount = (consecutiveStalls.get(loopName) ?? 0) + 1
        consecutiveStalls.set(loopName, stallCount)
        lastActivityTime.set(loopName, Date.now())

        if (stallCount >= MAX_CONSECUTIVE_STALLS) {
          logger.error(`Loop watchdog: loop ${loopName} exceeded max consecutive stalls (${MAX_CONSECUTIVE_STALLS}), terminating`)
          await terminateLoop(loopName, state, 'stall_timeout')
          return
        }

        logger.log(`Loop watchdog: stall #${stallCount}/${MAX_CONSECUTIVE_STALLS} for ${loopName} (phase=${state.phase}, elapsed=${elapsed}ms, statusCheckFailed=${statusCheckFailed}), re-triggering`)

        await withStateLock(loopName, async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) return

          try {
            if (freshState.phase === 'auditing') {
              await handleAuditingPhase(loopName, freshState)
            } else {
              await handleCodingPhase(loopName, freshState)
            }
          } catch (err) {
            await handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase`, err)
          }
        })
      } finally {
        watchdogRunning.set(loopName, false)
      }
    }, stallTimeout)

    stallWatchdogs.set(loopName, interval)
    logger.log(`Loop watchdog: started for loop ${loopName} (timeout: ${stallTimeout}ms)`)
  }

  function getStallInfo(loopName: string): { consecutiveStalls: number; lastActivityTime: number } | null {
    const lastActivity = lastActivityTime.get(loopName)
    if (lastActivity === undefined) return null
    return {
      consecutiveStalls: consecutiveStalls.get(loopName) ?? 0,
      lastActivityTime: lastActivity,
    }
  }

  async function terminateLoop(loopName: string, state: LoopState, reason: string): Promise<void> {
    const sessionId = state.sessionId
    stopWatchdog(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    loopService.unregisterLoopSession(sessionId)

    loopService.setState(loopName, {
      ...state,
      active: false,
      completedAt: new Date().toISOString(),
      terminationReason: reason,
    })

    // Request a summary of what was accomplished before terminating the session
    let summaryPromptResult: string | null = null
    if (reason === 'completed' && state.worktree) {
      try {
        logger.log(`Loop: requesting completion summary for ${state.loopName}`)
        const summaryPrompt = 'Please provide a concise summary of what you accomplished in this session. Focus on: (1) what changes were made, (2) what objectives were achieved, and (3) any verification steps that confirm success. Keep it to 2-3 sentences.'
        
        const summaryResult = await v2Client.session.promptAsync({
          sessionID: sessionId,
          directory: state.worktreeDir,
          parts: [{ type: 'text' as const, text: summaryPrompt }],
        })
        
        // Extract the summary from the response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resultData = summaryResult.data as any
        const messages = (resultData?.messages ?? []) as Array<{
          info: { role: string }
          parts: Array<{ type: string; text?: string }>
        }>
        const lastAssistantMsg = [...messages].reverse().find((m) => m.info.role === 'assistant')
        if (lastAssistantMsg) {
          summaryPromptResult = lastAssistantMsg.parts
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text as string)
            .join('\n')
        }
      } catch (err) {
        logger.error(`Loop: failed to request completion summary`, err)
      }
    }

    try {
      await v2Client.session.abort({ sessionID: sessionId })
    } catch {
      // Session may already be idle
    }

    logger.log(`Loop terminated: reason="${reason}", loop="${state.loopName}", iteration=${state.iteration}`)

    // Log worktree completion if configured and loop completed successfully
    if (reason === 'completed' && state.worktree) {
      const sessionOutput = await fetchSessionOutput(v2Client, sessionId, state.worktreeDir, logger)
      const completionTimestamp = new Date()
      
      logWorktreeCompletion(
        getConfig(),
        {
          projectDir: state.projectDir,
          loopName: state.loopName,
          completionTimestamp,
          sessionOutput,
          iteration: state.iteration,
          worktreeBranch: state.worktreeBranch,
          summary: summaryPromptResult || undefined,
          dataDir,
          sandboxHostDir: state.worktreeDir,
        },
        logger,
      )
    }

    if (v2Client.tui) {
      const toastVariant = reason === 'completed' ? 'success'
        : reason === 'cancelled' || reason === 'user_aborted' ? 'info'
        : reason === 'max_iterations' ? 'warning'
        : reason === 'stall_timeout' ? 'error'
        : 'error'

      const toastMessage = reason === 'completed' ? `Completed after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason === 'cancelled' ? 'Loop cancelled'
        : reason === 'max_iterations' ? `Reached max iterations (${state.maxIterations})`
        : reason === 'stall_timeout' ? `Stalled after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
        : reason === 'user_aborted' ? 'Loop aborted by user'
        : `Loop ended: ${reason}`

      v2Client.tui.publish({
        directory: state.worktreeDir,
        body: {
          type: 'tui.toast.show',
          properties: {
            title: state.loopName,
            message: toastMessage,
            variant: toastVariant,
            duration: reason === 'completed' ? 5000 : 3000,
          },
        },
      }).catch((err) => {
        logger.error('Loop: failed to publish toast notification', err)
      })
    }

    if (reason === 'completed' || reason === 'cancelled') {
      await commitAndCleanupWorktree(state)
    }

    if (state.sandbox && state.sandboxContainerName && sandboxManager) {
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
      loopService.setState(loopName, { ...currentState, errorCount: nextErrorCount })
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
      await terminateLoop(loopName, currentState, `error_max_retries: ${context}`)
    }
  }

  async function getLastAssistantInfo(sessionId: string, worktreeDir: string): Promise<{ text: string | null; error: string | null; lastMessageRole: string }> {
    try {
      const messagesResult = await v2Client.session.messages({
        sessionID: sessionId,
        directory: worktreeDir,
        limit: 4,
      })

      const messages = (messagesResult.data ?? []) as Array<{
        info: { role: string; error?: { name?: string; data?: { message?: string } } }
        parts: Array<{ type: string; text?: string }>
      }>

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
      const lastAssistant = [...messages].reverse().find((m) => m.info.role === 'assistant')

      if (!lastAssistant) {
        const role = lastMessage?.info.role ?? 'none'
        logger.log(`Loop: no assistant message found in session ${sessionId}, last message role: ${role}`)
        return { text: null, error: null, lastMessageRole: role }
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

  async function rotateSession(loopName: string, state: LoopState): Promise<string> {
    const oldSessionId = state.sessionId

    // Resolve log target for permission ruleset (pure, no filesystem mutation)
    // Use host project directory for path resolution, worktree for sandbox mapping
    const logTarget = resolveWorktreeLogTarget(getConfig(), {
      projectDir: state.projectDir,
      sandboxHostDir: state.worktreeDir,
      sandbox: state.sandbox,
      dataDir,
    }, logger)
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(getConfig(), logTarget?.permissionPath ?? null, {
      isWorktree: !!state.worktree,
      agentExclusions,
    })

    const createParams = {
      title: state.loopName,
      directory: state.worktreeDir,
      permission: permissionRuleset,
    }

    const createResult = await v2Client.session.create(createParams)

    if (createResult.error || !createResult.data) {
      throw new Error(`Failed to create new session: ${createResult.error}`)
    }

    const newSessionId = createResult.data.id

    const oldRetryTimeout = retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(loopName)
    }

    loopService.unregisterLoopSession(oldSessionId)
    loopService.registerLoopSession(newSessionId, loopName)

    stopWatchdog(loopName)
    startWatchdog(loopName)

    v2Client.session.delete({ sessionID: oldSessionId, directory: state.worktreeDir }).catch((err) => {
      logger.error(`Loop: failed to delete old session ${oldSessionId}`, err)
    })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    if (!state.worktree && v2Client.tui) {
      v2Client.tui.selectSession({ sessionID: newSessionId }).catch((err) => {
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
      const nextErrorCount = (currentState.errorCount ?? 0) + 1
      if (nextErrorCount >= MAX_RETRIES) {
        await terminateLoop(loopName, currentState, `error_max_retries: assistant error: ${assistantError}`)
        return null
      }
      loopService.setState(loopName, { ...currentState, modelFailed: true, errorCount: nextErrorCount })
      logger.log(`Loop: marking model as failed, will fall back to default model (error ${nextErrorCount}/${MAX_RETRIES})`)
      return { assistantErrorDetected: true, currentState: loopService.getActiveState(loopName)! }
    }

    return { assistantErrorDetected: true, currentState }
  }

  /**
   * Shared: check completion signal and terminate if ready.
   * Returns true if the loop was terminated (caller should return).
   */
  async function checkCompletionAndTerminate(
    loopName: string,
    currentState: LoopState,
    textContent: string | null,
    auditCount: number,
  ): Promise<boolean> {
    if (!currentState.completionSignal || !textContent) return false
    if (!loopService.checkCompletionSignal(textContent, currentState.completionSignal)) return false

    if (!currentState.audit || auditCount >= minAudits) {
      if (loopService.hasOutstandingFindings(currentState.worktreeBranch)) {
        logger.log(`Loop: completion promise detected but outstanding review findings remain, continuing`)
        return false
      }
      await terminateLoop(loopName, currentState, 'completed')
      logger.log(`Loop completed: detected ${currentState.completionSignal} at iteration ${currentState.iteration} (${auditCount}/${minAudits} audits)`)
      return true
    }

    logger.log(`Loop: completion promise detected but only ${auditCount}/${minAudits} audits performed, continuing`)
    return false
  }

  /**
   * Shared: reset error count after a successful (non-error) iteration.
   */
  function resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.setState(loopName, { ...currentState, errorCount: 0, modelFailed: false })
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

    loopService.setState(loopName, {
      ...currentState,
      sessionId: activeSessionId,
      errorCount: assistantErrorDetected ? currentState.errorCount : 0,
      modelFailed: assistantErrorDetected ? currentState.modelFailed : false,
      ...stateUpdates,
    })

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, loopService, loopName)
    if (!loopModel) {
      logger.log(`Loop: configured model previously failed, using default model`)
    }

    const sendWithModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const result = await v2Client.session.promptAsync({
        sessionID: activeSessionId,
        directory: freshState.worktreeDir,
        parts: [{ type: 'text' as const, text: continuationPrompt }],
        model: loopModel,
      })
      return { data: result.data, error: result.error }
    }

    const sendWithoutModel = async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) {
        throw new Error('loop_cancelled')
      }
      const result = await v2Client.session.promptAsync({
        sessionID: activeSessionId,
        directory: freshState.worktreeDir,
        parts: [{ type: 'text' as const, text: continuationPrompt }],
      })
      return { data: result.data, error: result.error }
    }

    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
      sendWithModel,
      sendWithoutModel,
      loopModel,
      logger,
    )

    if (promptResult.error) {
      const retryFn = async () => {
        const freshState = loopService.getActiveState(loopName)
        if (!freshState?.active) {
          throw new Error('loop_cancelled')
        }
        const result = await sendWithoutModel()
        if (result.error) {
          await handlePromptError(loopName, currentState, `retry failed ${errorContext}`, result.error)
          return
        }
      }
      await handlePromptError(loopName, currentState, `failed to send continuation prompt ${errorContext}`, promptResult.error, retryFn)
      return
    }

    if (actualModel) {
      logger.log(`${errorContext} using model: ${actualModel.providerID}/${actualModel.modelID}`)
    } else {
      logger.log(`${errorContext} using default model (fallback)`)
    }

    consecutiveStalls.set(loopName, 0)
  }

  async function handleCodingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping coding phase`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    let assistantErrorDetected = false
    if (currentState.completionSignal) {
      const { text: textContent, error: assistantError, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
      if (lastMessageRole !== 'assistant') {
        logger.error(`Loop: assistant message not found in coding phase (last message: ${lastMessageRole}), session may not have responded yet`)
        return
      }

      const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'coding')
      if (!errorResult) return
      assistantErrorDetected = errorResult.assistantErrorDetected
      currentState = errorResult.currentState

      if (await checkCompletionAndTerminate(loopName, currentState, textContent, currentState.auditCount ?? 0)) return
    }

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')

    if ((currentState.maxIterations ?? 0) > 0 && (currentState.iteration ?? 0) >= (currentState.maxIterations ?? 0)) {
      await terminateLoop(loopName, currentState, 'max_iterations')
      return
    }

    if (currentState.audit) {
      loopService.setState(loopName, { ...currentState, phase: 'auditing', errorCount: 0 })
      logger.log(`Loop iteration ${currentState.iteration ?? 0} complete, running auditor for session ${currentState.sessionId}`)

      const auditPrompt = {
        sessionID: currentState.sessionId,
        directory: currentState.worktreeDir,
        parts: [{
          type: 'subtask' as const,
          agent: 'auditor',
          description: `Post-iteration ${currentState.iteration} code review`,
          prompt: loopService.buildAuditPrompt(currentState),
        }],
      }

      const promptResult = await v2Client.session.promptAsync(auditPrompt)

      if (promptResult.error) {
        const retryFn = async () => {
          const result = await v2Client.session.promptAsync(auditPrompt)
          if (result.error) {
            throw result.error
          }
        }
        await handlePromptError(loopName, { ...currentState, phase: 'coding' }, 'failed to send audit prompt', promptResult.error, retryFn)
        return
      }

      const currentConfig = getConfig()
      const configuredModel = currentConfig.auditorModel ?? currentConfig.loop?.model ?? currentConfig.executionModel
      logger.log(`auditor using agent-configured model: ${configuredModel ?? 'default'}`)

      consecutiveStalls.set(loopName, 0)
      return
    }

    const nextIteration = (currentState.iteration ?? 0) + 1
    const continuationPrompt = loopService.buildContinuationPrompt({ ...currentState, iteration: nextIteration })

    await rotateAndSendContinuation(
      loopName,
      currentState,
      { iteration: nextIteration },
      continuationPrompt,
      assistantErrorDetected,
      'coding phase',
    )
  }

  async function handleAuditingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping auditing phase`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in auditing phase, terminating`)
      await terminateLoop(loopName, currentState, 'missing_worktree_dir')
      return
    }

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      logger.error(`Loop: assistant message not found in auditing phase (last message: ${lastMessageRole}), session may not have responded yet`)
      return
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    const nextIteration = (currentState.iteration ?? 0) + 1
    const newAuditCount = (currentState.auditCount ?? 0) + 1
    logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

    const auditFindings = auditText ?? undefined

    if (await checkCompletionAndTerminate(loopName, currentState, auditText, newAuditCount)) return

    if ((currentState.maxIterations ?? 0) > 0 && nextIteration > (currentState.maxIterations ?? 0)) {
      await terminateLoop(loopName, currentState, 'max_iterations')
      return
    }

    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...currentState, iteration: nextIteration },
      auditFindings,
    )

    await rotateAndSendContinuation(
      loopName,
      currentState,
      {
        iteration: nextIteration,
        phase: 'coding',
        lastAuditResult: auditFindings,
        auditCount: newAuditCount,
      },
      continuationPrompt,
      assistantErrorDetected,
      'coding continuation',
    )
  }

  async function onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> {
    const { event } = input

    if (event.type === 'worktree.failed') {
      const message = event.properties?.message as string
      const directory = event.properties?.directory as string
      logger.error(`Loop: worktree failed: ${message}`)
      
      if (directory) {
        const activeLoops = loopService.listActive()
        const affectedLoop = activeLoops.find((s) => s.worktreeDir === directory)
        if (affectedLoop) {
          await terminateLoop(affectedLoop.loopName!, affectedLoop, `worktree_failed: ${message}`)
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
        const state = loopService.getActiveState(loopName)
        if (state?.active) {
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(loopName, state, 'user_aborted')
        }
        return
      }

      const loopName = loopService.resolveLoopName(eventSessionId)
      if (!loopName) return
      const state = loopService.getActiveState(loopName)
      if (state?.active) {
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        logger.error(`Loop: session error for ${eventSessionId}: ${errorMessage}`)
        const isModelError = /provider|auth|model|api\s*error/i.test(errorMessage)
        if (isModelError && !state.modelFailed) {
          logger.log(`Loop: marking model as failed, will fall back to default on next iteration`)
          loopService.setState(loopName, { ...state, modelFailed: true })
        }
      }
      return
    }

    if (event.type !== 'session.idle') return

    const sessionId = event.properties?.sessionID as string
    if (!sessionId) return

    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return

    await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      if (state.sessionId !== sessionId) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current: ${state.sessionId})`)
        return
      }

      try {
        startWatchdog(loopName)
        
        if (state.phase === 'auditing') {
          await handleAuditingPhase(loopName, state)
        } else {
          await handleCodingPhase(loopName, state)
        }
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
  }

  function terminateAll(): void {
    loopService.terminateAll()
  }

  function clearAllRetryTimeouts(): void {
    for (const [worktreeName, timeout] of retryTimeouts.entries()) {
      clearTimeout(timeout)
      retryTimeouts.delete(worktreeName)
    }
    for (const [worktreeName, interval] of stallWatchdogs.entries()) {
      clearInterval(interval)
      stallWatchdogs.delete(worktreeName)
    }
    lastActivityTime.clear()
    consecutiveStalls.clear()
    watchdogRunning.clear()
    stateLocks.clear()
    logger.log('Loop: cleared all retry timeouts')
  }

  async function cancelBySessionId(sessionId: string): Promise<boolean> {
    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, 'cancelled')
    return true
  }

  return {
    onEvent,
    terminateAll,
    clearAllRetryTimeouts,
    startWatchdog,
    getStallInfo,
    cancelBySessionId,
  }
}
