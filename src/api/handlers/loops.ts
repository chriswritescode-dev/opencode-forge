import type { ApiDeps } from '../types'
import { ok } from '../response'
import { notFound, conflict } from '../errors'
import { parseJsonBody, LoopStartBody, LoopRestartBody } from '../schemas'
import { listLoopStatesFromDb } from '../../storage/cli-helpers'
import { openDatabase } from '../../cli/utils'
import { launchFreshLoop } from '../../utils/loop-launch'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

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
  const active = loopStates
    .filter((entry) => entry.state.active)
    .map((entry) => ({
      loopName: entry.row.loop_name,
      status: entry.state.phase,
      sessionId: entry.state.sessionId,
      iteration: entry.state.iteration,
    }))

  const recent = loopStates
    .filter((entry) => !entry.state.active)
    .map((entry) => ({
      loopName: entry.row.loop_name,
      status: entry.state.terminationReason ?? 'unknown',
      terminationReason: entry.state.terminationReason,
    }))

  return ok({ active, recent })
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

  return ok({
    loopName: entry.row.loop_name,
    status: entry.state.active ? 'running' : (entry.state.terminationReason ?? 'unknown'),
    sessionId: entry.state.sessionId,
    iteration: entry.state.iteration,
    auditCount: entry.state.auditCount,
    errorCount: entry.state.errorCount,
    phase: entry.state.phase,
    worktree: entry.state.worktree,
    worktreeDir: entry.state.worktreeDir,
    worktreeBranch: entry.state.worktreeBranch,
  })
}

export async function handleStartLoop(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const body = await parseJsonBody(req, LoopStartBody)

  const { ctx } = deps

  // Create a minimal TUI API shim
  const tuiApi: TuiPluginApi = {
    client: ctx.v2,
  } as TuiPluginApi

  const result = await launchFreshLoop({
    planText: body.plan,
    title: body.title,
    directory: ctx.directory,
    projectId,
    isWorktree: body.worktree ?? false,
    api: tuiApi,
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
  const { projectId, loopName } = params

  // Terminate the loop
  deps.ctx.loopsRepo.terminate(projectId, loopName, {
    status: 'cancelled',
    reason: 'cancelled',
    completedAt: Date.now(),
  })

  return ok({ loopName, status: 'cancelled' })
}

export async function handleRestartLoop(
  _req: Request,
  _deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId, loopName } = params
  const body = await parseJsonBody(_req, LoopRestartBody)

  // Check if loop exists and get its status
  const db = openDatabase()
  if (!db) {
    throw notFound('database not found')
  }

  const loopStates = listLoopStatesFromDb(db, projectId)
  const entry = loopStates.find((e) => e.row.loop_name === loopName)

  if (!entry) {
    throw notFound('loop not found')
  }

  // If loop is active and force not specified, return conflict
  if (entry.state.active && !body.force) {
    throw conflict('loop is already active, use force=true to restart')
  }

  // For now, we'll return a simplified response
  // Full restart logic would mirror src/cli/commands/restart.ts
  return ok(
    {
      loopName,
      status: 'restarting',
      force: body.force ?? false,
    },
    202
  )
}
