import type { ApiDeps } from '../types'
import { ok } from '../response'
import { notFound } from '../errors'
import { parseJsonBody, FindingWriteBody } from '../schemas'

export async function handleListFindings(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const url = new URL(req.url)
  const branch = url.searchParams.get('branch')
  const file = url.searchParams.get('file')

  let findings
  if (branch) {
    findings = deps.ctx.reviewFindingsRepo.listByBranch(projectId, branch)
  } else if (file) {
    findings = deps.ctx.reviewFindingsRepo.listByFile(projectId, file)
  } else {
    findings = deps.ctx.reviewFindingsRepo.listAll(projectId)
  }

  return ok({ findings })
}

export async function handleWriteFinding(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const body = await parseJsonBody(req, FindingWriteBody)

  const result = deps.ctx.reviewFindingsRepo.write({
    projectId,
    file: body.file,
    line: body.line,
    severity: body.severity,
    description: body.description,
    scenario: body.scenario ?? null,
    branch: body.branch ?? null,
  })

  if (!result.ok) {
    if (result.conflict) {
      throw new Error('finding already exists for this file and line')
    }
    throw new Error('failed to write finding')
  }

  return ok({ file: body.file, line: body.line }, 201)
}

export async function handleDeleteFinding(
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const url = new URL(req.url)
  const file = url.searchParams.get('file')
  const lineParam = url.searchParams.get('line')

  if (!file || !lineParam) {
    throw notFound('file and line query params required')
  }

  const line = parseInt(lineParam, 10)
  if (isNaN(line)) {
    throw notFound('invalid line number')
  }

  const deleted = deps.ctx.reviewFindingsRepo.delete(projectId, file, line)

  if (!deleted) {
    throw notFound('finding not found')
  }

  return ok({ deleted: true })
}
