import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import { createLoopSessionWithWorkspace } from './loop-session'
import { buildAuditSessionPermissionRuleset } from '../constants/loop'
import { formatAuditSessionTitle } from './session-titles'

interface RunAuditSessionInput {
  client: ForgeClient
  loopName: string
  iteration: number
  currentSectionIndex: number
  totalSections: number
  worktreeDir: string
  workspaceId?: string
  auditorModel?: { providerID: string; modelID: string }
  prompt: string
  /** Absolute directories to grant audit-session read access to despite worktree isolation. */
  allowDirectories?: string[]
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
  const { client } = input
  const permission = buildAuditSessionPermissionRuleset({ allowDirectories: input.allowDirectories })
  const created = await createLoopSessionWithWorkspace({
    client,
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
  client: ForgeClient,
  input: {
    sessionId: string
    worktreeDir: string
    workspaceId?: string
    prompt: string
    auditorModel?: { providerID: string; modelID: string }
    auditorVariant?: string
  },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const parts = [{ type: 'text' as const, text: input.prompt }]
  try {
    await client.session.promptAsync({
      sessionID: input.sessionId,
      directory: input.worktreeDir,
      ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
      agent: 'auditor-loop',
      parts,
      ...(input.auditorModel ? { model: input.auditorModel } : {}),
      ...(input.auditorVariant ? { variant: input.auditorVariant } : {}),
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

