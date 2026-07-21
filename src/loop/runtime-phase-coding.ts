import type { RuntimeContext, PhaseRunnerCollaborators } from './runtime-context'
import type { LoopState } from './state'
import type { TerminationReason } from './termination'
import { MAX_RETRIES } from './service'
import { classifyProviderLimit } from './provider-limit'
import { parseCoderDecisions } from '../utils/coder-decisions'
import { clearPromptPending } from './idle-gate'
import { nextTransition } from './transitions'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { resolveLoopAllowedDirectories } from '../constants/loop'
import { isWorkspaceNotFoundError } from './runtime-workspace'

const IDLE_RETRY_DELAY_MS = 1500
const MAX_IDLE_RETRIES = 1
const MAX_CODE_LAUNCH_RECOVERIES = MAX_RETRIES

export interface CodingPhase {
  runCodingPhase(loopName: string, state: LoopState): Promise<void>
  recoverCodeLaunchWithoutAssistant(loopName: string, state: LoopState, lastMessageRole: string): Promise<void>
  buildCodingPromptForCurrentState(state: LoopState): string
  handleIdleNoAssistantGate(
    loopName: string,
    currentState: LoopState,
    lastMessageRole: string,
    opts: { phaseLabel: string; exhaustedReason: TerminationReason; rerun: (loopName: string, state: LoopState) => Promise<void> },
  ): Promise<boolean>
  detectAndHandleAssistantError(
    loopName: string,
    currentState: LoopState,
    assistantError: string | null,
    phase: string,
    errorSignal?: { name?: string; message?: string; statusCode?: number } | null,
  ): Promise<{ assistantErrorDetected: boolean; currentState: LoopState } | null>
  resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState
}

export function createCodingPhase(ctx: RuntimeContext, collab: PhaseRunnerCollaborators): CodingPhase {
  const { logger, client, getConfig, transitionLog, sessions, promptRetry, promptDispatch, workspace, termination } = collab
  const { loopService } = ctx
  const { logTransition } = transitionLog
  const { rotateSession, scheduleSessionDelete } = sessions
  const { handlePromptError, buildPromptRetryFn, sendPromptWithRetryRecovery } = promptRetry
  const { sendPromptWithFallback, getLastAssistantInfo } = promptDispatch
  const { ensureWorkspaceForLoop, recoverFromMissingWorkspace } = workspace
  const { terminateLoop } = termination

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
    errorSignal?: { name?: string; message?: string; statusCode?: number } | null,
  ): Promise<{ assistantErrorDetected: boolean; currentState: LoopState } | null> {
    if (!assistantError) {
      return { assistantErrorDetected: false, currentState }
    }

    logger.error(`Loop: assistant error detected in ${phase} phase: ${assistantError}`)

    const limitReason = classifyProviderLimit(errorSignal ?? {})
    if (limitReason) {
      logger.error(`Loop: provider limit detected in ${phase} assistant error for ${loopName}: ${limitReason}, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
      return null
    }

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

  function buildCodingPromptForCurrentState(state: LoopState): string {
    if (state.phase === 'final_audit_fix') {
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
    const attempts = (ctx.codingLaunchRecoveryAttempts.get(loopName) ?? 0) + 1
    ctx.codingLaunchRecoveryAttempts.set(loopName, attempts)

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
      await sendPromptWithRetryRecovery({
        loopName,
        sessionId: codeSessionId,
        promptText: recoveryPrompt,
        agent: 'code',
        model: resolveLoopModel(currentConfig, loopService, loopName),
        variant: freshState.executionVariant,
        errorContext: 'failed to recover code launch',
        sendErrorContext: 'failed to recover code launch',
        errorState: freshState,
        onSendError: () => clearPromptPending(loopName, logger),
        isRetryValid: (fresh) => fresh.phase === 'coding' && fresh.sessionId === codeSessionId,
        send: async (fresh) => {
          await client.session.promptAsync({
            sessionID: codeSessionId,
            directory: fresh.worktreeDir,
            ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: recoveryPrompt }],
          })
        },
      })
    } catch (err) {
      logger.error(`Loop: failed to recover code launch for ${loopName}`, err)
      await handlePromptError(loopName, state, 'failed to recover code launch', err)
    }
  }

  /**
   * Shared idle/no-assistant gate for the auditing, final_auditing, and post_action phases.
   * If the last message is not from the assistant, schedules a bounded retry (re-invoking `rerun`)
   * or terminates with `exhaustedReason` once MAX_IDLE_RETRIES is reached. When an assistant message
   * is present it clears any pending idle-retry timer/attempts. Returns true when the caller should
   * return early (retry scheduled or loop terminated).
   */
  async function handleIdleNoAssistantGate(
    loopName: string,
    currentState: LoopState,
    lastMessageRole: string,
    opts: { phaseLabel: string; exhaustedReason: TerminationReason; rerun: (loopName: string, state: LoopState) => Promise<void> },
  ): Promise<boolean> {
    if (lastMessageRole !== 'assistant') {
      const attempts = ctx.idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: ${opts.phaseLabel} retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        ctx.idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, opts.exhaustedReason)
        return true
      }
      logger.log(`Loop: ${opts.phaseLabel} idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      ctx.idleRetryAttempts.set(loopName, attempts + 1)
      const phase = currentState.phase
      const t = setTimeout(() => {
        void ctx.withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== phase) return
          await opts.rerun(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      ctx.idleRetryTimeouts.set(loopName, t)
      return true
    }
    const pending = ctx.idleRetryTimeouts.get(loopName)
    if (pending) { clearTimeout(pending); ctx.idleRetryTimeouts.delete(loopName) }
    if (ctx.idleRetryAttempts.has(loopName)) { ctx.idleRetryAttempts.delete(loopName) }
    return false
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

    // Classify persisted provider-limit errors before the no-assistant gate.
    // A finish:'error' assistant message has lastMessageRole 'assistant:error'
    // which the gate treats as missing, but a provider limit must terminate
    // immediately rather than entering the idle-retry path.
    if (assistantInfo.errorSignal) {
      const limitReason = classifyProviderLimit(assistantInfo.errorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted coding error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (lastMessageRole !== 'assistant') {
      const attempts = ctx.idleRetryAttempts.get(loopName) ?? 0
      if (attempts < MAX_IDLE_RETRIES) {
        logger.log(`Loop: coding idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
        ctx.idleRetryAttempts.set(loopName, attempts + 1)
        const sessionId = currentState.sessionId
        const t = setTimeout(async () => {
          ctx.idleRetryTimeouts.delete(loopName)
          await ctx.withStateLock(loopName, async () => {
            const retryState = loopService.getActiveState(loopName)
            if (!retryState?.active || retryState.phase !== 'coding' || retryState.sessionId !== sessionId) return
            await runCodingPhase(loopName, retryState)
          })
        }, IDLE_RETRY_DELAY_MS)
        ctx.idleRetryTimeouts.set(loopName, t)
        return
      }

      logger.log(`Loop: coding phase has no assistant response for ${loopName} after retry (last message: ${lastMessageRole}); recovering code launch`)
      ctx.idleRetryAttempts.delete(loopName)
      await recoverCodeLaunchWithoutAssistant(loopName, currentState, lastMessageRole)
      return
    }

    const pending = ctx.idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      ctx.idleRetryTimeouts.delete(loopName)
    }
    if (ctx.idleRetryAttempts.has(loopName)) {
      ctx.idleRetryAttempts.delete(loopName)
    }
    ctx.codingLaunchRecoveryAttempts.delete(loopName)

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'coding', assistantInfo.errorSignal)
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')

    // Parse coder decisions from the coding assistant's response and store for the audit prompt.
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    // Phase-runner dispatch (see phaseRunners below) routes a final_audit_fix loop
    // to runFinalAuditFixPhase, so runCodingPhase only handles the regular coding phase.
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
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
      allowDirectories?: string[]
    }, attempts = MAX_RETRIES): Promise<{ auditSessionId: string; boundWorkspaceId?: string; bindFailed: boolean; bindError?: unknown } | null> {
      for (let i = 0; i < attempts; i++) {
        const created = await createAuditSession({ client, ...input, logger })
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
      auditorModel,
      prompt: auditPrompt,
      allowDirectories: resolveLoopAllowedDirectories(currentConfig),
    })

    if (!created) {
      logger.error(`Loop: audit session creation failed after ${MAX_RETRIES} attempts for ${loopName}, rotating to fresh code session`)
      loopService.resetError(loopName)
      try {
        const rotatedSessionId = await rotateSession(loopName, currentState)
        loopService.replaceSession(loopName, {
          newSessionId: rotatedSessionId,
          phase: 'coding',
          resetError: false,
          ...(currentState.kind === 'goal' ? { executorSessionId: rotatedSessionId } : {}),
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
          await handlePromptError(loopName, loopService.getActiveState(loopName) ?? currentState, 'failed to send continuation prompt after audit creation failure', promptErr)
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

    // Consult the pure transition table for the coding→auditing rotation.
    // Every phase change must flow through nextTransition so the table is the
    // single source of truth (fixed finding runtime.ts:1369).
    const idleTrans = nextTransition(currentState, { type: 'coding-idle-complete' })
    if (idleTrans.kind === 'terminate') {
      await terminateLoop(loopName, currentState, idleTrans.reason)
      return
    }
    if (idleTrans.kind !== 'rotate') {
      return
    }

    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    ctx.sessionToLoop.set(codeSessionId, loopName)
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })
    ctx.sessionToLoop.set(created.auditSessionId, loopName)

    // Record the coding→auditing rotation derived from the pure transition
    // table.  logTransition (non-terminal-only wrapper) writes the row.
    logTransition(loopName, currentState, { type: 'coding-idle-complete' }, idleTrans, 'auditing')

    // The retired session is a code session.
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
      let effectiveErr: unknown = auditPromptErr
      if (isWorkspaceNotFoundError(auditPromptErr) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const auditPromptText = loopService.buildAuditPrompt(currentState)
          const retryResult = await promptAuditSession(client, {
            sessionId: created.auditSessionId,
            worktreeDir: currentState.worktreeDir,
            workspaceId: currentState.workspaceId,
            prompt: auditPromptText,
            auditorModel,
            auditorVariant: currentState.auditorVariant,
          })
          if (retryResult.ok) {
            logger.log(`Loop: recovered audit prompt after workspace re-bind for ${loopName}`)
            ctx.watchdog.recordActivity(loopName, 'audit-recover')
            return
          }
          // Resend failed — use the actual resend error for classification and retry
          effectiveErr = retryResult.error
        }
      }
      const retryFn = buildPromptRetryFn({
        loopName,
        sessionId: created.auditSessionId,
        agent: 'auditor-loop',
        errorContext: 'failed to send audit prompt',
        send: async (fresh) => {
          const retryResult = await promptAuditSession(client, {
            sessionId: created.auditSessionId,
            worktreeDir: fresh.worktreeDir,
            workspaceId: fresh.workspaceId,
            prompt: loopService.buildAuditPrompt(fresh),
            auditorModel,
            auditorVariant: fresh.auditorVariant,
          })
          if (!retryResult.ok) throw retryResult.error
        },
      })
      await handlePromptError(loopName, { ...currentState, phase: 'auditing' }, 'failed to send audit prompt', effectiveErr, retryFn)
      return
    }
    if (actualAuditorModel) {
      logger.log(`auditor using model: ${actualAuditorModel.providerID}/${actualAuditorModel.modelID} (session ${created.auditSessionId})`)
    } else {
      logger.log(`auditor using default model (fallback) (session ${created.auditSessionId})`)
    }

    ctx.watchdog.recordActivity(loopName, 'audit-created')
  }

  return {
    runCodingPhase,
    recoverCodeLaunchWithoutAssistant,
    buildCodingPromptForCurrentState,
    handleIdleNoAssistantGate,
    detectAndHandleAssistantError,
    resetErrorCountIfNeeded,
  }
}
