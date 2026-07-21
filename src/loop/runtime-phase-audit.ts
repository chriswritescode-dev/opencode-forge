import type { RuntimeContext, PhaseRunnerCollaborators } from './runtime-context'
import type { TransitionLogEntry } from './runtime-transition-log'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import type { TerminationReason } from './termination'
import type { TransitionEvent } from './transitions'
import { nextTransition } from './transitions'
import { classifyProviderLimit } from './provider-limit'
import { parseCoderDecisions } from '../utils/coder-decisions'
import { parseModelString } from '../utils/model-fallback'
import { resolvePostActionConfig } from './post-action-config'
import { buildLoopPermissionRuleset, resolveLoopAllowedDirectories } from '../constants/loop'
import { createLoopSessionWithWorkspace } from '../utils/loop-session'
import { formatPostActionSessionTitle } from '../utils/session-titles'
import { createAuditSession } from '../utils/audit-session'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { CodingPhase } from './runtime-phase-coding'

export interface AuditPhases {
  runAuditingPhase(loopName: string, state: LoopState): Promise<void>
  runGoalAuditResult(loopName: string, currentState: LoopState, auditText: string, newAuditCount: number): Promise<void>
  runFinalAuditPhase(loopName: string, state: LoopState): Promise<void>
  runFinalAuditFixPhase(loopName: string, state: LoopState): Promise<void>
  runPostActionPhase(loopName: string, state: LoopState): Promise<void>
  startFinalAuditTransition(loopName: string, currentState: LoopState, transition?: TransitionLogEntry): Promise<boolean>
  enterPostActionPhase(loopName: string, currentState: LoopState): Promise<boolean>
  checkAuditClearAndTerminate(loopName: string, currentState: LoopState): Promise<boolean>
  nextIterationOrTerminate(loopName: string, state: LoopState, onTerminate?: (reason: TerminationReason) => Promise<void>): Promise<number | null>
  bumpDirtyAuditRecurrence(loopName: string, bugFindings: ReviewFindingRow[], sectionIndex?: number): void
}

export function createAuditPhases(
  ctx: RuntimeContext,
  collab: PhaseRunnerCollaborators,
  codingPhase: CodingPhase,
): AuditPhases {
  const { logger, client, getConfig, projectId, loopsRepo, transitionLog, sessions, promptRetry, promptDispatch, workspace, termination, setPhase } = collab
  const { loopService } = ctx
  const { recordTransitionEntry, logTransition } = transitionLog
  const { rotateSession, scheduleSessionDelete, rotateAndSendContinuation } = sessions
  const { handlePromptError, sendPromptWithRetryRecovery } = promptRetry
  const { sendPromptWithFallback, getLastAssistantInfo, getAssistantTranscript } = promptDispatch
  const { ensureWorkspaceForLoop } = workspace
  const { terminateLoop } = termination
  const { detectAndHandleAssistantError, resetErrorCountIfNeeded, handleIdleNoAssistantGate } = codingPhase

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
    const trans = nextTransition(currentState, { type: 'audit-clear' })
    if (trans.kind !== 'terminate') return false
    logger.log(`Loop: audit all-clear, terminating loop=${loopName} iteration=${currentState.iteration} audits=${currentState.auditCount ?? 0}`)
    if (trans.reason.kind === 'completed' && await enterPostActionPhase(loopName, currentState)) {
      // The post_action entry row is logged inside enterPostActionPhase (after
      // the persisted phase commit, before the prompt send) so a prompt-send
      // failure cannot insert a terminal row before the phase row.
      return true
    }
    await terminateLoop(loopName, currentState, trans.reason)
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Applies the iteration-cap transition; returns the next iteration or null if terminated.
   * Single source of truth for the maxIterations check so every path routes through
   * `nextTransition({ type: 'iteration-cap' })` instead of inline divergent checks.
   *
   * Callers that need to persist side-effects before terminating (e.g. the goal
   * path persists audit metadata) pass an `onTerminate` wrapper; otherwise the
   * default `terminateLoop` is used.
   */
  async function nextIterationOrTerminate(
    loopName: string,
    state: LoopState,
    onTerminate?: (reason: TerminationReason) => Promise<void>,
  ): Promise<number | null> {
    const nextIter = (state.iteration ?? 0) + 1
    if ((state.maxIterations ?? 0) > 0 && nextIter > state.maxIterations) {
      logger.log(`Loop: max iterations reached (${nextIter}/${state.maxIterations}), terminating`)
      const trans = nextTransition(state, { type: 'iteration-cap' })
      if (trans.kind === 'terminate') {
        if (onTerminate) await onTerminate(trans.reason)
        else await terminateLoop(loopName, state, trans.reason)
      }
      return null
    }
    return nextIter
  }

  /**
   * Transition the loop into the post_action phase: creates a new session, builds the
   * post-action prompt (with skill/prompt from config), sends it, and records the phase.
   * Returns true if the loop entered post_action (caller should return without terminating).
   */
  async function enterPostActionPhase(loopName: string, currentState: LoopState): Promise<boolean> {
    if (currentState.phase === 'post_action') return false
    const cfg = resolvePostActionConfig(getConfig())
    if (!cfg.enabled) return false
    if (!currentState.worktreeDir) return false

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before post-action creation')
    const permission = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(getConfig()) })
    const created = await createLoopSessionWithWorkspace({
      client,
      title: formatPostActionSessionTitle(loopName),
      directory: currentState.worktreeDir,
      permission,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      loopName,
      logPrefix: `loop ${loopName} post-action`,
      logger,
    })
    if (!created) {
      logger.error(`Loop: post-action session creation failed for ${loopName}, completing without action`)
      return false
    }

    loopService.registerLoopSession(created.sessionId, loopName)
    ctx.sessionToLoop.set(created.sessionId, loopName)

    const prompt = loopService.buildPostActionPrompt(currentState, { skill: cfg.skill, prompt: cfg.prompt })
    loopService.setPhaseAndResetError(loopName, 'post_action')
    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    ctx.sessionToLoop.set(currentState.sessionId, loopName)
    loopService.replaceSession(loopName, { newSessionId: created.sessionId, phase: 'post_action' })

    // Record the *entry* into post_action here — after the persisted phase commit
    // AND before sending the post-action prompt. If the prompt send fails below,
    // terminateLoop is invoked from inside this helper and would otherwise insert
    // its terminal row before the entry row, reversing chronological id order.
    // The source event type mirrors the audit-clear/final-audit-clean verdict
    // that drove the redirect; both reduce to "phase" non-terminal rows.
    const sourceEventType = currentState.phase === 'final_auditing' ? 'final-audit-clean' : 'audit-clear'
    loopService.recordTransition(loopName, {
      eventType: sourceEventType,
      transitionKind: 'phase',
      fromPhase: currentState.phase,
      toPhase: 'post_action',
      iteration: currentState.iteration ?? 0,
      sectionIndex: transitionSectionIndex(currentState),
    })

    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after post-action creation', phase: currentState.phase, state: currentState })

    const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName)
    const configuredModel = cfg.model ? parseModelString(cfg.model) : undefined
    // Use the configured post-action model if set, falling back to the loop's auditor model when it fails.
    const primaryModel = configuredModel ?? auditorModel
    const fallbackModel = configuredModel ? auditorModel : undefined
    const { error } = await sendPromptWithFallback({ loopName, sessionId: created.sessionId, promptText: prompt, agent: 'code', model: primaryModel, fallbackModel, variant: currentState.executionVariant })
    if (error) {
      const targetState = loopService.getActiveState(loopName) ?? currentState
      logger.error(`Loop: failed to send post-action prompt for ${loopName}, completing without action`, error)
      await terminateLoop(loopName, targetState, { kind: 'completed' })
      return true
    }
    ctx.watchdog.recordActivity(loopName, 'post-action-prompt-sent')
    return true
  }

  function bumpDirtyAuditRecurrence(loopName: string, bugFindings: ReviewFindingRow[], sectionIndex?: number): void {
    const findings = sectionIndex === undefined ? bugFindings : bugFindings.filter(f => f.sectionIndex === sectionIndex)
    loopService.bumpFindingRecurrence(loopName, findings)
  }

  /**
   * Persist the loop's transition into the final_auditing phase: provision an
   * auditor session, replace the loop's active session, and send the final
   * audit prompt. Returns false if the auditor session could not be created
   * or the prompt could not be sent (caller leaves the loop in its prior phase).
   *
   * When `transition` is supplied, the non-terminal transition row is recorded
   * AFTER `replaceSession` (the persisted phase commit) and BEFORE the prompt
   * send. This leaves no phantom row when session creation fails (returns false
   * before persistence), and guarantees the transition row's id precedes any
   * terminate row produced by a downstream prompt-send failure.
   */
  async function startFinalAuditTransition(
    loopName: string,
    currentState: LoopState,
    transition?: TransitionLogEntry,
  ): Promise<boolean> {
    const finalAuditState = loopService.getActiveState(loopName) ?? { ...currentState, phase: 'final_auditing' }
    const finalAuditPrompt = loopService.buildFinalAuditPrompt(finalAuditState)
    const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName, logger)

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before final audit creation')
    const created = await createAuditSession({
      client,
      loopName,
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      auditorModel,
      prompt: finalAuditPrompt,
      allowDirectories: resolveLoopAllowedDirectories(getConfig()),
      logger,
    })
    if (!created) {
      logger.error(`Loop: final audit session creation failed for ${loopName}`)
      await handlePromptError(loopName, finalAuditState, 'failed to create final audit session', new Error('audit session creation failed'))
      return false
    }

    loopService.setPhaseAndResetError(loopName, 'final_auditing')

    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    ctx.sessionToLoop.set(currentState.sessionId, loopName)
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'final_auditing',
    })
    ctx.sessionToLoop.set(created.auditSessionId, loopName)

    // Record the transition row only after the phase commit above succeeded and
    // before the prompt send below: a failed prompt may itself terminate the
    // loop, and the row's id must precede that terminate row.
    if (transition) {
      recordTransitionEntry(loopName, currentState, transition)
    }

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
    ctx.watchdog.recordActivity(loopName, 'final-audit-prompt-sent')
    return true
  }

  /**
   * Goal-loop audit result handler. Goal loops have no sections, final audit,
   * or post-action phase: a completed auditor pass with zero outstanding review
   * findings (any severity) terminates the loop; otherwise the auditor's
   * findings trigger a fresh code session rotation for remediation.
   * The new code session becomes both state.sessionId and state.executorSessionId.
   */
  async function runGoalAuditResult(
    loopName: string,
    currentState: LoopState,
    auditText: string,
    newAuditCount: number,
  ): Promise<void> {
    const auditSessionId = currentState.sessionId

    const persistAuditAndTerminate = async (reason: TerminationReason): Promise<void> => {
      loopService.replaceSession(loopName, {
        newSessionId: auditSessionId,
        phase: 'auditing',
        auditCount: newAuditCount,
        lastAuditResult: auditText || null,
      })
      await terminateLoop(loopName, loopService.getActiveState(loopName) ?? currentState, reason)
    }

    const outstandingFindings = loopService.getOutstandingFindings(loopName)
    if (outstandingFindings.length === 0) {
      logger.log(`Loop: goal audit all-clear, terminating loop=${loopName} audits=${newAuditCount}`)
      const clearTrans = nextTransition(currentState, { type: 'audit-clear' })
      if (clearTrans.kind === 'terminate') {
        await persistAuditAndTerminate(clearTrans.reason)
      }
      return
    }

    const nextIteration = await nextIterationOrTerminate(loopName, currentState, persistAuditAndTerminate)
    if (nextIteration === null) return

    const dirtyTrans = nextTransition(currentState, { type: 'audit-dirty' })
    if (dirtyTrans.kind !== 'continue') return

    const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
    bumpDirtyAuditRecurrence(loopName, outstandingBugs)

    // Create a fresh code session and re-bind both sessionId and executorSessionId to it.
    let newSessionId: string
    try {
      newSessionId = await rotateSession(loopName, currentState, {
        iteration: nextIteration,
      })
    } catch (err) {
      logger.error(`Loop: session rotation failed during goal dirty audit, continuing with existing session`, err)
      newSessionId = currentState.sessionId
    }

    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      iteration: nextIteration,
      auditCount: newAuditCount,
      lastAuditResult: auditText || null,
      executorSessionId: newSessionId,
    })

    // Record the audit-dirty → coding rotate AFTER the persisted phase commit
    // above and BEFORE the prompt send below. A prompt-send failure that
    // terminates the loop will then produce a terminate row whose id strictly
    // follows this rotate row (chronological id order).
    logTransition(loopName, currentState, { type: 'audit-dirty' }, dirtyTrans, 'coding')

    const updatedState = loopService.getActiveState(loopName) ?? { ...currentState, sessionId: newSessionId, iteration: nextIteration }
    const continuationPrompt = loopService.buildContinuationPrompt(updatedState, auditText || undefined, outstandingBugs)

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    await sendPromptWithRetryRecovery({
      loopName,
      sessionId: newSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: currentState.executionVariant,
      errorContext: 'goal continuation prompt',
      errorState: updatedState,
      activityTag: 'goal-continuation-prompt-sent',
    })
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

    const { text: auditText, error: assistantError, errorSignal: auditErrorSignal, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    // Classify persisted provider-limit errors before the no-assistant gate
    // so that finish:'error' assistant messages terminate immediately.
    if (auditErrorSignal) {
      const limitReason = classifyProviderLimit(auditErrorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted auditing error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'auditing phase', exhaustedReason: { kind: 'audit_retry_exhausted' }, rerun: runAuditingPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing', auditErrorSignal)
    if (!errorResult) {
      return
    }
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    if (!assistantErrorDetected) {
      const newAuditCount = (currentState.auditCount ?? 0) + 1
      logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

      if (currentState.kind === 'goal') {
        await runGoalAuditResult(loopName, currentState, auditText || '', newAuditCount)
        return
      }

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

          // Pre-check: rewind fast-path — all sections completed even though we
          // are not on the last one (possible after a rewind). This bypasses the
          // transition event because `isLastSection` would be false here, but the
          // correct destination is still final-audit. Synthesize the same
          // section-clean / isLastSection=true transition the regular path would
          // have produced and log it so the persisted phase change is recorded.
          if (idx < currentState.totalSections - 1) {
            const allCompleted = loopService.getCompletedSectionDigest(currentState).length === currentState.totalSections
            if (allCompleted) {
              logger.log(`Loop: all ${currentState.totalSections} sections completed after rewind, jumping straight to final audit`)
              // Same guard as the regular path: prevent skipping appended sections.
              const rewindFresh = loopsRepo.get(projectId, currentState.loopName ?? '')
              if (rewindFresh && rewindFresh.totalSections > currentState.totalSections) {
                logger.log(`Loop: amendment appended sections after rewind jump; staying for re-audit`)
                return
              }
              const rewindEvent: TransitionEvent = { type: 'section-clean', isLastSection: true }
              const rewindTrans = nextTransition(currentState, rewindEvent)
              if (rewindTrans.kind === 'start-final-audit') {
                await startFinalAuditTransition(loopName, currentState, {
                  eventType: rewindEvent.type,
                  transitionKind: rewindTrans.kind,
                  fromPhase: currentState.phase,
                  toPhase: 'final_auditing',
                })
              }
              return
            }
          }

          const isLastSection = idx >= currentState.totalSections - 1
          const sectionEvent: TransitionEvent = { type: 'section-clean', isLastSection }
          const sectionTrans = nextTransition(currentState, sectionEvent)
          if (sectionTrans.kind === 'start-final-audit') {
            // Guard: prevent premature final-audit transition when an amendment
            // appended sections after the one we just finished. Without this check,
            // newly appended work at the former final position could be skipped.
            const freshRowForAudit = loopsRepo.get(projectId, currentState.loopName ?? '')
            if (freshRowForAudit && freshRowForAudit.totalSections > currentState.totalSections) {
              logger.log(`Loop: amendment appended sections at index ${idx + 1}; staying in section ${idx} for re-audit`)
              return
            }
            logger.log(`Loop: all ${currentState.totalSections} sections completed, transitioning to final-audit`)
            await startFinalAuditTransition(loopName, currentState, {
              eventType: sectionEvent.type,
              transitionKind: sectionTrans.kind,
              fromPhase: currentState.phase,
              toPhase: 'final_auditing',
            })
            return
          }
          if (sectionTrans.kind === 'advance-section') {
            const nextIdx = idx + 1
            const nextIter = await nextIterationOrTerminate(loopName, currentState)
            if (nextIter === null) return

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
              {
                eventType: sectionEvent.type,
                transitionKind: sectionTrans.kind,
                fromPhase: currentState.phase,
                toPhase: 'coding',
              },
            )
            return
          }
          return
        }

        const dirtyTrans = nextTransition(currentState, { type: 'section-dirty' })
        if (dirtyTrans.kind !== 'rotate') return

        logger.log(`Loop: section ${idx} audit dirty, retrying same section`)

        const nextIter = await nextIterationOrTerminate(loopName, currentState)
        if (nextIter === null) return

        loopService.incrementSectionAttempts(loopName, idx)

        bumpDirtyAuditRecurrence(loopName, sectionAllBugFindings, idx)

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
          {
            eventType: 'section-dirty',
            transitionKind: dirtyTrans.kind,
            fromPhase: currentState.phase,
            toPhase: 'coding',
          },
        )
        return
      }

      const candidateState = { ...currentState, auditCount: newAuditCount }
      if (await checkAuditClearAndTerminate(loopName, candidateState)) return

      const dirtyTrans = nextTransition(candidateState, { type: 'audit-dirty' })
      if (dirtyTrans.kind !== 'continue') return

      const nextIteration = await nextIterationOrTerminate(loopName, currentState)
      if (nextIteration === null) return

      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      bumpDirtyAuditRecurrence(loopName, outstandingBugs)

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
        {
          eventType: 'audit-dirty',
          transitionKind: dirtyTrans.kind,
          fromPhase: candidateState.phase,
          toPhase: 'coding',
        },
      )
    } else {
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      const nextIteration = await nextIterationOrTerminate(loopName, currentState)
      if (nextIteration === null) return
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )
      // Pass the recovery transition into the shared helper so the row is
      // recorded after the rotate-to-coding phase commit but before the prompt
      // send; a prompt failure that terminates the loop will then produce a
      // terminate row whose id strictly follows this recovery row.
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
        {
          eventType: 'audit-error',
          transitionKind: 'error-recovery',
          fromPhase: 'auditing',
          toPhase: 'coding',
        },
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

    // Guard: when an amendment appended sections while we're in final_auditing
    // (e.g., the transition to this phase happened from a stale snapshot),
    // revert back to auditing so the appended sections get executed.
    const freshAuditRow = loopsRepo.get(projectId, loopName)
    if (freshAuditRow && freshAuditRow.totalSections > (currentState.totalSections ?? 0)) {
      logger.log(`Loop: amendment appended sections while in final_auditing; reverting to auditing at section ${currentState.currentSectionIndex}`)
      // Route through the recording setPhase wrapper (not loopService.setPhase)
      // so the revert satisfies the "every phase change produces exactly one
      // loop_transitions row" invariant.
      setPhase(loopName, 'auditing')
      loopService.incrementSectionAttempts(loopName, currentState.currentSectionIndex ?? 0)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final audit phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, errorSignal: finalAuditErrorSignal, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    // Classify persisted provider-limit errors before the no-assistant gate
    // so that finish:'error' assistant messages terminate immediately.
    if (finalAuditErrorSignal) {
      const limitReason = classifyProviderLimit(finalAuditErrorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted final audit error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'final audit phase', exhaustedReason: { kind: 'final_audit_retry_exhausted' }, rerun: runFinalAuditPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'final_auditing', finalAuditErrorSignal)
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'final_auditing')

    if (!assistantErrorDetected) {
      const hasOutstandingBugs = loopService.hasOutstandingFindings(loopName, 'bug')

      const finalAuditEvent: TransitionEvent = { type: hasOutstandingBugs ? 'final-audit-dirty' : 'final-audit-clean' }
      const trans = nextTransition(currentState, finalAuditEvent)
      if (trans.kind === 'terminate') {
        logger.log(`Loop: final audit clean for ${loopName} (no outstanding bug findings), completing`)
        loopService.setFinalAuditDone(loopName, true)
        if (trans.reason.kind === 'completed' && await enterPostActionPhase(loopName, currentState)) {
          // The post_action entry row is logged inside enterPostActionPhase
          // (after the persisted phase commit, before the prompt send).
          return
        }
        await terminateLoop(loopName, currentState, trans.reason)
        return
      }

      // Dirty final audit: rotate to a coding session that fixes the findings,
      // then on coding idle return straight to final_auditing (no section rewind).
      // The transition row is logged AFTER the iteration-cap check and the
      // persisted phase change succeed so a cap-terminate or rotation failure
      // never leaves a phantom final_audit_fix row behind.
      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      logger.log(`Loop: final audit dirty (${outstandingBugs.length} outstanding bug findings), rotating to coding for fix for ${loopName}`)

      const nextIter = await nextIterationOrTerminate(loopName, currentState)
      if (nextIter === null) return

      // Persist the audit text so recovery paths can rebuild the fix prompt if needed.
      if (auditText) loopService.setLastAuditResult(loopName, auditText)

      bumpDirtyAuditRecurrence(loopName, outstandingBugs)

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

      // Persist the new phase so the persisted state machine drives dispatch on the
      // next idle event. replaceSession atomically swaps the session and the phase.
      loopService.replaceSession(loopName, {
        newSessionId: newCodeSessionId,
        phase: 'final_audit_fix',
        iteration: nextIter,
        resetError: currentState.errorCount > 0,
      })

      // Record the final_auditing → final_audit_fix transition only after the
      // persisted phase commit above succeeds.
      logTransition(loopName, currentState, finalAuditEvent, trans, 'final_audit_fix')

      const { error: promptErr } = await sendPromptWithFallback({
        loopName,
        sessionId: newCodeSessionId,
        promptText: fixPrompt,
        agent: 'code',
        variant: currentState.executionVariant,
      })
      if (promptErr) {
        logger.error(`Loop: failed to send final-audit fix prompt for ${loopName}`, promptErr)
        // Roll back to the coding phase so subsequent idle/error handling treats the
        // loop as a regular coding pass rather than re-attempting the fix dispatch.
        loopService.setPhase(loopName, 'coding')
        // Record the recovery to coding; the persisted phase just changed via setPhase.
        loopService.recordTransition(loopName, {
          eventType: 'final-audit-fix-prompt-error',
          transitionKind: 'error-recovery',
          fromPhase: 'final_audit_fix',
          toPhase: 'coding',
          iteration: nextIter,
          sectionIndex: transitionSectionIndex(currentState),
        })
        await handlePromptError(loopName, currentState, 'failed to send final-audit fix prompt', promptErr)
        return
      }
      ctx.watchdog.recordActivity(loopName, 'final-audit-fix-prompt-sent')
    }
  }

  async function runFinalAuditFixPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping final-audit-fix phase`)
      return
    }

    if (currentState.phase !== 'final_audit_fix') {
      logger.log(`Loop: runFinalAuditFixPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final-audit-fix phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
    const lastMessageRole = assistantInfo.lastMessageRole

    // Classify persisted provider-limit errors before the no-assistant gate.
    if (assistantInfo.errorSignal) {
      const limitReason = classifyProviderLimit(assistantInfo.errorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted final-audit-fix error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'final-audit-fix phase', exhaustedReason: { kind: 'coding_no_assistant' }, rerun: runFinalAuditFixPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantInfo.error, 'coding', assistantInfo.errorSignal)
    if (!errorResult) return
    currentState = errorResult.currentState
    currentState = resetErrorCountIfNeeded(loopName, currentState, errorResult.assistantErrorDetected, 'coding')

    // Persist coder decisions emitted during the fix pass so the next final audit
    // prompt can surface them alongside the audit findings.
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    const trans = nextTransition(currentState, { type: 'coding-idle-complete' })
    if (trans.kind === 'start-final-audit') {
      logger.log(`Loop: final-audit fix coding complete for ${loopName}, transitioning back to final_auditing`)
      const started = await startFinalAuditTransition(loopName, currentState, {
        eventType: 'coding-idle-complete',
        transitionKind: trans.kind,
        fromPhase: currentState.phase,
        toPhase: 'final_auditing',
      })
      if (!started) {
        logger.error(`Loop: failed to restart final audit after fix for ${loopName}`)
      }
    }
  }

  async function runPostActionPhase(loopName: string, _state: LoopState): Promise<void> {
    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping post-action phase`)
      return
    }

    if (currentState.phase !== 'post_action') {
      logger.log(`Loop: runPostActionPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in post-action phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const { text: postActionText, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'post-action phase', exhaustedReason: { kind: 'completed' }, rerun: runPostActionPhase })) return

    logger.log(`Loop: post-action complete for ${loopName}, terminating`)
    const trans = nextTransition(currentState, { type: 'post-action-complete' })
    if (trans.kind === 'terminate') {
      // Persist the full assistant transcript of the post-action session before it is
      // deleted on termination, so the run's details survive (loop-status/dashboard).
      const report = await getAssistantTranscript(currentState.sessionId, currentState.worktreeDir)
      if (report) {
        loopService.setPostActionReport(loopName, report)
      }
      // Capture the raw post-action assistant message as the loop's completion summary so the
      // outcome (alternate review verdict, CI result, etc.) is visible in loop-status/dashboard.
      // The loop still terminates `completed` — the plan itself was already cleared by the audit.
      await terminateLoop(loopName, currentState, trans.reason, postActionText || undefined)
    }
  }

  return {
    runAuditingPhase,
    runGoalAuditResult,
    runFinalAuditPhase,
    runFinalAuditFixPhase,
    runPostActionPhase,
    startFinalAuditTransition,
    enterPostActionPhase,
    checkAuditClearAndTerminate,
    nextIterationOrTerminate,
    bumpDirtyAuditRecurrence,
  }
}
