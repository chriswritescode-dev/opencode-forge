import { join } from 'path'
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { z } from 'zod'
import type { WorkspaceExtra } from '../client/port'
import { listForgeWorktreeDirs } from './forge-naming'

const FORGE_WORKSPACE_METADATA_DIR = '.forge'
const FORGE_WORKSPACE_METADATA_FILENAME = 'workspace.json'

export interface ForgeWorkspaceMetadata {
  id: string
  name: string
  type: string
  branch: string | null
  directory: string
  extra: WorkspaceExtra | null
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

const forgeWorkspaceMetadataSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  branch: z.string().nullish(),
  directory: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).nullish().catch(null),
  projectId: z.string().min(1),
  createdAt: z.number().refine((value) => Number.isFinite(value)),
})

export function readForgeWorkspaceMetadata(dir: string): ForgeWorkspaceMetadata | undefined {
  let text: string
  try {
    text = readFileSync(metadataPath(dir), 'utf-8')
  } catch {
    return undefined
  }
  let contents: unknown
  try {
    contents = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = forgeWorkspaceMetadataSchema.safeParse(contents)
  if (!parsed.success) return undefined
  const record = parsed.data
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    branch: record.branch ?? null,
    directory: record.directory,
    extra: record.extra ?? null,
    projectId: record.projectId,
    createdAt: record.createdAt,
  }
}

export function removeForgeWorkspaceMetadata(dir: string): void {
  rmSync(metadataPath(dir), { force: true })
}

export function listForgeWorkspaceMetadata(dataDir: string): ForgeWorkspaceMetadata[] {
  const records: ForgeWorkspaceMetadata[] = []
  for (const dir of listForgeWorktreeDirs(dataDir)) {
    const record = readForgeWorkspaceMetadata(dir)
    if (record) records.push(record)
  }
  return records
}
