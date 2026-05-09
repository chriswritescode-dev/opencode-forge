import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { LoopStartBody, LoopRestartBody } from '../schemas'
import { buildStartLoopCommand } from '../../services/execution'
import { buildService } from './_shared'
import type { LoopInfo } from '../../utils/tui-models'
import type { LoopRow } from '../../storage/repos/loops-repo'
import type { SectionPlanRow } from '../../storage/repos/section-plans-repo'

const cap200 = (s: string | null | undefined): string | null =>
  s ? (s.length > 200 ? s.slice(0, 200) : s) : null

function buildSectionViews(sectionPlans: SectionPlanRow[]): LoopInfo['sections'] {
  return sectionPlans.map((sp) => ({
    index: sp.sectionIndex,
    title: sp.title,
    status: sp.status,
    attempts: sp.attempts,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    summaryDone: cap200(sp.summaryDone),
    summaryDeviations: cap200(sp.summaryDeviations),
    summaryFollowUps: cap200(sp.summaryFollowUps),
  }))
}

function loopRowToLoopInfo(
  row: LoopRow,
  sectionPlans?: SectionPlanRow[]
): LoopInfo & { loopName: string; status: string } {
  const base = {
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
    decompositionStatus: row.decompositionStatus,
    decompositionMode: row.decompositionMode,
    currentSectionIndex: row.currentSectionIndex,
    totalSections: row.totalSections,
  }
  if (sectionPlans && sectionPlans.length > 0) {
    return { ...base, sections: buildSectionViews(sectionPlans) }
  }
  return base
}

export async function handleListLoops(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId } = params
  const rows = deps.ctx.loopsRepo.listAll(projectId)

  const loops = rows.map((row) => {
    const plans = deps.ctx.sectionPlansRepo.list(projectId, row.loopName)
    return loopRowToLoopInfo(row, plans.length > 0 ? plans : undefined)
  })
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

  const plans = deps.ctx.sectionPlansRepo.list(projectId, loopName)
  return loopRowToLoopInfo(row, plans.length > 0 ? plans : undefined)
}

export async function handleStartLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const parsed = LoopStartBody.parse(body)

  const { service, execCtx } = buildService(deps, projectId)

  const command = buildStartLoopCommand({
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
  })

  const result = await service.dispatch(execCtx, command)

  if (!result.ok) {
    throw new ForgeRpcError(result.error.code, result.error.message)
  }

  return {
    loopName: result.data.loopName,
    sessionId: result.data.sessionId,
    worktreeDir: result.data.worktreeDir,
    displayName: result.data.displayName,
    workspaceId: result.data.workspaceId,
  }
}

export async function handleCancelLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { loopName } = params
  const { service, execCtx } = buildService(deps, params.projectId)
  const result = await service.dispatch(execCtx, {
    type: 'loop.cancel',
    selector: { kind: 'exact', name: loopName },
  })
  if (!result.ok) throw new ForgeRpcError(result.error.code, result.error.message)
  return { loopName, status: 'cancelled' }
}

export async function handleRestartLoop(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { loopName } = params
  const parsed = LoopRestartBody.parse(body)
  const { service, execCtx } = buildService(deps, params.projectId)
  const result = await service.dispatch(execCtx, {
    type: 'loop.restart',
    selector: { kind: 'exact', name: loopName },
    force: parsed.force ?? false,
  })
  if (!result.ok) throw new ForgeRpcError(result.error.code, result.error.message)
  return {
    loopName,
    status: 'restarted',
    force: parsed.force ?? false,
    sessionId: result.data.sessionId,
    worktreeDir: result.data.worktreeDir,
    iteration: result.data.iteration,
    sandbox: result.data.sandbox,
    bindFailed: result.data.bindFailed,
  }
}
