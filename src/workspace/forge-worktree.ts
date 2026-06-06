/**
 * Forge workspace helpers using opencode's experimental workspace API.
 *
 * The recommended entry point is {@link createBuiltinWorktreeWorkspace}, which creates
 * a Forge workspace with `type: 'forge'` through opencode's experimental adapter,
 * then registers it via syncList so the TUI can show it as connected (green dot).
 *
 * Workspaces are created with `type: 'forge'` (not `type: 'worktree'`) because
 * Forge uses its own adapter registered in the experimental workspace API.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { WorkspaceStatusRegistry } from '../utils/workspace-status-registry'

export interface ForgeWorkspaceEntry {
  id: string
  name?: string
  type?: string | null
  branch?: string | null
  directory?: string | null
  extra?: Record<string, unknown> | null
}

export function getForgeWorkspaceLoopName(entry: Pick<ForgeWorkspaceEntry, 'extra'>): string | undefined {
  const loopName = entry.extra?.loopName
  return typeof loopName === 'string' && loopName.length > 0 ? loopName : undefined
}

/**
 * Look up existing forge workspaces by loop name.
 */
async function findExistingForgeWorkspaces(
  client: OpencodeClient,
  loopName: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<ForgeWorkspaceEntry[]> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.list !== 'function') return []
  try {
    const result = await workspaceApi.list()
    const entries = ((result as { data?: unknown[] } | undefined)?.data ?? []) as ForgeWorkspaceEntry[]
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
  client: OpencodeClient,
  loopName: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<void> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.remove !== 'function') return
  const matches = await findExistingForgeWorkspaces(client, loopName, logger)
  for (const match of matches) {
    await workspaceApi.remove({ id: match.id })
    ;(logger ?? console).log?.(`removeExistingForgeLoopWorkspaces: removed old workspace ${match.id} for loop ${loopName}`)
  }
}

/**
 * Creates a Forge workspace via opencode's experimental workspace API with the `forge` adapter.
 *
 * Uses `experimental.workspace.create({ type: 'forge', branch: null })` so the
 * workspace appears as fully connected (green dot) in the TUI.
 *
 * After a successful create, also issues a best-effort `experimental.workspace.syncList()`
 * so the new workspace is registered in the Warp picker, not just reachable from the session list.
 *
 * @returns `{ workspaceId, directory, branch }` or `null` on failure.
 */
export async function createBuiltinWorktreeWorkspace(
  client: OpencodeClient,
  options: {
    loopName: string
    directory: string
  },
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
  statusRegistry?: WorkspaceStatusRegistry,
): Promise<{ workspaceId: string; directory: string; branch: string } | null> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.create !== 'function') {
    (logger ?? console).log?.('createBuiltinWorktreeWorkspace: experimental.workspace API not available')
    return null
  }
  if (!options.directory) {
    (logger ?? console).error('createBuiltinWorktreeWorkspace: options.directory is required')
    return null
  }
  try {
    const _wsStart = Date.now()
    ;(logger ?? console).log?.(`[warp] workspace.create.start loopName=${options.loopName}`)
    const createParams: { type: string; branch: string | null; extra: { loopName: string; projectDirectory: string; workspaceCreatedAt: number } } = {
      type: 'forge',
      branch: null,
      extra: { loopName: options.loopName, projectDirectory: options.directory, workspaceCreatedAt: Date.now() },
    }
    const result = await workspaceApi.create(createParams)

    if ('error' in result && result.error) {
      (logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned error', result.error)
      return null
    }

    const rawResult = result as unknown

    const workspaceData = 'data' in result ? result.data as unknown : rawResult

    const wsId =
      rawResult && typeof rawResult === 'object' && 'id' in rawResult && typeof rawResult.id === 'string'
        ? rawResult.id
        : null

    const id = typeof workspaceData === 'string'
      ? workspaceData
      : workspaceData && typeof workspaceData === 'object' && 'id' in workspaceData && typeof workspaceData.id === 'string'
        ? workspaceData.id
        : wsId

    const directory = workspaceData && typeof workspaceData === 'object' && 'directory' in workspaceData
      ? String((workspaceData as Record<string, unknown>).directory ?? '')
      : ''

    const branch = workspaceData && typeof workspaceData === 'object' && 'branch' in workspaceData
      ? String((workspaceData as Record<string, unknown>).branch ?? '')
      : ''

    if (!id) {
      (logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned no workspace id', workspaceData)
      return null
    }

    // opencode awaits the connected event internally before returning,
    // see opencode source workspace.ts (Event.Status loop). The response should
    // not reach us until the worktree is ready or errored — verify directory is populated.
    if (!directory) {
      (logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create returned empty directory', workspaceData)
      return null
    }

    (logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} created for ${options.loopName}`)
    ;(logger ?? console).log?.(`[warp] workspace.create.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)

    if (typeof workspaceApi.syncList === 'function') {
      try {
        await workspaceApi.syncList()
        ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} registered via syncList`)
        ;(logger ?? console).log?.(`[warp] syncList.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)
      } catch (err) {
        ;(logger ?? console).error('createBuiltinWorktreeWorkspace: syncList after create failed; workspace may be reachable via session list but not visible in Warp picker', err)
      }
    } else {
      ;(logger ?? console).log?.('createBuiltinWorktreeWorkspace: syncList not available on SDK, skipping registration')
    }

    if (typeof client.sync?.start === 'function') {
      try {
        await client.sync.start()
        ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace sync started for ${id}`)
        ;(logger ?? console).log?.(`[warp] sync.start.complete loopName=${options.loopName} workspaceId=${id} elapsedMs=${Date.now() - _wsStart}`)
      } catch (err) {
        ;(logger ?? console).error('createBuiltinWorktreeWorkspace: sync.start after create failed; workspace status may remain unavailable in the TUI', err)
      }
    }

    try {
      const [listResult, statusResult] = await Promise.all([
        typeof workspaceApi.list === 'function' ? workspaceApi.list() : Promise.resolve(undefined),
        typeof workspaceApi.status === 'function' ? workspaceApi.status() : Promise.resolve(undefined),
      ])
      const listed = ((listResult as { data?: Array<{ id?: string }> } | undefined)?.data ?? []).some((workspace) => workspace.id === id)
      const statusData = ((statusResult as { data?: Array<{ workspaceID?: string; status?: string }> } | undefined)?.data ?? [])
      const status = statusData.find((entry) => entry.workspaceID === id)?.status
      statusRegistry?.primeFromSnapshot(statusData.map((entry) => ({ workspaceID: entry.workspaceID ?? '', status: entry.status ?? '' })))
      ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} visibility listed=${listed} status=${status ?? 'unknown'}`)
    } catch (err) {
      ;(logger ?? console).error('createBuiltinWorktreeWorkspace: post-create workspace visibility check failed', err)
    }

    return { workspaceId: id, directory, branch }
  } catch (err) {
    (logger ?? console).error('createBuiltinWorktreeWorkspace: workspace.create threw', err)
    return null
  }
}

/**
 * Binds a session to a workspace by calling the warp API.
 */
export async function bindSessionToWorkspace(
  client: OpencodeClient,
  workspaceId: string,
  sessionId: string,
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
  options?: { copyChanges?: boolean; loopName?: string },
  statusRegistry?: WorkspaceStatusRegistry,
): Promise<void> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.warp !== 'function') {
    (logger ?? console).log?.('bindSessionToWorkspace: experimental.workspace.warp not available')
    throw new Error('experimental.workspace.warp not available on this host')
  }
  const warpParams: { id: string; sessionID: string; copyChanges?: boolean } = {
    id: workspaceId,
    sessionID: sessionId,
  }
  if (typeof options?.copyChanges === 'boolean') warpParams.copyChanges = options.copyChanges

  const _warpStart = Date.now()
  ;(logger ?? console).log?.(`[warp] warp.start loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId}`)
  const result = await workspaceApi.warp(warpParams)

  if ('error' in result && result.error) {
    const _warpError = String(result.error)
    ;(logger ?? console).error(`[warp] warp.failed loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId} elapsedMs=${Date.now() - _warpStart} error="${_warpError}"`)
    ;(logger ?? console).error(`bindSessionToWorkspace: warp failed for workspace=${workspaceId} session=${sessionId}`, result.error)
    throw new Error(`Session warp failed: ${JSON.stringify(result.error)}`)
  }

  ;(logger ?? console).log?.(`[warp] warp.complete loopName=${options?.loopName ?? 'unknown'} workspaceId=${workspaceId} sessionId=${sessionId} elapsedMs=${Date.now() - _warpStart}`)

  if (typeof client.sync?.start === 'function') {
    try {
      await client.sync.start()
      ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace sync started for workspace=${workspaceId} session=${sessionId}`)
    } catch (err) {
      ;(logger ?? console).error('bindSessionToWorkspace: sync.start after warp failed; workspace status may remain unavailable in the TUI', err)
    }
  }

  try {
    const [listResult, statusResult] = await Promise.all([
      typeof workspaceApi.list === 'function' ? workspaceApi.list() : Promise.resolve(undefined),
      typeof workspaceApi.status === 'function' ? workspaceApi.status() : Promise.resolve(undefined),
    ])
    const listed = ((listResult as { data?: Array<{ id?: string }> } | undefined)?.data ?? [])
      .some((workspace) => workspace.id === workspaceId)
    const statusData = ((statusResult as { data?: Array<{ workspaceID?: string; status?: string }> } | undefined)?.data ?? [])
    const status = statusData.find((entry) => entry.workspaceID === workspaceId)?.status
    statusRegistry?.primeFromSnapshot(statusData.map((entry) => ({ workspaceID: entry.workspaceID ?? '', status: entry.status ?? '' })))
    ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace ${workspaceId} visibility after warp listed=${listed} status=${status ?? 'unknown'}`)
  } catch (err) {
    ;(logger ?? console).error('bindSessionToWorkspace: post-warp workspace visibility check failed', err)
  }
}
