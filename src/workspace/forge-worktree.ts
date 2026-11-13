import { z } from 'zod'
import type { ForgeClient, WorkspaceExtra, WorkspaceWarpParams } from '../client/port'
import { FORGE_MANAGED_PERMISSIONS, FORGE_REQUIRED_PERMISSIONS, type PermissionRule } from '../constants/loop'
import {
  classifyWorkspaceCreateThrow,
  workspaceCreateMissingId,
  workspaceCreateEmptyDirectory,
  type WorkspaceCreateError,
} from './workspace-create-error'

export interface ForgeWorkspaceEntry {
  id: string
  name?: string
  type?: string | null
  branch?: string | null
  directory?: string | null
  extra?: WorkspaceExtra | null
}

const workspaceCreateResultSchema = z.looseObject({
  id: z.string().optional(),
  directory: z.string().nullish(),
  branch: z.string().nullish(),
})

export interface CreatedWorktreeWorkspace {
  workspaceId: string
  directory: string
  branch: string
}

export type CreateWorktreeWorkspaceResult =
  | { ok: true; workspace: CreatedWorktreeWorkspace }
  | { ok: false; error: WorkspaceCreateError }

export function getWorktreeProjectPreconditionError(projectId: string | null): string | null {
  if (projectId === 'global') {
    return (
      'This directory has no committed git project (opencode resolved project "global"). ' +
      'Worktree loops require a repository with at least one commit; otherwise the loop session ' +
      'is created under a different project and is invisible to this opencode instance. ' +
      'Create an initial commit, restart opencode, and retry.'
    )
  }
  return null
}

const extraStringSchema = z.string().min(1)
const extraFiniteNumberSchema = z.number().refine((value) => Number.isFinite(value))

function readForgeExtraString(entry: Pick<ForgeWorkspaceEntry, 'extra'>, key: keyof WorkspaceExtra): string | undefined {
  const parsed = extraStringSchema.safeParse(entry.extra?.[key])
  return parsed.success ? parsed.data : undefined
}

export function readForgeExtraNumber(entry: Pick<ForgeWorkspaceEntry, 'extra'>, key: keyof WorkspaceExtra): number | undefined {
  const parsed = extraFiniteNumberSchema.safeParse(entry.extra?.[key])
  return parsed.success ? parsed.data : undefined
}

export function getForgeWorkspaceLoopName(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  return readForgeExtraString(entry, 'loopName')
}

const forgeLoopExtraSchema = z.object({
  hostSessionId: z.string().optional(),
  title: z.string().optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  executionVariant: z.string().optional(),
  auditorVariant: z.string().optional(),
  planSource: z.enum(['stored', 'inline']).optional(),
  planText: z.string().optional(),
  initialPromptOwner: z.enum(['server', 'tui']).optional(),
  pendingAttachStartedAt: z.number().optional(),
  sandboxEnabled: z.boolean().optional(),
  sandboxContainer: z.string().optional(),
  maxIterations: z.number().optional(),
})

export type ForgeLoopExtraFields = z.infer<typeof forgeLoopExtraSchema>

export function getForgeWorkspaceForgeLoop(entry: Pick<ForgeWorkspaceEntry, 'extra'>): ForgeLoopExtraFields | undefined {
  const parsed = forgeLoopExtraSchema.safeParse(entry.extra?.forgeLoop)
  return parsed.success ? parsed.data : undefined
}

export function getForgeWorkspaceProjectDirectory(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  return readForgeExtraString(entry, 'projectDirectory')
}

const FORGE_BASE_REF_EXTRA_KEY = 'baseRef'

export function getForgeWorkspaceBaseRef(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  return readForgeExtraString(entry, FORGE_BASE_REF_EXTRA_KEY)
}

const FORGE_BRANCH_EXTRA_KEY = 'branch'

export function getForgeWorkspaceBranch(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  return readForgeExtraString(entry, FORGE_BRANCH_EXTRA_KEY)
}

const permissionRuleSchema = z.looseObject({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(['allow', 'deny']),
})

export function getForgeWorkspacePermissionRules(entry: Pick<ForgeWorkspaceEntry, 'extra'>): PermissionRule[] {
  const parsed = z.array(permissionRuleSchema).safeParse(entry.extra?.permissionRules)
  if (!parsed.success) return []
  return parsed.data.filter(
    (rule) =>
      rule.permission.length > 0 &&
      rule.pattern.length > 0 &&
      rule.action === 'deny' &&
      !FORGE_MANAGED_PERMISSIONS.has(rule.permission) &&
      !(rule.pattern === '*' && FORGE_REQUIRED_PERMISSIONS.has(rule.permission)),
  )
}

export async function getForgeWorkspaceEntry(
  client: ForgeClient,
  workspaceId: string,
): Promise<ForgeWorkspaceEntry | undefined> {
  const entries = await client.workspace.list()
  return entries.find((entry) => entry.id === workspaceId)
}

export async function createBuiltinWorktreeWorkspace(
  client: ForgeClient,
  options: {
    loopName: string
    directory: string
    baseRef?: string
    branch?: string
    extra?: WorkspaceExtra
  },
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<CreateWorktreeWorkspaceResult> {
  if (!options.directory) {
    (logger ?? console).error('createBuiltinWorktreeWorkspace: options.directory is required')
    return { ok: false, error: { reason: 'unknown', message: 'createBuiltinWorktreeWorkspace: options.directory is required' } }
  }
  try {
    const _wsStart = Date.now()
    ;(logger ?? console).log?.(`[warp] workspace.create.start loopName=${options.loopName}`)
    const callerExtra: WorkspaceExtra = { ...options.extra }
    delete callerExtra[FORGE_BASE_REF_EXTRA_KEY]
    delete callerExtra[FORGE_BRANCH_EXTRA_KEY]
    const extra: WorkspaceExtra = {
      ...callerExtra,
      loopName: options.loopName,
      projectDirectory: options.directory,
      workspaceCreatedAt: Date.now(),
    }
    if (options.baseRef) extra[FORGE_BASE_REF_EXTRA_KEY] = options.baseRef
    if (options.branch) extra[FORGE_BRANCH_EXTRA_KEY] = options.branch
    const workspaceData = await client.workspace.create({ type: 'forge', branch: null, extra })

    const created = workspaceCreateResultSchema.safeParse(workspaceData)
    const id = created.success ? created.data.id : undefined
    const directory = created.success ? created.data.directory ?? '' : ''
    const branch = created.success ? created.data.branch ?? '' : ''

    if (!id) {
      const error = workspaceCreateMissingId(workspaceData)
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned no workspace id', workspaceData)
      return { ok: false, error }
    }

    if (!directory) {
      const error = workspaceCreateEmptyDirectory(workspaceData)
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned empty directory', workspaceData)
      return { ok: false, error }
    }

    (logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} created for ${options.loopName}`)
    ;(logger ?? console).log?.(`[warp] workspace.create.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)

    try {
      const listData = await client.workspace.list()
      const listed = (listData ?? []).some((workspace) => workspace.id === id)
      ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} visibility listed=${listed}`)
    } catch (err) {
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: post-create workspace visibility check failed', err)
    }

    return { ok: true, workspace: { workspaceId: id, directory, branch } }
  } catch (err) {
    const error = classifyWorkspaceCreateThrow(err)
    ;(logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create threw', err)
    return { ok: false, error }
  }
}

export async function bindSessionToWorkspace(
  client: ForgeClient,
  workspaceId: string,
  sessionId: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
  options?: { copyChanges?: boolean; loopName?: string },
): Promise<void> {
  const warpParams: WorkspaceWarpParams = {
    id: workspaceId,
    sessionID: sessionId,
  }
  if (options?.copyChanges !== undefined) warpParams.copyChanges = options.copyChanges

  const _warpStart = Date.now()
  ;(logger ?? console).log?.(`[warp] warp.start loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId}`)
  try {
    await client.workspace.warp(warpParams)
  } catch (err) {
    const _warpError = err instanceof Error ? err.message : String(err)
    ;(logger ?? console).error(`[warp] warp.failed loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId} elapsedMs=${Date.now() - _warpStart} error="${_warpError}"`)
    ;(logger ?? console).error(`bindSessionToWorkspace: warp failed for workspace=${workspaceId} session=${sessionId}`, err)
    throw err
  }

  ;(logger ?? console).log?.(`[warp] warp.complete loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId} elapsedMs=${Date.now() - _warpStart}`)

  try {
    const listData = await client.workspace.list()
    const listed = (listData ?? []).some((workspace) => workspace.id === workspaceId)
    ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace ${workspaceId} visibility after warp listed=${listed}`)
  } catch (err) {
    ;(logger ?? console).error('bindSessionToWorkspace: post-warp workspace visibility check failed', err)
  }
}
