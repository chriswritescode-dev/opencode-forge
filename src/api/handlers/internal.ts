import type { ApiDeps } from '../types'
import { badRequest } from '../errors'
import { ok } from '../response'
import type { ApiRegistryRepo } from '../../storage'

export interface InternalRegisterProjectInstanceInput {
  instanceId: string
  projectId: string
  directory: string
  ownerUrl: string
  pid: number
}

export async function handleRegisterProjectInstance(
  req: Request,
  deps: ApiDeps
): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw badRequest('invalid JSON body')
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !('instanceId' in body) ||
    !('projectId' in body) ||
    !('directory' in body) ||
    !('ownerUrl' in body) ||
    !('pid' in body)
  ) {
    throw badRequest('missing required fields: instanceId, projectId, directory, ownerUrl, pid')
  }

  const input = body as InternalRegisterProjectInstanceInput

  if (typeof input.instanceId !== 'string' || !input.instanceId) {
    throw badRequest('instanceId must be a non-empty string')
  }
  if (typeof input.projectId !== 'string' || !input.projectId) {
    throw badRequest('projectId must be a non-empty string')
  }
  if (typeof input.directory !== 'string' || !input.directory) {
    throw badRequest('directory must be a non-empty string')
  }
  if (typeof input.ownerUrl !== 'string' || !input.ownerUrl) {
    throw badRequest('ownerUrl must be a non-empty string')
  }
  if (typeof input.pid !== 'number' || !Number.isFinite(input.pid) || input.pid <= 0) {
    throw badRequest('pid must be a positive finite number')
  }

  if (!input.ownerUrl.startsWith('http://127.0.0.1:') && !input.ownerUrl.startsWith('http://[::1]:')) {
    throw badRequest('ownerUrl must be a localhost URL (http://127.0.0.1:* or http://[::1]:*)')
  }

  const repo = (deps as unknown as { apiRegistryRepo: ApiRegistryRepo }).apiRegistryRepo
  if (!repo) {
    throw badRequest('api registry repo not available')
  }

  repo.upsertProjectInstance({
    instanceId: input.instanceId,
    projectId: input.projectId,
    directory: input.directory,
    ownerUrl: input.ownerUrl,
    pid: input.pid,
    now: Date.now(),
    ttlMs: 30_000,
  })

  return ok({ registered: true })
}
