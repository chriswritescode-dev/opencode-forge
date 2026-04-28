import type { ApiDeps } from '../types'
import { ok } from '../response'
import { notFound, badRequest, ApiError } from '../errors'
import { parseJsonBody, PlanExecuteBody, type PlanExecute } from '../schemas'
import { createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource, type ForgeExecutionCommand } from '../../services/execution'

export async function handleExecutePlan(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId, sessionId } = params
  const body = await parseJsonBody<PlanExecute>(req, PlanExecuteBody)

  // Get plan content - either from body override or from storage
  let planText = body.plan
  let source: PlanSource
  if (!planText) {
    const planRow = deps.ctx.plansRepo.getForSession(projectId, sessionId)
    if (!planRow) {
      throw notFound('plan not found')
    }
    planText = planRow.content
    source = { kind: 'stored', sessionId }
  } else {
    source = { kind: 'inline', planText }
  }

  const { ctx } = deps
  const executionModel = body.executionModel || ctx.config.loop?.model || ctx.config.executionModel
  const auditorModel = body.auditorModel || ctx.config.auditorModel

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

  switch (body.mode) {
    case 'new-session': {
      const command: ForgeExecutionCommand = {
        type: 'plan.execute.newSession',
        source,
        executionModel,
        title: body.title,
        lifecycle: {
          selectSession: false,
        },
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ApiError(result.error.status, result.error.code, result.error.message)
      }

      return ok(
        {
          mode: 'new-session',
          sessionId: result.data.sessionId,
          modelUsed: result.data.modelUsed,
        },
        202
      )
    }

    case 'execute-here': {
      if (!body.targetSessionId) {
        throw badRequest('execute-here mode requires targetSessionId')
      }

      const command: ForgeExecutionCommand = {
        type: 'plan.execute.here',
        source,
        targetSessionId: body.targetSessionId,
        executionModel,
        title: body.title,
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ApiError(result.error.status, result.error.code, result.error.message)
      }

      return ok(
        {
          mode: 'execute-here',
          sessionId: result.data.sessionId,
          modelUsed: result.data.modelUsed,
        },
        202
      )
    }

    case 'loop':
    case 'loop-worktree': {
      const isWorktree = body.mode === 'loop-worktree'

      const command: ForgeExecutionCommand = {
        type: 'loop.start',
        source,
        mode: isWorktree ? 'worktree' : 'in-place',
        executionModel,
        auditorModel,
        hostSessionId: sessionId,
        title: body.title,
        lifecycle: {
          selectSession: true,
          startWatchdog: true,
        },
      }

      const result = await service.dispatch(execCtx, command)

      if (!result.ok) {
        throw new ApiError(result.error.status, result.error.code, result.error.message)
      }

      return ok(
        {
          mode: body.mode,
          sessionId: result.data.sessionId,
          loopName: result.data.loopName,
          displayName: result.data.displayName,
          worktreeDir: result.data.worktreeDir,
        },
        202
      )
    }

    default:
      throw badRequest(`unknown mode: ${body.mode}`)
  }
}
