import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { PlanExecuteBody } from '../schemas'
import { createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource, type ForgeExecutionCommand } from '../../services/execution'

export async function handleExecutePlan(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId, sessionId } = params
  const parsed = PlanExecuteBody.parse(body)

  // Get plan content - either from body override or from storage
  let source: PlanSource
  if (!parsed.plan) {
    const planRow = deps.ctx.plansRepo.getForSession(projectId, sessionId)
    if (!planRow) {
      throw new ForgeRpcError('not_found', 'plan not found')
    }
    source = { kind: 'stored', sessionId }
  } else {
    source = { kind: 'inline', planText: parsed.plan }
  }

  const { ctx } = deps
  const executionModel = parsed.executionModel || ctx.config.executionModel
  const auditorModel = parsed.auditorModel || ctx.config.auditorModel

  // Build execution request context
  const execCtx: ForgeExecutionRequestContext = {
    surface: 'api',
    projectId,
    directory: ctx.directory,
    sourceSessionId: sessionId,
  }

  // Create execution service
  const service = createForgeExecutionService({
    projectId,
    directory: ctx.directory,
    config: ctx.config,
    logger: ctx.logger,
    dataDir: ctx.dataDir,
    v2: ctx.v2,
    plansRepo: ctx.plansRepo,
    loopsRepo: ctx.loopsRepo,
    graphStatusRepo: ctx.graphStatusRepo,
    loopService: ctx.loopService,
    loopHandler: ctx.loopHandler,
    sandboxManager: ctx.sandboxManager,
  })

  switch (parsed.mode) {
    case 'new-session': {
      const command: ForgeExecutionCommand = {
        type: 'plan.execute.newSession',
        source,
        executionModel,
        title: parsed.title,
        lifecycle: {
          selectSession: false,
        },
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ForgeRpcError(result.error.code, result.error.message)
      }

      return {
        mode: 'new-session',
        sessionId: result.data.sessionId,
        modelUsed: result.data.modelUsed,
      }
    }

    case 'execute-here': {
      if (!parsed.targetSessionId) {
        throw new ForgeRpcError('bad_request', 'execute-here mode requires targetSessionId')
      }

      const command: ForgeExecutionCommand = {
        type: 'plan.execute.here',
        source,
        targetSessionId: parsed.targetSessionId,
        executionModel,
        title: parsed.title,
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ForgeRpcError(result.error.code, result.error.message)
      }

      return {
        mode: 'execute-here',
        sessionId: result.data.sessionId,
        modelUsed: result.data.modelUsed,
      }
    }

    case 'loop':
    case 'loop-worktree': {
      const isWorktree = parsed.mode === 'loop-worktree'

      const command: ForgeExecutionCommand = {
        type: 'loop.start',
        source,
        mode: isWorktree ? 'worktree' : 'in-place',
        executionModel,
        auditorModel,
        hostSessionId: sessionId,
        title: parsed.title,
        lifecycle: {
          selectSession: true,
          startWatchdog: true,
        },
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ForgeRpcError(result.error.code, result.error.message)
      }

      return {
        mode: parsed.mode,
        sessionId: result.data.sessionId,
        loopName: result.data.loopName,
        displayName: result.data.displayName,
        worktreeDir: result.data.worktreeDir,
      }
    }

    default:
      throw new ForgeRpcError('bad_request', `unknown mode: ${parsed.mode}`)
  }
}
