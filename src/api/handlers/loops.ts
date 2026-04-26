import type { ApiDeps } from '../types'
import { ok } from '../response'
import { ApiError, notFound } from '../errors'
import { parseJsonBody, LoopStartBody, LoopRestartBody } from '../schemas'
import { listLoopStatesFromDb } from '../../storage/cli-helpers'
import { openDatabase } from '../../cli/utils'
import { launchFreshLoop } from '../../utils/loop-launch'
import { cancelLoopByName, restartLoopByName } from '../../services/loop-control'
import type { LoopInfo } from '../../utils/tui-refresh-helpers'

function toLoopInfo(entry: ReturnType<typeof listLoopStatesFromDb>[number]): LoopInfo & { loopName: string; status: string } {
  const state = entry.state
  return {
    loopName: entry.row.loop_name,
    name: entry.row.loop_name,
    status: state.active ? 'running' : (state.terminationReason ?? 'unknown'),
    phase: state.phase,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    sessionId: state.sessionId,
    active: state.active,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    terminationReason: state.terminationReason,
    worktree: state.worktree,
    worktreeDir: state.worktreeDir,
    worktreeBranch: state.worktreeBranch,
    executionModel: state.executionModel,
    auditorModel: state.auditorModel,
    workspaceId: state.workspaceId,
    hostSessionId: state.hostSessionId,
  }
}

export async function handleListLoops(
  _req: Request,
  _deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const db = openDatabase()

  if (!db) {
    throw notFound('database not found')
  }

  const loopStates = listLoopStatesFromDb(db, projectId)

  // Separate active and recent (non-active)
  const loops = loopStates.map(toLoopInfo)
  const active = loops.filter((entry) => entry.active)

  const recent = loops.filter((entry) => !entry.active)

  return ok({ loops, active, recent })
}

export async function handleGetLoop(
  _req: Request,
  _deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId, loopName } = params
  const db = openDatabase()

  if (!db) {
    throw notFound('database not found')
  }

  const loopStates = listLoopStatesFromDb(db, projectId)
  const entry = loopStates.find((e) => e.row.loop_name === loopName)

  if (!entry) {
    throw notFound('loop not found')
  }

  return ok(toLoopInfo(entry))
}

export async function handleStartLoop(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const body = await parseJsonBody(req, LoopStartBody)

  const { ctx } = deps

  const result = await launchFreshLoop({
    planText: body.plan,
    title: body.title,
    directory: ctx.directory,
    projectId,
    isWorktree: body.worktree ?? false,
    v2: ctx.v2,
    executionModel: body.executionModel,
    auditorModel: body.auditorModel,
    hostSessionId: body.hostSessionId,
  })

  if (!result) {
    throw new Error('Failed to launch loop')
  }

  return ok(
    {
      loopName: result.loopName,
      sessionId: result.sessionId,
      worktreeDir: result.worktreeDir,
    },
    202
  )
}

export async function handleCancelLoop(
  _req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { loopName } = params

  const result = await cancelLoopByName(deps.ctx, loopName)

  if (!result.ok) {
    throw new ApiError(result.status, result.code, result.message)
  }

  return ok({ loopName, status: 'cancelled' })
}

export async function handleRestartLoop(
  _req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { loopName } = params
  const body = await parseJsonBody(_req, LoopRestartBody)

  const result = await restartLoopByName(deps.ctx, loopName, body.force ?? false)

  if (!result.ok) {
    throw new ApiError(result.status, result.code, result.message)
  }

  return ok(
    {
      loopName,
      status: 'restarted',
      force: body.force ?? false,
      sessionId: result.newSessionId,
      worktreeDir: result.state.worktreeDir,
      iteration: result.state.iteration,
      sandbox: result.sandbox,
      bindFailed: result.bindFailed,
    },
    202
  )
}
