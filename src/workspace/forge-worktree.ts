/**
 * Forge worktree workspace adaptor.
 * 
 * This module provides a workspace adaptor that binds forge worktree loops
 * to OpenCode workspaces, enabling TUI switching and workspace-aware session management.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { WorkspaceInfo, WorkspaceAdaptor, WorkspaceTarget } from '@opencode-ai/plugin'

export type { WorkspaceInfo, WorkspaceAdaptor }

/**
 * Workspace type constant for forge worktree workspaces.
 */
export const FORGE_WORKTREE_WORKSPACE_TYPE = 'forge-worktree'

/**
 * Extra payload shape for forge worktree workspace info.
 */
export interface ForgeWorktreeExtra {
  loopName: string
  directory: string
  branch?: string | null
}

/**
 * Creates a forge worktree workspace adaptor.
 * 
 * This adaptor:
 * - configure(): Normalizes loop metadata from extra into workspace fields
 * - create(): No-op for already-created forge worktrees
 * - remove(): No-op to prevent implicit deletion during view/switch
 * - target(): Returns local directory target
 * 
 * @returns WorkspaceAdaptor compatible with experimental_workspace.register
 */
export function createForgeWorktreeAdaptor(): WorkspaceAdaptor {
  return {
    name: 'Forge Worktree',
    description: 'Workspace adaptor for forge worktree loops',
    
    configure(info: WorkspaceInfo): WorkspaceInfo {
      // Extract loop metadata from extra payload
      const extra = (info.extra ?? {}) as Partial<ForgeWorktreeExtra>

      // Normalize workspace info from loop metadata
      return {
        ...info,
        name: extra.loopName ?? info.name,
        directory: extra.directory ?? info.directory,
        branch: extra.branch ?? info.branch,
      }
    },
    
    async create(_info: WorkspaceInfo, _from?: WorkspaceInfo): Promise<void> {
      // No-op: forge worktrees are already created by the time workspace is registered
      // This adaptor only surfaces existing worktrees to the workspace system
      // Do NOT create a second git worktree here
    },
    
    async remove(_info: WorkspaceInfo): Promise<void> {
      // No-op: prevent workspace operations from implicitly deleting forge worktrees
      // Worktree lifecycle is managed by forge loop commands, not workspace commands
    },
    
    target(info: WorkspaceInfo): WorkspaceTarget {
      // Return local directory target for workspace routing
      return {
        type: 'local',
        directory: info.directory!,
      }
    },
  }
}

/**
 * Creates a workspace for a loop session.
 * 
 * For forge worktrees, this creates a workspace record with the forge-worktree type
 * and the directory as the workspace ID. The workspace database entry is created
 * by calling the upstream workspace.create API.
 * 
 * @param client - OpenCode v2 client
 * @param options - Workspace creation options
 * @returns Promise resolving to workspace ID or null on failure
 */
export async function createLoopWorkspace(
  client: OpencodeClient,
  options: {
    loopName: string
    directory: string
    branch?: string | null
  }
): Promise<{ workspaceId: string } | null> {
  try {
    // Create workspace record via upstream API - let the system generate a proper workspace ID
    const result = await client.experimental.workspace.create({
      type: FORGE_WORKTREE_WORKSPACE_TYPE,
      branch: options.branch ?? null,
      extra: {
        loopName: options.loopName,
        directory: options.directory,
        branch: options.branch ?? null,
      },
    })
    
    if ('error' in result && result.error) {
      console.error('Failed to create workspace', result.error)
      return null
    }
    
    if (!('data' in result) || !result.data) {
      console.error('Failed to create workspace: no data returned')
      return null
    }
    
    return {
      workspaceId: result.data.id,
    }
  } catch (err) {
    console.error('Failed to create loop workspace', err)
    return null
  }
}

/**
 * Binds a session to a workspace by calling the session restore API.
 * 
 * This calls the upstream experimental.workspace.sessionRestore endpoint to
 * replay the session's sync events into the target workspace, making the
 * session workspace-scoped.
 * 
 * @param client - OpenCode v2 client
 * @param workspaceId - The workspace ID
 * @param sessionId - The session ID
 */
export async function bindSessionToWorkspace(
  client: OpencodeClient,
  workspaceId: string,
  sessionId: string
): Promise<void> {
  const result = await client.experimental.workspace.sessionRestore({
    id: workspaceId,
    sessionID: sessionId,
  })

  if ('error' in result && result.error) {
    throw new Error(`Session restore failed: ${JSON.stringify(result.error)}`)
  }
}
