import type { ApiDeps } from '../types'
import { ForgeRpcError } from '../bus-protocol'
import { FindingWriteBody } from '../schemas'

export async function handleListFindings(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const queryParams = body as Record<string, string> | undefined
  const loopName = queryParams?.loopName
  const file = queryParams?.file

  let findings
  if (loopName !== undefined) {
    findings = deps.ctx.reviewFindingsRepo.listByLoopName(projectId, loopName === '' ? null : loopName)
  } else if (file) {
    findings = deps.ctx.reviewFindingsRepo.listByFile(projectId, file)
  } else {
    findings = deps.ctx.reviewFindingsRepo.listAll(projectId)
  }

  return { findings }
}

export async function handleWriteFinding(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const parsed = FindingWriteBody.parse(body)

  const result = deps.ctx.reviewFindingsRepo.write({
    projectId,
    file: parsed.file,
    line: parsed.line,
    severity: parsed.severity,
    description: parsed.description,
    scenario: parsed.scenario ?? null,
    loopName: parsed.loopName ?? null,
    sectionIndex: null,
  })

  if (!result.ok) {
    if (result.conflict) {
      throw new ForgeRpcError('conflict', 'finding already exists for this file and line')
    }
    throw new ForgeRpcError('internal', 'failed to write finding')
  }

  return { file: parsed.file, line: parsed.line }
}

export async function handleDeleteFinding(
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const queryParams = body as Record<string, string> | undefined
  const file = queryParams?.file
  const lineParam = queryParams?.line
  const loopName = queryParams?.loopName

  if (!file || !lineParam) {
    throw new ForgeRpcError('not_found', 'file and line query params required')
  }

  const line = parseInt(lineParam, 10)
  if (isNaN(line)) {
    throw new ForgeRpcError('not_found', 'invalid line number')
  }

  let deleted: boolean
  if (loopName !== undefined) {
    deleted = deps.ctx.reviewFindingsRepo.delete(projectId, file, line, { loopName: loopName === '' ? null : loopName })
  } else {
    deleted = deps.ctx.reviewFindingsRepo.delete(projectId, file, line)
  }

  if (!deleted) {
    throw new ForgeRpcError('not_found', 'finding not found')
  }

  return { deleted: true }
}
