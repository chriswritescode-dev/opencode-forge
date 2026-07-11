/**
 * Forge workspace helpers using the ForgeClient port.
 *
 * The recommended entry point is {@link createBuiltinWorktreeWorkspace}, which creates
 * a Forge workspace with `type: 'forge'` through the ForgeClient adapter,
 * then registers it via syncList so the TUI can show it as connected (green dot).
 *
 * Workspaces are created with `type: 'forge'` (not `type: 'worktree'`) because
 * Forge uses its own adapter registered in the experimental workspace API.
 */

import type { ForgeClient } from '../client/port'
import type { WorkspaceStatusRegistry } from '../utils/workspace-status-registry'
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

/**
 * Look up existing forge workspaces by loop name.
 */
async function findExistingForgeWorkspaces(
  client: ForgeClient,
  loopName: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<ForgeWorkspaceEntry[]> {
  try {
    const entries = (await client.workspace.list() ?? []) as ForgeWorkspaceEntry[]
    const matches = entries.filter((entry) => entry.id && workspaceMatchesLoop(entry, loopName))
    if (matches.length > 0) {
      (logger ?? console).log?.(`findExistingForgeWorkspaces: found ${matches.length} existing workspace(s) for loop ${loopName}`)
    }
    return matches
  } catch (err) {
    (logger ?? console).error('findExistingForgeWorkspaces: workspace.list threw', err)
    return []
  }
}

function workspaceMatchesLoop(entry: ForgeWorkspaceEntry, loopName: string): boolean {
  if (entry.type !== 'forge') return false
  if (entry.name === loopName) return true
  return getForgeWorkspaceLoopName(entry) === loopName
}

export async function removeExistingForgeLoopWorkspaces(
  client: ForgeClient,
  loopName: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<void> {
  const matches = await findExistingForgeWorkspaces(client, loopName, logger)
  for (const match of matches) {
    try {
      await client.workspace.remove({ id: match.id })
      ;(logger ?? console).log?.(`removeExistingForgeLoopWorkspaces: removed old workspace ${match.id} for loop ${loopName}`)
    } catch (err) {
      ;(logger ?? console).error?.(`removeExistingForgeLoopWorkspaces: failed to remove workspace ${match.id}`, err)
    }
  }
}

/**
 * Creates a Forge workspace via the ForgeClient port with the `forge` adapter.
 *
 * Uses `client.workspace.create({ type: 'forge', branch: null })` so the
 * workspace appears as fully connected (green dot) in the TUI.
 *
 * After a successful create, also issues a best-effort `client.workspace.syncList()`
 * so the new workspace is registered in the Warp picker, not just reachable from the session list.
 *
 * @returns `{ ok: true, workspace: { workspaceId, directory, branch } }` on success,
 *          or `{ ok: false, error: WorkspaceCreateError }` on failure.
 */
export async function createBuiltinWorktreeWorkspace(
  client: ForgeClient,
  options: {
    loopName: string
    directory: string
  },
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
  statusRegistry?: WorkspaceStatusRegistry,
): Promise<CreateWorktreeWorkspaceResult> {
  if (!options.directory) {
    (logger ?? console).error('createBuiltinWorktreeWorkspace: options.directory is required')
    return { ok: false, error: { reason: 'unknown', message: 'createBuiltinWorktreeWorkspace: options.directory is required' } }
  }
  try {
    const _wsStart = Date.now()
    ;(logger ?? console).log?.(`[warp] workspace.create.start loopName=${options.loopName}`)
    const createParams: { type: string; branch: string | null; extra: { loopName: string; projectDirectory: string; workspaceCreatedAt: number } } = {
      type: 'forge',
      branch: null,
      extra: { loopName: options.loopName, projectDirectory: options.directory, workspaceCreatedAt: Date.now() },
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

    // Best-effort syncList to register in the Warp picker
    try {
      await client.workspace.syncList()
      ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} registered via syncList`)
      ;(logger ?? console).log?.(`[warp] syncList.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)
    } catch (err) {
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: syncList after create failed; workspace may be reachable via session list but not visible in Warp picker', err)
    }

    // Best-effort sync.start (adapter no-ops when unavailable)
    try {
      await client.sync.start()
      ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace sync started for ${id}`)
      ;(logger ?? console).log?.(`[warp] sync.start.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)
    } catch (err) {
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: sync.start after create failed; workspace status may remain unavailable in the TUI', err)
    }

    try {
      const [listData, statusData] = await Promise.all([
        client.workspace.list(),
        client.workspace.status(),
      ])
      const listed = (listData ?? []).some((workspace: Record<string, unknown>) => workspace.id === id)
      const statusArr = (statusData ?? []) as Array<{ workspaceID?: string; status?: string }>
      const status = statusArr.find((entry) => entry.workspaceID === id)?.status
      statusRegistry?.primeFromSnapshot(statusArr.map((entry) => ({ workspaceID: entry.workspaceID ?? '', status: entry.status ?? '' })))
      ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} visibility listed=${listed} status=${status ?? 'unknown'}`)
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
  statusRegistry?: WorkspaceStatusRegistry,
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

  // Best-effort sync.start (adapter no-ops when unavailable)
  try {
    await client.sync.start()
    ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace sync started for workspace=${workspaceId} session=${sessionId}`)
  } catch (err) {
    ;(logger ?? console).error('bindSessionToWorkspace: sync.start after warp failed; workspace status may remain unavailable in the TUI', err)
  }

  try {
    const [listData, statusData] = await Promise.all([
      client.workspace.list(),
      client.workspace.status(),
    ])
    const listArr = (listData ?? []) as Array<{ id?: string }>
    const listed = listArr.some((workspace) => workspace.id === workspaceId)
    const statusArr = (statusData ?? []) as Array<{ workspaceID?: string; status?: string }>
    const status = statusArr.find((entry) => entry.workspaceID === workspaceId)?.status
    statusRegistry?.primeFromSnapshot(statusArr.map((entry) => ({ workspaceID: entry.workspaceID ?? '', status: entry.status ?? '' })))
    ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace ${workspaceId} visibility after warp listed=${listed} status=${status ?? 'unknown'}`)
  } catch (err) {
    ;(logger ?? console).error('bindSessionToWorkspace: post-warp workspace visibility check failed', err)
  }
}
