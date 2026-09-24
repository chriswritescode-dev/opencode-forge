import type { Plugin } from '@opencode/plugin'
import { existsSync } from 'fs'
import { requestError } from './errors'
import type {
  ForgeClient,
  WorkspaceCreateParams,
  WorkspaceCreateResult,
  WorkspaceList,
  WorkspaceRemoveParams,
  WorkspaceWarpParams,
} from './port'
import {
  listForgeWorkspaceMetadata,
  readForgeWorkspaceMetadata,
  removeForgeWorkspaceMetadata,
  writeForgeWorkspaceMetadata,
  type ForgeWorkspaceMetadata,
} from '../workspace/forge-workspace-metadata'
import { isRecord } from '../utils/is-record'
import type { ForgeWorkspaceAdapter, ForgeWorkspaceInfo } from '../workspace/forge-adapter'

const FORGE_WORKSPACE_TYPE = 'forge'

export interface V2ForgeWorkspacesDeps {
  adapter: ForgeWorkspaceAdapter
  worktree: Pick<Plugin.Context['worktree'], 'refresh'>
  projectId: string
  dataDir: string
  sessionMove: Plugin.Context['session']['move']
}

function toExtra(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function toWorkspaceInfo(record: ForgeWorkspaceMetadata): ForgeWorkspaceInfo {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    branch: record.branch,
    directory: record.directory,
    extra: record.extra,
    projectID: record.projectId,
  }
}

function toWorkspace(record: ForgeWorkspaceMetadata): WorkspaceCreateResult {
  const info = toWorkspaceInfo(record)
  return {
    id: info.id,
    type: info.type,
    name: info.name,
    branch: info.branch,
    directory: info.directory,
    extra: record.extra,
    projectID: info.projectID,
    timeUsed: record.createdAt,
  }
}

export function createV2ForgeWorkspaces(deps: V2ForgeWorkspacesDeps): ForgeClient['workspace'] {
  const { adapter, worktree, projectId, dataDir, sessionMove } = deps

  function listRecords(): ForgeWorkspaceMetadata[] {
    return listForgeWorkspaceMetadata(dataDir).filter(
      (record) => record.projectId === projectId && existsSync(record.directory),
    )
  }

  async function refreshInventory(): Promise<void> {
    try {
      await worktree.refresh({ projectID: projectId })
    } catch (err) {
      console.error('[forge-workspaces] worktree.refresh failed', err)
    }
  }

  return {
    async create(params: WorkspaceCreateParams): Promise<WorkspaceCreateResult> {
      const configured = adapter.configure({
        id: '',
        type: params.type ?? FORGE_WORKSPACE_TYPE,
        name: '',
        branch: params.branch ?? null,
        directory: null,
        extra: params.extra ?? null,
        projectID: projectId,
      })
      if (!configured.directory) {
        throw requestError('workspace.create', 'workspace adapter configure resolved no directory')
      }

      await adapter.create(configured)

      const record: ForgeWorkspaceMetadata = {
        id: configured.directory,
        name: configured.name,
        type: configured.type,
        branch: configured.branch,
        directory: configured.directory,
        extra: toExtra(configured.extra),
        projectId,
        createdAt: Date.now(),
      }
      writeForgeWorkspaceMetadata(configured.directory, record)
      await refreshInventory()
      return toWorkspace(record)
    },

    async list(): Promise<WorkspaceList> {
      return listRecords().map(toWorkspace)
    },

    async remove(params: WorkspaceRemoveParams): Promise<void> {
      const record = readForgeWorkspaceMetadata(params.id)
      if (record) {
        await adapter.remove(toWorkspaceInfo(record))
        removeForgeWorkspaceMetadata(params.id)
      }
      await refreshInventory()
    },

    async warp(params: WorkspaceWarpParams): Promise<void> {
      if (!params.id || !params.sessionID) {
        throw requestError('workspace.warp', 'workspace.warp requires a workspace id and a session id')
      }
      await sessionMove({ sessionID: params.sessionID, directory: params.id, delivery: 'queue' })
    },
  }
}
