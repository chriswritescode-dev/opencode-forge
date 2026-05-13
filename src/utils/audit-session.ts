import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import { createLoopSessionWithWorkspace } from './loop-session'
import { buildAuditSessionPermissionRuleset } from '../constants/loop'
import { formatAuditSessionTitle } from './session-titles'

interface RunAuditSessionInput {
  v2: OpencodeClient
  loopName: string
  iteration: number
  currentSectionIndex: number
  totalSections: number
  worktreeDir: string
  workspaceId?: string
  isSandbox: boolean
  auditorModel?: { providerID: string; modelID: string }
  prompt: string
  logger: Logger | Console
}

interface RunAuditSessionResult {
  auditSessionId: string
  boundWorkspaceId?: string
  bindFailed: boolean
  bindError?: unknown
}

export async function createAuditSession(
  input: RunAuditSessionInput,
): Promise<RunAuditSessionResult | null> {
  const permission = buildAuditSessionPermissionRuleset()
  const created = await createLoopSessionWithWorkspace({
    v2: input.v2,
    title: formatAuditSessionTitle(input.loopName, {
      iteration: input.iteration,
      currentSectionIndex: input.currentSectionIndex,
      totalSections: input.totalSections,
    }),
    directory: input.worktreeDir,
    permission,
    workspaceId: input.workspaceId,
    loopName: input.loopName,
    logPrefix: `loop ${input.loopName} audit`,
    logger: input.logger,
  })
  if (!created) return null
  return {
    auditSessionId: created.sessionId,
    boundWorkspaceId: created.boundWorkspaceId,
    bindFailed: created.bindFailed,
    bindError: created.bindError,
  }
}

export async function promptAuditSession(
  v2: OpencodeClient,
  input: {
    sessionId: string
    worktreeDir: string
    workspaceId?: string
    prompt: string
    auditorModel?: { providerID: string; modelID: string }
  },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const parts = [{ type: 'text' as const, text: input.prompt }]
  const result = await v2.session.promptAsync({
    sessionID: input.sessionId,
    directory: input.worktreeDir,
    ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
    agent: 'auditor-loop',
    parts,
    ...(input.auditorModel ? { model: input.auditorModel } : {}),
  })
  if (result.error) return { ok: false, error: result.error }
  return { ok: true }
}


