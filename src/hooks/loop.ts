import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService, LoopState } from '../services/loop'
import { MAX_RETRIES, MAX_CONSECUTIVE_STALLS, LOOP_PERMISSION_RULESET } from '../services/loop'
import type { Logger, PluginConfig } from '../types'
import { retryWithModelFallback } from '../utils/model-fallback'
import { resolveLoopModel } from '../utils/loop-helpers'
import { execSync, spawnSync } from 'child_process'
import { resolve } from 'path'
import type { createSandboxManager } from '../sandbox/manager'

export interface LoopEventHandler {
  onEvent(input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void>
  terminateAll(): void
  clearAllRetryTimeouts(): void
  startWatchdog(worktreeName: string): void
  getStallInfo(worktreeName: string): { consecutiveStalls: number; lastActivityTime: number } | null
  cancelBySessionId(sessionId: string): Promise<boolean>
}

export function createLoopEventHandler(
  loopService: LoopService,
  _client: PluginInput['client'],
  v2Client: OpencodeClient,
  logger: Logger,
  getConfig: () => PluginConfig,
  sandboxManager?: ReturnType<typeof createSandboxManager>,
): LoopEventHandler {
  const minAudits = loopService.getMinAudits()
  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const lastActivityTime = new Map<string, number>()
  const stallWatchdogs = new Map<string, NodeJS.Timeout>()
  const consecutiveStalls = new Map<string, number>()
  const watchdogRunning = new Map<string, boolean>()
  const stateLocks = new Map<string, Promise<void>>()

  function withStateLock(worktreeName: string, fn: () => Promise<void>): Promise<void> {
    const prev = stateLocks.get(worktreeName) ?? Promise.resolve()
    const next = prev.then(fn, fn).finally(() => {
      if (stateLocks.get(worktreeName) === next) {
        stateLocks.delete(worktreeName)
      }
    })
    stateLocks.set(worktreeName, next)
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
        const message = `loop: ${state.worktreeName} completed after ${state.iteration} iterations`
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
      } catch (err) {
        logger.error(`Loop: failed to remove worktree ${state.worktreeDir}`, err)
      }
    }

    return { committed, cleaned }
  }

  function stopWatchdog(worktreeName: string): void {
    const interval = stallWatchdogs.get(worktreeName)
    if (interval) {
      clearInterval(interval)
      stallWatchdogs.delete(worktreeName)
    }
    lastActivityTime.delete(worktreeName)
    consecutiveStalls.delete(worktreeName)
    watchdogRunning.delete(worktreeName)
  }

  function startWatchdog(worktreeName: string): void {
    stopWatchdog(worktreeName)
    lastActivityTime.set(worktreeName, Date.now())
    consecutiveStalls.set(worktreeName, 0)

    const stallTimeout = loopService.getStallTimeoutMs()

    const interval = setInterval(async () => {
      if (watchdogRunning.get(worktreeName)) return
      watchdogRunning.set(worktreeName, true)
      try {
        const lastActivity = lastActivityTime.get(worktreeName)
        if (!lastActivity) return

        const elapsed = Date.now() - lastActivity
        if (elapsed < stallTimeout) return

        const state = loopService.getActiveState(worktreeName)
        if (!state?.active) {
          stopWatchdog(worktreeName)
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
            lastActivityTime.set(worktreeName, Date.now())
            logger.log(`Loop watchdog: worktree ${worktreeName} has active work (${status}), resetting timer`)
            return
          }
        } catch (err) {
          logger.error(`Loop watchdog: failed to check session status, treating as stall`, err)
          statusCheckFailed = true
        }

        const stallCount = (consecutiveStalls.get(worktreeName) ?? 0) + 1
        consecutiveStalls.set(worktreeName, stallCount)
        lastActivityTime.set(worktreeName, Date.now())

        if (stallCount >= MAX_CONSECUTIVE_STALLS) {
          logger.error(`Loop watchdog: worktree ${worktreeName} exceeded max consecutive stalls (${MAX_CONSECUTIVE_STALLS}), terminating`)
          await terminateLoop(worktreeName, state, 'stall_timeout')
          return
        }

        logger.log(`Loop watchdog: stall #${stallCount}/${MAX_CONSECUTIVE_STALLS} for ${worktreeName} (phase=${state.phase}, elapsed=${elapsed}ms, statusCheckFailed=${statusCheckFailed}), re-triggering`)

        await withStateLock(worktreeName, async () => {
          const freshState = loopService.getActiveState(worktreeName)
          if (!freshState?.active) return

          try {
            if (freshState.phase === 'auditing') {
              await handleAuditingPhase(worktreeName, freshState)
            } else {
              await handleCodingPhase(worktreeName, freshState)
            }
          } catch (err) {
            await handlePromptError(worktreeName, freshState, `watchdog recovery in ${freshState.phase} phase`, err)
          }
        })
      } finally {
        watchdogRunning.set(worktreeName, false)
      }
    }, stallTimeout)

    stallWatchdogs.set(worktreeName, interval)
    logger.log(`Loop watchdog: started for worktree ${worktreeName} (timeout: ${stallTimeout}ms)`)
  }

  function getStallInfo(worktreeName: string): { consecutiveStalls: number; lastActivityTime: number } | null {
    const lastActivity = lastActivityTime.get(worktreeName)
    if (lastActivity === undefined) return null
    return {
      consecutiveStalls: consecutiveStalls.get(worktreeName) ?? 0,
      lastActivityTime: lastActivity,
    }
  }

  async function terminateLoop(worktreeName: string, state: LoopState, reason: string): Promise<void> {
    const sessionId = state.sessionId
    stopWatchdog(worktreeName)

    const retryTimeout = retryTimeouts.get(worktreeName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(worktreeName)
    }

    loopService.unregisterSession(sessionId)

    loopService.setState(worktreeName, {
      ...state,
      active: false,
      completedAt: new Date().toISOString(),
      terminationReason: reason,
    })

    try {
      await v2Client.session.abort({ sessionID: sessionId })
    } catch {
      // Session may already be idle
    }

    logger.log(`Loop terminated: reason="${reason}", worktree="${state.worktreeName}", iteration=${state.iteration}`)

    if (v2Client.tui) {
      const toastVariant = reason === 'completed' ? 'success'
        : reason === 'cancelled' || reason === 'user_aborted' ? 'info'
        : reason === 'max_iterations' ? 'warning'
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
            title: state.worktreeName,
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
        await sandboxManager.stop(state.worktreeName)
        logger.log(`Loop: stopped sandbox container for ${state.worktreeName}`)
      } catch (err) {
        logger.error(`Loop: failed to stop sandbox container`, err)
      }
    }
  }

  async function handlePromptError(worktreeName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
    const currentState = loopService.getActiveState(worktreeName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${worktreeName} already terminated, ignoring error: ${context}`)
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1
    
    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, err)
      loopService.setState(worktreeName, { ...currentState, errorCount: nextErrorCount })
      if (retryFn) {
        const retryTimeout = setTimeout(async () => {
          const freshState = loopService.getActiveState(worktreeName)
          if (!freshState?.active) {
            logger.log(`Loop: loop cancelled, skipping retry`)
            retryTimeouts.delete(worktreeName)
            return
          }
          try {
            await retryFn()
          } catch (retryErr) {
            await handlePromptError(worktreeName, freshState, context, retryErr, retryFn)
          }
        }, 2000)
        retryTimeouts.set(worktreeName, retryTimeout)
      }
    } else {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, err)
      await terminateLoop(worktreeName, currentState, `error_max_retries: ${context}`)
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

  async function rotateSession(worktreeName: string, state: LoopState): Promise<string> {
    const oldSessionId = state.sessionId

    const createParams = {
      title: state.worktreeName,
      directory: state.worktreeDir,
      permission: LOOP_PERMISSION_RULESET,
    }

    const createResult = await v2Client.session.create(createParams)

    if (createResult.error || !createResult.data) {
      throw new Error(`Failed to create new session: ${createResult.error}`)
    }

    const newSessionId = createResult.data.id

    const oldRetryTimeout = retryTimeouts.get(worktreeName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(worktreeName)
    }

    loopService.unregisterSession(oldSessionId)
    loopService.registerSession(newSessionId, worktreeName)

    stopWatchdog(worktreeName)
    startWatchdog(worktreeName)

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
    worktreeName: string,
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
        await terminateLoop(worktreeName, currentState, `error_max_retries: assistant error: ${assistantError}`)
        return null
      }
      loopService.setState(worktreeName, { ...currentState, modelFailed: true, errorCount: nextErrorCount })
      logger.log(`Loop: marking model as failed, will fall back to default model (error ${nextErrorCount}/${MAX_RETRIES})`)
      return { assistantErrorDetected: true, currentState: loopService.getActiveState(worktreeName)! }
    }

    return { assistantErrorDetected: true, currentState }
  }

  /**
   * Shared: check completion signal and terminate if ready.
   * Returns true if the loop was terminated (caller should return).
   */
  async function checkCompletionAndTerminate(
    worktreeName: string,
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
      await terminateLoop(worktreeName, currentState, 'completed')
      logger.log(`Loop completed: detected ${currentState.completionSignal} at iteration ${currentState.iteration} (${auditCount}/${minAudits} audits)`)
      return true
    }

    logger.log(`Loop: completion promise detected but only ${auditCount}/${minAudits} audits performed, continuing`)
    return false
  }

  /**
   * Shared: reset error count after a successful (non-error) iteration.
   */
  function resetErrorCountIfNeeded(worktreeName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.setState(worktreeName, { ...currentState, errorCount: 0, modelFailed: false })
      logger.log(`Loop: resetting error count after successful retry in ${phase} phase`)
      return loopService.getActiveState(worktreeName)!
    }
    return currentState
  }

  /**
   * Shared: rotate session and send continuation prompt with model fallback.
   */
  async function rotateAndSendContinuation(
    worktreeName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
  ): Promise<void> {
    let activeSessionId = currentState.sessionId
    try {
      activeSessionId = await rotateSession(worktreeName, currentState)
    } catch (err) {
      logger.error(`Loop: session rotation failed, continuing with existing session`, err)
    }

    loopService.setState(worktreeName, {
      ...currentState,
      sessionId: activeSessionId,
      errorCount: assistantErrorDetected ? currentState.errorCount : 0,
      modelFailed: assistantErrorDetected ? currentState.modelFailed : false,
      ...stateUpdates,
    })

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, loopService, worktreeName)
    if (!loopModel) {
      logger.log(`Loop: configured model previously failed, using default model`)
    }

    const sendWithModel = async () => {
      const freshState = loopService.getActiveState(worktreeName)
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
      const freshState = loopService.getActiveState(worktreeName)
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
        const freshState = loopService.getActiveState(worktreeName)
        if (!freshState?.active) {
          throw new Error('loop_cancelled')
        }
        const result = await sendWithoutModel()
        if (result.error) {
          await handlePromptError(worktreeName, currentState, `retry failed ${errorContext}`, result.error)
          return
        }
      }
      await handlePromptError(worktreeName, currentState, `failed to send continuation prompt ${errorContext}`, promptResult.error, retryFn)
      return
    }

    if (actualModel) {
      logger.log(`${errorContext} using model: ${actualModel.providerID}/${actualModel.modelID}`)
    } else {
      logger.log(`${errorContext} using default model (fallback)`)
    }

    consecutiveStalls.set(worktreeName, 0)
  }

  async function handleCodingPhase(worktreeName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(worktreeName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${worktreeName} no longer active, skipping coding phase`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${worktreeName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(worktreeName, currentState, 'missing_worktree_dir')
      return
    }

    let assistantErrorDetected = false
    if (currentState.completionSignal) {
      const { text: textContent, error: assistantError, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
      if (lastMessageRole !== 'assistant') {
        logger.error(`Loop: assistant message not found in coding phase (last message: ${lastMessageRole}), session may not have responded yet`)
        return
      }

      const errorResult = await detectAndHandleAssistantError(worktreeName, currentState, assistantError, 'coding')
      if (!errorResult) return
      assistantErrorDetected = errorResult.assistantErrorDetected
      currentState = errorResult.currentState

      if (await checkCompletionAndTerminate(worktreeName, currentState, textContent, currentState.auditCount ?? 0)) return
    }

    currentState = resetErrorCountIfNeeded(worktreeName, currentState, assistantErrorDetected, 'coding')

    if ((currentState.maxIterations ?? 0) > 0 && (currentState.iteration ?? 0) >= (currentState.maxIterations ?? 0)) {
      await terminateLoop(worktreeName, currentState, 'max_iterations')
      return
    }

    if (currentState.audit) {
      loopService.setState(worktreeName, { ...currentState, phase: 'auditing', errorCount: 0 })
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
        await handlePromptError(worktreeName, { ...currentState, phase: 'coding' }, 'failed to send audit prompt', promptResult.error, retryFn)
        return
      }

      const currentConfig = getConfig()
      const configuredModel = currentConfig.auditorModel ?? currentConfig.loop?.model ?? currentConfig.executionModel
      logger.log(`auditor using agent-configured model: ${configuredModel ?? 'default'}`)

      consecutiveStalls.set(worktreeName, 0)
      return
    }

    const nextIteration = (currentState.iteration ?? 0) + 1
    const continuationPrompt = loopService.buildContinuationPrompt({ ...currentState, iteration: nextIteration })

    await rotateAndSendContinuation(
      worktreeName,
      currentState,
      { iteration: nextIteration },
      continuationPrompt,
      assistantErrorDetected,
      'coding phase',
    )
  }

  async function handleAuditingPhase(worktreeName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(worktreeName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${worktreeName} no longer active, skipping auditing phase`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${worktreeName} missing worktreeDir in auditing phase, terminating`)
      await terminateLoop(worktreeName, currentState, 'missing_worktree_dir')
      return
    }

    const { text: auditText, error: assistantError, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

    if (lastMessageRole !== 'assistant') {
      logger.error(`Loop: assistant message not found in auditing phase (last message: ${lastMessageRole}), session may not have responded yet`)
      return
    }

    const errorResult = await detectAndHandleAssistantError(worktreeName, currentState, assistantError, 'auditing')
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(worktreeName, currentState, assistantErrorDetected, 'auditing')

    const nextIteration = (currentState.iteration ?? 0) + 1
    const newAuditCount = (currentState.auditCount ?? 0) + 1
    logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

    const auditFindings = auditText ?? undefined

    if (await checkCompletionAndTerminate(worktreeName, currentState, auditText, newAuditCount)) return

    if ((currentState.maxIterations ?? 0) > 0 && nextIteration > (currentState.maxIterations ?? 0)) {
      await terminateLoop(worktreeName, currentState, 'max_iterations')
      return
    }

    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...currentState, iteration: nextIteration },
      auditFindings,
    )

    await rotateAndSendContinuation(
      worktreeName,
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
          await terminateLoop(affectedLoop.worktreeName, affectedLoop, `worktree_failed: ${message}`)
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
        const worktreeName = loopService.resolveWorktreeName(eventSessionId)
        if (!worktreeName) return
        const state = loopService.getActiveState(worktreeName)
        if (state?.active) {
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(worktreeName, state, 'user_aborted')
        }
        return
      }

      const worktreeName = loopService.resolveWorktreeName(eventSessionId)
      if (!worktreeName) return
      const state = loopService.getActiveState(worktreeName)
      if (state?.active) {
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        logger.error(`Loop: session error for ${eventSessionId}: ${errorMessage}`)
        const isModelError = /provider|auth|model|api\s*error/i.test(errorMessage)
        if (isModelError && !state.modelFailed) {
          logger.log(`Loop: marking model as failed, will fall back to default on next iteration`)
          loopService.setState(worktreeName, { ...state, modelFailed: true })
        }
      }
      return
    }

    if (event.type !== 'session.idle') return

    const sessionId = event.properties?.sessionID as string
    if (!sessionId) return

    const worktreeName = loopService.resolveWorktreeName(sessionId)
    if (!worktreeName) return

    await withStateLock(worktreeName, async () => {
      const state = loopService.getActiveState(worktreeName)
      if (!state || !state.active) return

      if (state.sessionId !== sessionId) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current: ${state.sessionId})`)
        return
      }

      try {
        startWatchdog(worktreeName)
        
        if (state.phase === 'auditing') {
          await handleAuditingPhase(worktreeName, state)
        } else {
          await handleCodingPhase(worktreeName, state)
        }
      } catch (err) {
        const freshState = loopService.getActiveState(worktreeName)
        await handlePromptError(worktreeName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
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
    const worktreeName = loopService.resolveWorktreeName(sessionId)
    if (!worktreeName) return false
    const state = loopService.getActiveState(worktreeName)
    if (!state?.active) return false
    await terminateLoop(worktreeName, state, 'cancelled')
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
