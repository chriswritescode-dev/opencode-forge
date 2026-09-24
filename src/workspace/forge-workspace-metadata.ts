import { join } from 'path'
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { isRecord } from '../utils/is-record'
import { forgeWorktreesRoot } from './forge-naming'

const FORGE_WORKSPACE_METADATA_DIR = '.forge'
const FORGE_WORKSPACE_METADATA_FILENAME = 'workspace.json'

export interface ForgeWorkspaceMetadata {
  id: string
  name: string
  type: string
  branch: string | null
  directory: string
  extra: Record<string, unknown> | null
  projectId: string
  createdAt: number
}

function metadataPath(dir: string): string {
  return join(dir, FORGE_WORKSPACE_METADATA_DIR, FORGE_WORKSPACE_METADATA_FILENAME)
}

export function writeForgeWorkspaceMetadata(dir: string, record: ForgeWorkspaceMetadata): void {
  mkdirSync(join(dir, FORGE_WORKSPACE_METADATA_DIR), { recursive: true })
  writeFileSync(metadataPath(dir), `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
}

export function readForgeWorkspaceMetadata(dir: string): ForgeWorkspaceMetadata | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metadataPath(dir), 'utf-8'))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const { id, name, type, branch, directory, extra, projectId, createdAt } = parsed
  if (typeof id !== 'string' || !id) return undefined
  if (typeof name !== 'string') return undefined
  if (typeof type !== 'string' || !type) return undefined
  if (typeof directory !== 'string' || !directory) return undefined
  if (typeof projectId !== 'string' || !projectId) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  return {
    id,
    name,
    type,
    branch: typeof branch === 'string' ? branch : null,
    directory,
    extra: isRecord(extra) ? extra : null,
    projectId,
    createdAt,
  }
}

export function removeForgeWorkspaceMetadata(dir: string): void {
  rmSync(metadataPath(dir), { force: true })
}

export function listForgeWorkspaceMetadata(dataDir: string): ForgeWorkspaceMetadata[] {
  const root = forgeWorktreesRoot(dataDir)
  if (!existsSync(root)) return []
  const records: ForgeWorkspaceMetadata[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const record = readForgeWorkspaceMetadata(join(root, entry.name))
    if (record) records.push(record)
  }
  return records
}
