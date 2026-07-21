/**
 * Forge Execution Service - Command Bus Interface
 * 
 * Shared execution service for plan execution and loop lifecycle.
 * Provides a unified interface for internal tools, API, and TUI surfaces.
 */

import {
  fail,
  type ForgeExecutionRequestContext,
  type ForgeExecutionResponse,
  type ForgeExecutionCommand,
  type ForgeExecutionResult,
  type ForgeExecutionService,
  type ForgeExecutionServiceDeps,
  type LoopStartedResult,
} from './execution-types'

import { createPlanExecutionHandlers } from './execution-plan-handlers'
import { createLoopQueryHandlers } from './execution-query-handlers'
import { createLoopStartHandlers } from './execution-start-handlers'
import { createLoopRestartHandler } from './execution-restart-handler'

export {
  attachLoopToSession,
  selectInitialWorktreeSession,
} from './execution-attach'
export type { SelectInitialWorktreeSessionOpts } from './execution-attach'

export {
  buildStartLoopCommand,
  type ForgeExecutionSurface,
  type ForgeExecutionRequestContext,
  type PlanSource,
  type ForgeLoopExtra,
  type AttachLoopInput,
  type LoopSelector,
  type ExecutePlanNewSessionCommand,
  type ExecutePlanHereCommand,
  type StartLoopCommand,
  type BuildStartLoopCommandInput,
  type StartGoalCommand,
  type RestartLoopCommand,
  type CancelLoopCommand,
  type GetLoopStatusCommand,
  type ForgeExecutionCommand,
  type ForgeExecutionError,
  type ForgeExecutionWarning,
  type ForgeExecutionResponse,
  type PlanExecutionStartedResult,
  type LoopStartedResult,
  type GoalStartedResult,
  type LoopRestartedResult,
  type LoopCancelledResult,
  type LoopStatusView,
  type LoopStatusResult,
  type ForgeExecutionResult,
  type ForgeExecutionService,
  type ForgeExecutionServiceDeps,
} from './execution-types'

// ============================================================================
// Service Implementation
// ============================================================================

export function createForgeExecutionService(deps: ForgeExecutionServiceDeps): ForgeExecutionService {
  const inFlightLoopStarts = new Map<string, Promise<ForgeExecutionResponse<LoopStartedResult>>>()

  const { handlePlanNewSession, handlePlanHere } = createPlanExecutionHandlers(deps)
  const { handleStartLoop, handleStartGoal } = createLoopStartHandlers(deps, inFlightLoopStarts)
  const { handleLoopStatus, handleLoopCancel } = createLoopQueryHandlers(deps)
  const { handleLoopRestart } = createLoopRestartHandler(deps)

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
      case 'goal.start':
        return handleStartGoal(ctx, command) as Promise<ForgeExecutionResponse<ForgeExecutionResult<C>>>
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
