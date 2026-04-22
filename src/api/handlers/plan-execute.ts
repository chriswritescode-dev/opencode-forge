import type { ApiDeps } from '../types'
import { ok } from '../response'
import { notFound, badRequest } from '../errors'
import { parseJsonBody, PlanExecuteBody } from '../schemas'
import { runPlanExecution } from '../../utils/plan-execution-runner'
import { launchFreshLoop } from '../../utils/loop-launch'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

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

  // Create a minimal TUI API shim for launchFreshLoop
  const tuiApi: TuiPluginApi = {
    client: ctx.v2,
    // Stub other properties - not used by launchFreshLoop
  } as unknown as TuiPluginApi

  switch (body.mode) {
    case 'new-session': {
      const result = await runPlanExecution({
        planText,
        title: body.title,
        directory: ctx.directory,
        projectId,
        sessionId,
        executionModel: body.executionModel,
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
        executionModel: body.executionModel,
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

      // launchFreshLoop expects a TuiPluginApi - we need to adapt
      // For now, we'll need to refactor launchFreshLoop to accept v2 client directly
      // This is a placeholder - the actual implementation will need the refactor
      const launchResult = await launchFreshLoop({
        planText,
        title: body.title,
        directory: ctx.directory,
        projectId,
        isWorktree,
        api: tuiApi,
        executionModel: body.executionModel,
        auditorModel: body.auditorModel,
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
