/**
 * Forge Execution Service - Loop Restart Handler
 *
 * Extracted from execution.ts. Owns the loop.restart handler: restarting a
 * stopped or active loop, aborting any live session under lock, recreating the
 * worktree/sandbox/session, sending the restart prompt with retry/backoff, and
 * the deferred provider-limit termination + rollback paths.
 *
 * Key invariants preserved verbatim from execution.ts:
 *  - Provider-limit termination MUST run outside the runExclusive callback
 *    because deps.loop.terminate -> terminateLoopByName -> withStateLock is
 *    non-reentrant and would deadlock the per-loop lock held by runExclusive.
 *  - Pre-lock snapshot vs authoritative under-lock state reconciliation for
 *    active vs inactive loops (race-condition fix for concurrent restarts).
 *  - In-place rollback via loopsRepo.restore / loopService.terminate to
 *    preserve child rows (loop_transitions, section_plans).
 */

import { existsSync } from 'fs'
import { selectSessionBestEffort } from '../utils/tui-navigation'
import { parseModelString } from '../utils/model-fallback'
import { classifyProviderLimit, extractErrorSignal } from '../loop/provider-limit'

import { formatLoopSessionTitle } from '../utils/session-titles'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset, resolveLoopAllowedDirectories } from '../constants/loop'
import { isSandboxEnabled } from '../sandbox/context'
import { createLoopSessionWithWorkspace, publishWorkspaceDetachedToast } from '../utils/loop-session'
import { applyPlanDecomposition } from './section-bootstrap'
import { sendLoopPrompt } from '../loop/send-loop-prompt'
import { markPromptSent, clearPromptPending } from '../loop'
import { ConcurrentPromptError } from '../loop/in-flight-guard'
import { transitionSectionIndex } from '../loop/state'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists } from '../workspace/forge-naming'
import { resolvePostActionConfig, type ResolvedPostActionConfig } from '../loop/post-action-config'
import { findPartialMatch } from '../utils/partial-match'

import { selectInitialWorktreeSession, isTransientSessionError } from './execution-attach'

import {
  ok,
  fail,
  type ForgeExecutionRequestContext,
  type ForgeExecutionResponse,
  type ForgeExecutionServiceDeps,
  type RestartLoopCommand,
  type LoopRestartedResult,
} from './execution-types'

export function createLoopRestartHandler(deps: ForgeExecutionServiceDeps) {
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

    const restartSandbox = isSandboxEnabled(deps.config, deps.sandboxManager)
    deps.logger.log(
      `handleRestartLoop: [perm-diag] worktree=${String(stoppedState.worktree)} sandbox=${String(restartSandbox)}`
    )
    const permissionRuleset = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(deps.config) })
    // Pre-lock snapshot used as the rollback target only when the loop is
    // already stopped (no active under-lock state to re-fetch). For active
    // loops we refresh this from the authoritative under-lock state below,
    // before any restart-specific mutation, so a rollback never resurrects an
    // obsolete phase/session from the stale pre-lock snapshot.
    const previousState = { ...stoppedState }
    // Captured pre-lock as the fallback for inactive loops (no under-lock state
    // to re-fetch). For active loops we refresh this from the authoritative
    // under-lock state below, so a session rotation during lock contention
    // (e.g. final_auditing -> final_audit_fix rotates from audit session A to
    // fix session B) reports B as the previous session — that is the session we
    // actually aborted and replaced — not the stale pre-lock A.
    let previousSessionId = stoppedState.sessionId
    let bindFailed = false

    type RestartOutcome =
      | { ok: true; newSessionId: string; previousSessionId: string; sandbox: boolean; bindFailed: boolean }
      | { ok: false; error: string }
      // Provider-limit termination MUST happen after runExclusive releases the
      // per-loop state lock: deps.loop.terminate -> terminateLoopByName ->
      // withStateLock is non-reentrant, so calling it inside the runExclusive
      // callback (which already holds the lock) deadlocks. The callback returns
      // this marker so the outer flow performs the canonical termination without
      // any lock held.
      | { ok: false; error: string; providerLimitMessage: string }

    const outcome = await deps.loopHandler.runExclusive<RestartOutcome>(stoppedState.loopName, async () => {
      // Re-read authoritative state under the per-loop lock.
      //
      // Race-condition fix: when the pre-lock snapshot was inactive (cancelled or
      // errored) a second concurrent restart could have already completed by the
      // time we acquire the lock.  In that case we must reject the second
      // restart instead of silently overwriting the first.
      //
      // For active loops the original code already aborted and updated state here.
      // We preserve that behavior by checking `stoppedState.active` first.
      const latestState = deps.loop.service.getActiveState(stoppedState.loopName)
      if (!latestState && stoppedState.active) {
        // Active loop vanished under lock — treat as removed.
        return { ok: false, error: `Loop "${stoppedState.loopName}" has been removed.` }
      }
      if (latestState && latestState.active && !stoppedState.active) {
        // Pre-lock was inactive but authoritative state is now active — a
        // concurrent restart finished. Reject so we don't silently overwrite it.
        return {
          ok: false,
          error: `Loop "${stoppedState.loopName}" is already active with session ${latestState.sessionId}. Use --force to abort and restart.`,
        }
      }

      if (stoppedState.active && latestState) {
        // The pre-lock snapshot was active — the original code already ran this
        // block to abort and refresh from latestState.
        try { await deps.client.session.abort({ sessionID: latestState.sessionId }) } catch {}
        await deps.loopHandler!.clearLoopTimers(stoppedState.loopName)
        Object.assign(stoppedState, latestState)
        Object.assign(previousState, latestState)
        previousSessionId = latestState.sessionId
      } else {
        // Inactive loop (or pre-lock was active but latestState is null — loop
        // vanished, already returned above if active). Use whatever we have.
        if (latestState) {
          Object.assign(stoppedState, latestState)
          Object.assign(previousState, latestState)
          previousSessionId = latestState.sessionId
        }
      }

      if (stoppedState.phase === 'post_action' && !resolvePostActionConfig(deps.config).enabled) {
        deps.logger.log(`loop-restart: ${stoppedState.loopName} was in post_action but postAction is disabled; marking completed without restart`)
        // Persist the terminal transition row so the disabled post-action
        // restart outcome is logged through the same shared path used by the
        // runtime. The canonical terminateLoop/terminateAll paths are not
        // invoked here (this loop is already stopped/inactive); we record
        // directly against the loopService's transition repository. Best-effort:
        // recordTransition wraps the repo insert in try/catch and never
        // throws into the restart flow.
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

      stoppedState.iteration = 1

      // Create new session for restart

      let newSessionId: string | undefined

      if (stoppedState.worktree) {
        const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
        const wsResult = await createBuiltinWorktreeWorkspace(deps.client, {
          loopName: stoppedState.loopName,
          directory: stoppedState.projectDir || ctx.directory,
        }, deps.logger, deps.workspaceStatusRegistry)
        if (!wsResult.ok) return { ok: false, error: `Restart failed: ${wsResult.error.message}` }
        const ws = wsResult.workspace
        stoppedState.workspaceId = ws.workspaceId
        stoppedState.worktreeDir = ws.directory
        stoppedState.worktreeBranch = ws.branch
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

      // Unified session creation for restart (always a single code session)
      const createResult = await createLoopSessionWithWorkspace({
        client: deps.client,
        title: formatLoopSessionTitle(stoppedState.loopName, {
          iteration: stoppedState.iteration ?? 0,
          currentSectionIndex: stoppedState.currentSectionIndex ?? 0,
          totalSections: stoppedState.totalSections ?? 0,
        }),
        directory: stoppedState.worktreeDir,
        permission: stoppedState.phase === 'final_auditing' ? buildAuditSessionPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(deps.config) }) : permissionRuleset,
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

      // Navigate the TUI to the recreated worktree session and wait for the
      // workspace to connect, mirroring handleStartLoop. Without this the loop
      // restarts and runs but its workspace never connects/focuses in the TUI.
      await selectInitialWorktreeSession(newSessionId, createResult.boundWorkspaceId, 'on restart', {
        selectSession: true,
        logger: deps.logger,
        workspaceStatusRegistry: deps.workspaceStatusRegistry,
        selectSessionFn: (sel) => selectSessionBestEffort(deps.client, deps.directory, deps.logger, sel),
      })

      // Unified section extraction on restart — preserve existing progress if sections exist.
      // Goal loops never decompose: they carry goal text, not a plan, so applying plan
      // decomposition would reinterpret the goal as a plan and corrupt the loop.
      if (!stoppedState.totalSections && stoppedState.kind !== 'goal') {
        const planText = stoppedState.prompt ?? ''
        const { totalSections } = applyPlanDecomposition({
          projectId: ctx.projectId,
          loopName: stoppedState.loopName,
          planText,
          loopsRepo: deps.loopsRepo,
          sectionPlansRepo: deps.sectionPlansRepo,
        })
        stoppedState.totalSections = totalSections
        if (totalSections > 0) {
          stoppedState.currentSectionIndex = 0
        }
      }
      // else: existing totalSections preserved as-is

      const effectiveSessionId = newSessionId!
      // A stopped final_audit_fix loop is a coding pass (the fix session), not an
      // auditor phase — restart it as coding with the code prompt agent. The other
      // auditor phases (final_auditing, post_action) preserve their persisted phase.
      const restartPhase = stoppedState.phase === 'final_auditing'
        ? 'final_auditing' as const
        : stoppedState.phase === 'post_action'
          ? 'post_action' as const
          : 'coding' as const

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
        sandboxContainer: restartSandbox ? deps.sandboxManager?.docker.containerName(stoppedState.loopName) : undefined,
        executionModel: stoppedState.executionModel,
        auditorModel: stoppedState.auditorModel,
        executionVariant: stoppedState.executionVariant,
        auditorVariant: stoppedState.auditorVariant,
        workspaceId: stoppedState.workspaceId,
        hostSessionId: stoppedState.hostSessionId,
        executorSessionId: stoppedState.kind === 'goal' ? effectiveSessionId : undefined,
        currentSectionIndex: stoppedState.currentSectionIndex,
        totalSections: stoppedState.totalSections,
        finalAuditDone: stoppedState.finalAuditDone,
        // Goal loops preserve their discriminator and goal text across restart.
        kind: stoppedState.kind,
        goal: stoppedState.goal,
      }
      // Build appropriate prompt based on persisted state
      let promptText: string
      let postActionCfg: ResolvedPostActionConfig | undefined

      if (stoppedState.phase === 'post_action') {
        postActionCfg = resolvePostActionConfig(deps.config)
        promptText = deps.loop.service.buildPostActionPrompt(stoppedState, { skill: postActionCfg.skill, prompt: postActionCfg.prompt })
      } else if (stoppedState.kind === 'goal') {
        // Goal loops have no plan, sections, or approval flow — restate the goal
        // directly as a fresh coding pass. No initial audit findings on restart.
        promptText = deps.loop.service.buildContinuationPrompt(stoppedState, undefined)
      } else if (stoppedState.phase === 'final_audit_fix') {
        // Resume fixing the final-audit findings rather than re-coding the last
        // section: lastAuditResult was persisted when the fix phase was entered
        // (runtime.runFinalAuditPhase) precisely for this recovery path.
        const outstandingBugs = deps.loop.service.getOutstandingFindings(stoppedState.loopName, 'bug')
        promptText = deps.loop.service.buildFinalAuditFixPrompt(stoppedState, stoppedState.lastAuditResult ?? '', outstandingBugs)
      } else if (stoppedState.totalSections > 0) {
        // Use persisted section state to build the correct section prompt
        if (stoppedState.phase === 'final_auditing') {
          promptText = deps.loop.service.buildFinalAuditPrompt(stoppedState)
        } else {
          promptText = deps.loop.service.buildSectionInitialPrompt(stoppedState)
        }
      } else {
        // Legacy non-sectioned prompt
        promptText = stoppedState.prompt ?? ''
      }

      const restartAuditorModel = parseModelString(stoppedState.auditorModel ?? deps.config.auditorModel)
      const loopModel = stoppedState.phase === 'post_action' && postActionCfg?.model
        ? parseModelString(postActionCfg.model)
        : stoppedState.phase === 'final_auditing' || stoppedState.phase === 'post_action'
          ? restartAuditorModel
          : parseModelString(stoppedState.executionModel) ?? parseModelString(deps.config.executionModel)
      // When a configured post-action model is used, fall back to the loop's auditor model if it fails.
      const loopFallbackModel = stoppedState.phase === 'post_action' && postActionCfg?.model
        ? restartAuditorModel
        : undefined
      const workspaceParam = stoppedState.workspaceId ? { workspace: stoppedState.workspaceId } : {}

      // final_audit_fix is a coding-style phase: restart sends the final-audit fix
      // prompt as the code agent (never the auditor-loop agent).
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
        executorSessionId: newState.executorSessionId ?? null,
      })

      deps.loop.service.registerLoopSession(effectiveSessionId, stoppedState.loopName)
      deps.loop.registerSessionReverseIndex(effectiveSessionId, stoppedState.loopName)

      // Record restart phase transition immediately after persisting the new
      // phase, before sending the restart prompt. A provider-limit or other
      // prompt send failure may then terminate the loop — the phase row must
      // already be in place so the transition log shows the real sequence
      // (phase change → terminal). We skip when persisted phase matches the
      // restart phase (final_auditing / post_action stay in place).
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

      const restartVariant = promptAgent === 'auditor-loop'
        ? stoppedState.auditorVariant
        : stoppedState.executionVariant

      const performRestartPrompt = async (model?: { providerID: string; modelID: string }): Promise<{ error?: unknown }> => {
        markPromptSent(stoppedState.loopName, effectiveSessionId, deps.logger)
        try {
          await deps.client.session.promptAsync({
            sessionID: effectiveSessionId,
            directory: stoppedState.worktreeDir,
            parts: [{ type: 'text' as const, text: promptText }],
            agent: promptAgent,
            ...(model ? { model, ...(restartVariant ? { variant: restartVariant } : {}) } : {}),
            ...workspaceParam,
          })
          return {}
        } catch (err) {
          return { error: err }
        }
      }

      // Retry the prompt with backoff: a just-created + warped session can briefly
      // report "Session not found" before it is durably registered. Without this,
      // a transient race tore the restart down and reverted the loop to terminal.
      // (Workspace connection was already awaited via selectInitialWorktreeSession.)
      const RESTART_PROMPT_MAX_ATTEMPTS = 4
      let promptResult: { error?: unknown } = { error: new Error('restart prompt not attempted') }
      for (let attempt = 1; attempt <= RESTART_PROMPT_MAX_ATTEMPTS; attempt++) {
        const { result } = await sendLoopPrompt({
          loopName: stoppedState.loopName,
          sessionId: effectiveSessionId,
          agent: promptAgent,
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
        // Classify provider-limit errors before generic rollback so that a
        // capped account terminates the loop with the provider_limit reason
        // instead of silently reverting to the previous terminal state.
        const limitReason = classifyProviderLimit(extractErrorSignal(promptResult.error))
        if (limitReason) {
          deps.logger.error(`loop-restart: provider limit detected for ${stoppedState.loopName}: ${limitReason}, terminating`)
          clearPromptPending(stoppedState.loopName, deps.logger)
          deps.loop.unregisterSessionReverseIndex(effectiveSessionId)
          // Defer the canonical termination (deps.loop.terminate) and the
          // sandbox teardown to outside the runExclusive callback: deps.loop.
          // terminate reacquires the per-loop state lock via
          // terminateLoopByName -> withStateLock, which is non-reentrant, so
          // invoking it here would deadlock the runExclusive-held lock. The
          // in-memory cleanup above (clearPromptPending,
          // unregisterSessionReverseIndex) is lock-free and safe to perform
          // under the held lock. Returning the marker lets the outer flow
          // terminate after the lock is released.
          return { ok: false, error: `Provider limit on restart prompt: ${limitReason}`, providerLimitMessage: limitReason }
        }

        const isConcurrent = promptResult.error instanceof ConcurrentPromptError
        if (!isConcurrent) {
          clearPromptPending(stoppedState.loopName, deps.logger)
        }
        deps.logger.error('loop-restart: failed to send prompt', promptResult.error)
        // Save section plans before rollback (the DB row stays intact in-place;
        // transition history is preserved because we never delete the loop row).
        const savedPlans = deps.sectionPlansRepo?.list(ctx.projectId, stoppedState.loopName) ?? []
        deps.loop.unregisterSessionReverseIndex(effectiveSessionId)
        try {
          let restoreRow: import('../loop/state').LoopState
          if (previousState.active) {
            // The previous session was already aborted under the lock when we
            // observed the active loop. Restoring it as active would strand the
            // loop with a dead session and no watchdog (the aborted session has
            // no timers and cannot progress). Bake the errored termination into
            // the restored row so a single in-place UPDATE both restores the
            // pre-restart fields (phase, section progress, etc.) and marks the
            // loop errored/restartable. We cannot use `setState` here because
            // the loop row already exists (created/updated moments earlier by
            // `loopsRepo.restart`) and `setState` uses a plain INSERT that
            // raises a primary-key constraint error. `loopsRepo.restore` UPDATEs
            // in place, preserving child rows (loop_transitions, section_plans)
            // that an INSERT OR REPLACE or `deleteState` + INSERT would
            // cascade-delete.
            restoreRow = {
              ...previousState,
              active: false,
              status: 'errored',
              terminationReason: 'restart_prompt_failed',
              completedAt: new Date().toISOString(),
            }
          } else {
            // Stopped-loop rollback: restore the previous (already-inactive)
            // row in place so transition history is preserved.
            restoreRow = previousState
          }
          deps.loop.service.restoreState(restoreRow.loopName, restoreRow)
          const restartFromPhase = restartPhase
          const restartToPhase = previousState.phase ?? 'coding'
          const iteration = previousState.iteration ?? 0
          const sectionIndex = transitionSectionIndex(previousState)
          // Log the rollback restoration whenever the restart actually changed
          // the persisted phase, so the transition history stays continuous:
          //   previousPhase -> restartPhase (pre-prompt 'restart' phase row)
          //   restartPhase -> previousPhase (this 'rollback' row)
          // When the restart preserved the phase (final_auditing / post_action
          // stay in place), there is nothing to roll back phase-wise and no
          // rollback row is emitted.
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
            // Active-rollback: the loop was running and the aborted session has
            // no timers/watchdog to drive progress. Route through the shared
            // `loopService.terminate` path so the row's terminal status is
            // set through one canonical helper AND the terminate notification
            // fires (group orchestration, TUI, host side-effects). This avoids
            // a parallel `loopsRepo.terminate` write that would leave group
            // orchestration uninformed.
            deps.loop.service.terminate(previousState.loopName, {
              status: 'errored',
              reason: 'restart_prompt_failed',
              completedAt: Date.now(),
            })
            // Terminal transition row for the active-rollback path. Inactive
            // rollback restores the unchanged inactive row and emits no
            // terminal row (nothing terminally changed).
            deps.loop.service.recordTerminalTransition(previousState.loopName, {
              reason: { kind: 'restart_prompt_failed' },
              fromPhase: restartToPhase,
              iteration,
              sectionIndex,
            })
          }
          // Section plans were preserved in place (no cascade); nothing to
          // re-insert. restoreAll is retained as a no-op safety net in case
          // a future code path deletes the loop row during rollback.
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

    // Provider-limit termination deferred from inside the runExclusive
    // callback. The callback cannot call deps.loop.terminate itself because
    // that reacquires the non-reentrant per-loop state lock held by
    // runExclusive (terminateLoopByName -> withStateLock -> deadlock). Perform
    // the canonical termination here, after the lock has been released.
    if (!outcome.ok && 'providerLimitMessage' in outcome) {
      await deps.loop.terminate(stoppedState.loopName, { kind: 'provider_limit', message: outcome.providerLimitMessage })
      if (restartSandbox && deps.sandboxManager) {
        await deps.sandboxManager.stop(stoppedState.loopName).catch(() => {})
      }
      return fail('internal_error', 500, outcome.error)
    }

    if (!outcome.ok) return fail('internal_error', 500, outcome.error)

    if (outcome.bindFailed) {
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

  return { handleLoopRestart }
}
