import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { PlanExecuteBody } from '../schemas'
import { buildStartLoopCommand, type PlanSource, type ForgeExecutionCommand, type StartLoopCommand } from '../../services/execution'
import { buildService } from './_shared'

type LoopStartedInfo = Parameters<NonNullable<NonNullable<StartLoopCommand['lifecycle']>['onStarted']>>[0]
type PlanLoopMode = 'loop' | 'loop-worktree'

function toPlanLoopResponse(mode: PlanLoopMode, info: LoopStartedInfo) {
  return {
    mode,
    sessionId: info.sessionId,
    loopName: info.loopName,
    displayName: info.displayName,
    worktreeDir: info.worktreeDir,
    workspaceId: info.workspaceId,
  }
}

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

  const { service, execCtx } = buildService(deps, projectId)

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

      let started = false
      let resolveStarted!: (info: LoopStartedInfo) => void
      const startedPromise = new Promise<LoopStartedInfo>((resolve) => {
        resolveStarted = resolve
      })

      const command = buildStartLoopCommand({
        source,
        mode: isWorktree ? 'worktree' : 'in-place',
        executionModel,
        auditorModel,
        hostSessionId: sessionId,
        title: parsed.title,
        lifecycle: {
          selectSession: true,
          selectSessionTiming: 'after-create',
          startWatchdog: true,
            onStarted: (info) => {
              started = true
              const response = toPlanLoopResponse(parsed.mode as PlanLoopMode, info)
              deps.eventPublisher?.('loop.started', response)
              resolveStarted(info)
            },
        },
      })

      const dispatchPromise = service.dispatch(execCtx, command)

      void dispatchPromise.then((result) => {
        if (!result.ok && started) {
          deps.logger.error(`plan.execute loop failed after start: ${result.error.message}`)
        }
      }).catch((err) => {
        deps.logger.error('plan.execute loop dispatch rejected after start', err)
      })

      const outcome = await Promise.race([
        startedPromise.then((info) => ({ kind: 'started' as const, info })),
        dispatchPromise.then((result) => ({ kind: 'complete' as const, result })),
      ])

      if (outcome.kind === 'started') {
        return toPlanLoopResponse(parsed.mode, outcome.info)
      }

      if (!outcome.result.ok) {
        throw new ForgeRpcError(outcome.result.error.code, outcome.result.error.message)
      }

      return {
        mode: parsed.mode,
        sessionId: outcome.result.data.sessionId,
        loopName: outcome.result.data.loopName,
        displayName: outcome.result.data.displayName,
        worktreeDir: outcome.result.data.worktreeDir,
        workspaceId: outcome.result.data.workspaceId,
      }
    }

    default:
      throw new ForgeRpcError('bad_request', `unknown mode: ${parsed.mode}`)
  }
}
