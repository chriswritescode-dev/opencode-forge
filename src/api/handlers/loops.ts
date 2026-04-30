import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { LoopStartBody, LoopRestartBody } from '../schemas'
import { cancelLoopByName, restartLoopByName } from '../../services/loop-control'
import { createForgeExecutionService, type ForgeExecutionRequestContext, type ForgeExecutionCommand } from '../../services/execution'
import type { LoopInfo } from '../../utils/tui-refresh-helpers'
import type { LoopRow } from '../../storage/repos/loops-repo'

function loopRowToLoopInfo(row: LoopRow): LoopInfo & { loopName: string; status: string } {
  return {
    loopName: row.loopName,
    name: row.loopName,
    status: row.status === 'running' ? 'running' : (row.terminationReason ?? 'unknown'),
    phase: row.phase,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    sessionId: row.currentSessionId,
    active: row.status === 'running',
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    terminationReason: row.terminationReason ?? undefined,
    worktree: row.worktree,
    worktreeDir: row.worktreeDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
  }
}

export async function handleListLoops(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId } = params
  const rows = deps.ctx.loopsRepo.listAll(projectId)
  
  const loops = rows.map(loopRowToLoopInfo)
  const active = loops.filter((entry) => entry.active)
  const recent = loops.filter((entry) => !entry.active)

  return { loops, active, recent }
}

export async function handleGetLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId, loopName } = params
  const row = deps.ctx.loopsRepo.get(projectId, loopName)

  if (!row) {
    throw new ForgeRpcError('not_found', 'loop not found')
  }

  return loopRowToLoopInfo(row)
}

export async function handleStartLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const parsed = LoopStartBody.parse(body)

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
    source: { kind: 'inline', planText: parsed.plan },
    title: parsed.title,
    mode: parsed.worktree ?? false ? 'worktree' : 'in-place',
    executionModel: parsed.executionModel,
    auditorModel: parsed.auditorModel,
    hostSessionId: parsed.hostSessionId,
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
    loopName: result.data.loopName,
    sessionId: result.data.sessionId,
    worktreeDir: result.data.worktreeDir,
    displayName: result.data.displayName,
  }
}

export async function handleCancelLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { loopName } = params

  const result = await cancelLoopByName(deps.ctx, loopName)

  if (!result.ok) {
    throw new ForgeRpcError(result.code, result.message)
  }

  return { loopName, status: 'cancelled' }
}

export async function handleRestartLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { loopName } = params
  const parsed = LoopRestartBody.parse(body)

  const result = await restartLoopByName(deps.ctx, loopName, parsed.force ?? false)

  if (!result.ok) {
    throw new ForgeRpcError(result.code, result.message)
  }

  return {
    loopName,
    status: 'restarted',
    force: parsed.force ?? false,
    sessionId: result.newSessionId,
    worktreeDir: result.state.worktreeDir,
    iteration: result.state.iteration,
    sandbox: result.sandbox,
    bindFailed: result.bindFailed,
  }
}
