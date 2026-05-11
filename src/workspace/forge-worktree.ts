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
    const createParams: { type: string; branch: string | null; directory?: string } = {
      type: 'worktree',
      branch: null,
    }
    if (options.directory) {
      createParams.directory = options.directory
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
  logger?: { log: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  const workspaceApi = client.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.warp !== 'function') {
    (logger ?? console).log?.('bindSessionToWorkspace: experimental.workspace.warp not available')
    throw new Error('experimental.workspace.warp not available on this host')
  }
  const result = await workspaceApi.warp({
    id: workspaceId,
    sessionID: sessionId,
  })

  if ('error' in result && result.error) {
    (logger ?? console).error(`bindSessionToWorkspace: warp failed for workspace=${workspaceId} session=${sessionId}`, result.error)
    throw new Error(`Session warp failed: ${JSON.stringify(result.error)}`)
  }
}
