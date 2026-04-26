import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import { createLoopSessionWithWorkspace } from './loop-session'
import { buildAuditSessionPermissionRuleset } from '../constants/loop'

export interface RunAuditSessionInput {
  v2: OpencodeClient
  loopName: string
  iteration: number
  worktreeDir: string
  workspaceId?: string
  isSandbox: boolean
  auditorModel?: { providerID: string; modelID: string }
  prompt: string
  logger: Logger | Console
}

export interface RunAuditSessionResult {
  auditSessionId: string
  boundWorkspaceId?: string
  bindFailed: boolean
}

export async function createAuditSession(
  input: RunAuditSessionInput,
): Promise<RunAuditSessionResult | null> {
  const permission = buildAuditSessionPermissionRuleset({ isSandbox: input.isSandbox })
  const created = await createLoopSessionWithWorkspace({
    v2: input.v2,
    title: `audit: ${input.loopName} #${input.iteration}`,
    directory: input.worktreeDir,
    permission,
    workspaceId: input.workspaceId,
    logPrefix: `loop ${input.loopName} audit`,
    logger: input.logger,
  })
  if (!created) return null
  return {
    auditSessionId: created.sessionId,
    boundWorkspaceId: created.boundWorkspaceId,
    bindFailed: created.bindFailed,
  }
}

export async function promptAuditSession(
  v2: OpencodeClient,
  input: {
    sessionId: string
    worktreeDir: string
    prompt: string
    auditorModel?: { providerID: string; modelID: string }
  },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const parts = [{ type: 'text' as const, text: input.prompt }]
  const result = await v2.session.promptAsync({
    sessionID: input.sessionId,
    directory: input.worktreeDir,
    agent: 'auditor-loop',
    parts,
    ...(input.auditorModel ? { model: input.auditorModel } : {}),
  })
  if (result.error) return { ok: false, error: result.error }
  return { ok: true }
}

export async function deleteAuditSession(
  v2: OpencodeClient,
  sessionId: string,
  worktreeDir: string,
  logger: Logger | Console,
): Promise<void> {
  try {
    await v2.session.delete({ sessionID: sessionId, directory: worktreeDir })
  } catch (err) {
    logger.error(`audit session delete failed for ${sessionId}`, err)
  }
}
