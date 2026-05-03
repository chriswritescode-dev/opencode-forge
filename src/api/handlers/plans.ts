import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { PlanWriteBody, PlanPatchBody } from '../schemas'
import { applyPlanPatch } from '../../utils/plan-patch'

export async function handleGetSessionPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId, sessionId } = params
  const result = deps.ctx.plansRepo.getForSession(projectId, sessionId)

  if (!result) {
    throw new ForgeRpcError('not_found', 'plan not found')
  }

  return {
    sessionId: result.sessionId ?? undefined,
    loopName: result.loopName ?? undefined,
    content: result.content,
    updatedAt: result.updatedAt,
  }
}

export async function handleGetLoopPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId, loopName } = params
  const result = deps.ctx.plansRepo.getForLoop(projectId, loopName)

  if (!result) {
    throw new ForgeRpcError('not_found', 'plan not found')
  }

  return {
    sessionId: result.sessionId ?? undefined,
    loopName: result.loopName ?? undefined,
    content: result.content,
    updatedAt: result.updatedAt,
  }
}

export async function handleWriteSessionPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId, sessionId } = params
  const parsed = PlanWriteBody.parse(body)

  deps.ctx.plansRepo.writeForSession(projectId, sessionId, parsed.content)

  return { sessionId, content: parsed.content }
}

export async function handleWriteLoopPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId, loopName } = params
  const parsed = PlanWriteBody.parse(body)

  deps.ctx.plansRepo.writeForLoop(projectId, loopName, parsed.content)

  return { loopName, content: parsed.content }
}

export async function handlePatchSessionPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId, sessionId } = params
  const parsed = PlanPatchBody.parse(body)

  const existing = deps.ctx.plansRepo.getForSession(projectId, sessionId)

  if (!existing) {
    throw new ForgeRpcError('not_found', 'plan not found')
  }

  const result = applyPlanPatch(existing.content, parsed.old_string, parsed.new_string)

  if (!result.success) {
    if (result.error?.includes('not found')) {
      throw new ForgeRpcError('not_found', result.error)
    }
    if (result.error?.includes('times')) {
      throw new ForgeRpcError('conflict', result.error || 'patch failed')
    }
    throw new ForgeRpcError('bad_request', result.error || 'patch failed')
  }

  deps.ctx.plansRepo.writeForSession(projectId, sessionId, result.updated!)

  return { sessionId, content: result.updated! }
}

export async function handleDeleteSessionPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId, sessionId } = params
  deps.ctx.plansRepo.deleteForSession(projectId, sessionId)
  return { deleted: true }
}

export async function handleDeleteLoopPlan(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId, loopName } = params
  deps.ctx.plansRepo.deleteForLoop(projectId, loopName)
  return { deleted: true }
}
