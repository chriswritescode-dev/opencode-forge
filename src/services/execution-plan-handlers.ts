/**
 * Forge Execution Service - Plan Execution Handlers
 *
 * Extracted from execution.ts. Contains the plan-execute handlers (newSession
 * and execute-here) plus the plan-source resolver they share. Types and
 * response helpers come from ./execution-types to avoid any cycle back into the
 * execution facade.
 */

import { selectSessionBestEffort } from '../utils/tui-navigation'
import { extractPlanExecutionMetadata } from '../utils/plan-execution'
import { parseModelString } from '../utils/model-fallback'
import { formatPlanSessionTitle } from '../utils/session-titles'

import {
  ok,
  fail,
  type ForgeExecutionRequestContext,
  type ForgeExecutionResponse,
  type ForgeExecutionError,
  type ForgeExecutionServiceDeps,
  type PlanSource,
  type ExecutePlanNewSessionCommand,
  type ExecutePlanHereCommand,
  type PlanExecutionStartedResult,
} from './execution-types'

// ============================================================================
// Plan Source Resolution
// ============================================================================

export async function resolvePlanSource(
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

// ============================================================================
// Handler factory
// ============================================================================

export function createPlanExecutionHandlers(deps: ForgeExecutionServiceDeps) {
  async function handlePlanNewSession(
    ctx: ForgeExecutionRequestContext,
    command: ExecutePlanNewSessionCommand,
  ): Promise<ForgeExecutionResponse<PlanExecutionStartedResult>> {
    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }

    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const sessionTitle = formatPlanSessionTitle(title)
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)

    // Create new session
    let sessionId: string
    try {
      const session = await deps.client.session.create({
        title: sessionTitle,
        directory: ctx.directory,
      })
      sessionId = session.id
    } catch (err) {
      deps.logger.error('handlePlanNewSession: failed to create session', err)
      return fail('internal_error', 500, 'Failed to create session')
    }
    deps.logger.log(`handlePlanNewSession: created session=${sessionId}`)

    // Navigate TUI if requested with early timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming === 'after-create') {
      selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI (early)', err as Error)
      })
    }

    // Prompt code agent
    let promptError: unknown = null
    try {
      await deps.client.session.promptAsync({
        sessionID: sessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: planText }],
        agent: 'code',
        model: parsedModel!,
      })
    } catch (err) {
      promptError = err
    }

    if (promptError) {
      deps.logger.error('handlePlanNewSession: failed to prompt session', promptError)

      // Delete created session if requested
      if (command.lifecycle?.deleteSessionOnPromptFailure) {
        await deps.client.session.delete({ sessionID: sessionId, directory: ctx.directory }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to delete failed session', err as Error)
        })
      }

      // Return to source session if requested
      if (command.lifecycle?.returnToSourceOnPromptFailure && ctx.sourceSessionId) {
        selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
          deps.logger.error('handlePlanNewSession: failed to return to source session', err as Error)
        })
      }

      return fail('prompt_failed', 502, 'Session created but failed to send plan')
    }

    // Navigate TUI if requested with default/post-prompt timing
    if (command.lifecycle?.selectSession && command.lifecycle.selectSessionTiming !== 'after-create') {
      selectSessionBestEffort(deps.client, deps.directory, deps.logger, { sessionID: sessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to navigate TUI', err as Error)
      })
    }

    // Abort source session if requested
    if (command.lifecycle?.abortSourceSession && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('handlePlanNewSession: failed to abort source session', err as Error)
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

    // Resolve plan text
    const planResult = await resolvePlanSource(ctx, command.source, deps)
    if (!planResult.ok) return { ok: false, error: planResult.error }

    const planText = planResult.planText
    const title = command.title ?? extractPlanExecutionMetadata(planText).title
    const executionModel = command.executionModel ?? deps.config.executionModel
    const parsedModel = parseModelString(executionModel)

    // Build execute-here prompt
    const executeHerePrompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${planText}`

    // Prompt code agent in target session
    let promptError: unknown = null
    try {
      await deps.client.session.promptAsync({
        sessionID: command.targetSessionId,
        directory: ctx.directory,
        parts: [{ type: 'text' as const, text: executeHerePrompt }],
        agent: 'code',
        ...(parsedModel ? { model: parsedModel } : {}),
      })
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

  return { handlePlanNewSession, handlePlanHere }
}
