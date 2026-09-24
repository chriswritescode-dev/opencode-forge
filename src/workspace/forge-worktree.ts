/**
 * Forge workspace helpers using the ForgeClient port.
 *
 * The recommended entry point is {@link createBuiltinWorktreeWorkspace}, which creates
 * a Forge workspace with `type: 'forge'` through the ForgeClient adapter.
 *
 * Workspaces are created with `type: 'forge'` (not `type: 'worktree'`) because
 * Forge uses its own adapter registered in the experimental workspace API.
 */

import type { ForgeClient } from '../client/port'
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
  extra?: Record<string, unknown> | null
}

export interface CreatedWorktreeWorkspace {
  workspaceId: string
  directory: string
  branch: string
}

export type CreateWorktreeWorkspaceResult =
  | { ok: true; workspace: CreatedWorktreeWorkspace }
  | { ok: false; error: WorkspaceCreateError }

/**
 * Checks whether the given project ID is valid for worktree loops.
 * Worktree loops require a committed git project — when opencode starts in a
 * directory without a root commit it scopes the instance to project 'global'.
 * Returns an actionable error message string, or `null` if the project is valid.
 */
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

export function getForgeWorkspaceLoopName(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  const loopName = entry.extra?.loopName
  return typeof loopName === 'string' && loopName.length > 0 ? loopName : undefined
}

export function getForgeWorkspacePermissionRules(entry: Pick<ForgeWorkspaceEntry, 'extra'>): PermissionRule[] {
  const raw = entry.extra?.permissionRules
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter(
    (r): r is PermissionRule =>
      typeof r === 'object' && r !== null &&
      typeof (r as PermissionRule).permission === 'string' &&
      typeof (r as PermissionRule).pattern === 'string' &&
      (r as PermissionRule).permission.length > 0 &&
      (r as PermissionRule).pattern.length > 0 &&
      (r as PermissionRule).action === 'deny' &&
      !FORGE_MANAGED_PERMISSIONS.has((r as PermissionRule).permission) &&
      !((r as PermissionRule).pattern === '*' && FORGE_REQUIRED_PERMISSIONS.has((r as PermissionRule).permission)),
  )
}

/**
 * Looks up a single forge workspace by id. Returns `undefined` when the id is absent.
 */
export async function getForgeWorkspaceEntry(
  client: ForgeClient,
  workspaceId: string,
): Promise<ForgeWorkspaceEntry | undefined> {
  const entries = (await client.workspace.list() ?? []) as ForgeWorkspaceEntry[]
  return entries.find((entry) => entry.id === workspaceId)
}

/**
 * Creates a Forge workspace via the ForgeClient port with the `forge` adapter.
 *
 * Uses `client.workspace.create({ type: 'forge', branch: null })`.
 *
 * @returns `{ ok: true, workspace: { workspaceId, directory, branch } }` on success,
 *          or `{ ok: false, error: WorkspaceCreateError }` on failure.
 */
export async function createBuiltinWorktreeWorkspace(
  client: ForgeClient,
  options: {
    loopName: string
    directory: string
    /** Caller-supplied extra fields preserved onto the new workspace (e.g. portable permission rules). */
    extra?: Record<string, unknown>
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
    const createParams: { type: string; branch: string | null; extra: Record<string, unknown> } = {
      type: 'forge',
      branch: null,
      extra: {
        ...options.extra,
        loopName: options.loopName,
        projectDirectory: options.directory,
        workspaceCreatedAt: Date.now(),
      },
    }
    const workspaceData = await client.workspace.create(createParams)

    const id = typeof workspaceData === 'string'
      ? workspaceData
      : workspaceData && typeof workspaceData === 'object' && 'id' in workspaceData && typeof workspaceData.id === 'string'
        ? workspaceData.id
        : null

    const directory = workspaceData && typeof workspaceData === 'object' && 'directory' in workspaceData
      ? String((workspaceData as Record<string, unknown>).directory ?? '')
      : ''

    const branch = workspaceData && typeof workspaceData === 'object' && 'branch' in workspaceData
      ? String((workspaceData as Record<string, unknown>).branch ?? '')
      : ''

    if (!id) {
      const error = workspaceCreateMissingId(workspaceData)
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned no workspace id', workspaceData)
      return { ok: false, error }
    }

    // opencode awaits the connected event internally before returning,
    // see opencode source workspace.ts (Event.Status loop). The response should
    // not reach us until the worktree is ready or errored — verify directory is populated.
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

/**
 * Binds a session to a workspace by calling the warp API.
 */
export async function bindSessionToWorkspace(
  client: ForgeClient,
  workspaceId: string,
  sessionId: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
  options?: { copyChanges?: boolean; loopName?: string },
): Promise<void> {
  const warpParams: { id: string; sessionID: string; copyChanges?: boolean } = {
    id: workspaceId,
    sessionID: sessionId,
  }
  if (typeof options?.copyChanges === 'boolean') warpParams.copyChanges = options.copyChanges

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
