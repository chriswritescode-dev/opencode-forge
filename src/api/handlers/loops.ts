import type { ApiDeps } from '../types'
import { ok } from '../response'
import { ApiError, notFound } from '../errors'
import { parseJsonBody, LoopStartBody, LoopRestartBody, type LoopStart } from '../schemas'
import { listLoopStatesFromDb } from '../../storage/cli-helpers'
import { openDatabase } from '../../cli/utils'
import { cancelLoopByName, restartLoopByName } from '../../services/loop-control'
import { createForgeExecutionService, type ForgeExecutionRequestContext, type ForgeExecutionCommand } from '../../services/execution'
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
  const body = await parseJsonBody<LoopStart>(req, LoopStartBody)

  const { ctx } = deps

  // Build execution request context
  const execCtx: ForgeExecutionRequestContext = {
    surface: 'api',
    projectId,
    directory: ctx.directory,
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

  const command: ForgeExecutionCommand = {
    type: 'loop.start',
    source: { kind: 'inline', planText: body.plan },
    title: body.title,
    mode: body.worktree ?? false ? 'worktree' : 'in-place',
    executionModel: body.executionModel,
    auditorModel: body.auditorModel,
    hostSessionId: body.hostSessionId,
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
      loopName: result.data.loopName,
      sessionId: result.data.sessionId,
      worktreeDir: result.data.worktreeDir,
      displayName: result.data.displayName,
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
  const body = await parseJsonBody<import('../schemas').LoopRestart>(_req, LoopRestartBody)

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
