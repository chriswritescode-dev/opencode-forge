/**
 * Forge worktree workspace helpers.
 *
 * The recommended entry point is {@link createBuiltinWorktreeWorkspace}, which uses
 * opencode's builtin `worktree` workspace type for fully connected TUI status.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'

/**
 * Creates a builtin worktree workspace via opencode's built-in worktree adapter.
 *
 * Uses `experimental.workspace.create({ type: 'worktree', branch: null })` so the
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
    directory?: string
  },
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void }
): Promise<{ workspaceId: string; directory: string; branch: string } | null> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.create !== 'function') {
    (logger ?? console).log?.('createBuiltinWorktreeWorkspace: experimental.workspace API not available')
    return null
  }
  try {
    const createParams: { type: string; branch: string | null; extra: { loopName: string } } = {
      type: 'forge',
      branch: null,
      extra: { loopName: options.loopName },
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

    if (typeof workspaceApi.syncList === 'function') {
      try {
        await workspaceApi.syncList()
        ;(logger ?? console).log?.(`createBuiltinWorktreeWorkspace: workspace ${id} registered via syncList`)
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
      const status = ((statusResult as { data?: Array<{ workspaceID?: string; status?: string }> } | undefined)?.data ?? [])
        .find((entry) => entry.workspaceID === id)?.status
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
  options?: { copyChanges?: boolean }
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

  const result = await workspaceApi.warp(warpParams)

  if ('error' in result && result.error) {
    (logger ?? console).error(`bindSessionToWorkspace: warp failed for workspace=${workspaceId} session=${sessionId}`, result.error)
    throw new Error(`Session warp failed: ${JSON.stringify(result.error)}`)
  }

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
    const status = ((statusResult as { data?: Array<{ workspaceID?: string; status?: string }> } | undefined)?.data ?? [])
      .find((entry) => entry.workspaceID === workspaceId)?.status
    ;(logger ?? console).log?.(`bindSessionToWorkspace: workspace ${workspaceId} visibility after warp listed=${listed} status=${status ?? 'unknown'}`)
  } catch (err) {
    ;(logger ?? console).error('bindSessionToWorkspace: post-warp workspace visibility check failed', err)
  }
}
