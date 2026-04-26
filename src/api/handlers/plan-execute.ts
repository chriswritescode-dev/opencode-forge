import type { ApiDeps } from '../types'
import { ok } from '../response'
import { notFound, badRequest } from '../errors'
import { parseJsonBody, PlanExecuteBody } from '../schemas'
import { runPlanExecution } from '../../utils/plan-execution-runner'
import { launchFreshLoop } from '../../utils/loop-launch'

export async function handleExecutePlan(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId, sessionId } = params
  const body = await parseJsonBody(req, PlanExecuteBody)

  // Get plan content - either from body override or from storage
  let planText = body.plan
  if (!planText) {
    const planRow = deps.ctx.plansRepo.getForSession(projectId, sessionId)
    if (!planRow) {
      throw notFound('plan not found')
    }
    planText = planRow.content
  }

  const { ctx } = deps
  const executionModel = body.executionModel || ctx.config.loop?.model || ctx.config.executionModel
  const auditorModel = body.auditorModel || ctx.config.auditorModel

  switch (body.mode) {
    case 'new-session': {
      const result = await runPlanExecution({
        planText,
        title: body.title,
        directory: ctx.directory,
        projectId,
        sessionId,
        executionModel,
        v2: ctx.v2,
        logger: ctx.logger,
        mode: 'new-session',
      })

      return ok(
        {
          mode: result.mode,
          sessionId: result.sessionId,
          modelUsed: result.modelUsed,
        },
        202
      )
    }

    case 'execute-here': {
      if (!body.targetSessionId) {
        throw badRequest('execute-here mode requires targetSessionId')
      }

      const result = await runPlanExecution({
        planText,
        title: body.title,
        directory: ctx.directory,
        projectId,
        sessionId,
        executionModel,
        v2: ctx.v2,
        logger: ctx.logger,
        mode: 'execute-here',
        targetSessionId: body.targetSessionId,
      })

      return ok(
        {
          mode: result.mode,
          sessionId: result.sessionId,
          modelUsed: result.modelUsed,
        },
        202
      )
    }

    case 'loop':
    case 'loop-worktree': {
      const isWorktree = body.mode === 'loop-worktree'

      const launchResult = await launchFreshLoop({
        planText,
        title: body.title,
        directory: ctx.directory,
        projectId,
        isWorktree,
        v2: ctx.v2,
        executionModel,
        auditorModel,
        hostSessionId: sessionId,
      })

      if (!launchResult) {
        throw new Error('Failed to launch loop')
      }

      return ok(
        {
          mode: body.mode,
          sessionId: launchResult.sessionId,
          loopName: launchResult.loopName,
          worktreeDir: launchResult.worktreeDir,
        },
        202
      )
    }

    default:
      throw badRequest(`unknown mode: ${body.mode}`)
  }
}
