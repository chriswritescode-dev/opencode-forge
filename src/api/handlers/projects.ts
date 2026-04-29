import type { ApiDeps } from '../types'
import { ok } from '../response'
import { Database } from 'bun:sqlite'
import { homedir, platform } from 'os'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { readGraphStatus } from '../../utils/tui-graph-status'

function withOpencodeProjectDb<T>(fn: (db: Database) => T): T | null {
  try {
    const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
    const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
    const opencodePath = join(xdgDataHome, 'opencode', 'opencode.db')

    if (!existsSync(opencodePath)) return null

    const db = new Database(opencodePath, { readonly: true })

    try {
      return fn(db)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export function listKnownProjects(): Array<{ id: string; name: string | null; directory: string | null }> {
  const result =
    withOpencodeProjectDb((db) => {
      const rows = db.prepare('SELECT id, worktree FROM project').all() as Array<{
        id: string
        worktree: string
      }>
      return rows.map((row) => ({
        id: row.id,
        name: basename(row.worktree),
        directory: row.worktree,
      }))
    }) ?? []
  return result
}

export async function handleListProjects(
  req: Request,
  deps: ApiDeps
): Promise<Response> {
  const url = new URL(req.url)
  const directoryFilter = url.searchParams.get('directory')

  // Prune expired instances
  deps.apiRegistryRepo.pruneExpired(Date.now())

  const registered = deps.registry.list()
  const persistedInstances = deps.apiRegistryRepo.listProjectInstances()
  const known = listKnownProjects()
  
  const registeredIds = new Set(registered.map((ctx) => ctx.projectId))
  const persistedIds = new Set(persistedInstances.map((row) => row.projectId))

  const projects = [
    ...registered.map((ctx) => ({
      id: ctx.projectId,
      name: basename(ctx.directory),
      directory: ctx.directory,
      active: true,
    })),
    ...persistedInstances
      .filter((row) => !registeredIds.has(row.projectId))
      .map((row) => ({
        id: row.projectId,
        name: basename(row.directory),
        directory: row.directory,
        active: true,
      })),
    ...known
      .filter((project) => !registeredIds.has(project.id) && !persistedIds.has(project.id))
      .map((project) => ({
        id: project.id,
        name: project.name,
        directory: project.directory,
        active: false,
      })),
  ]

  if (directoryFilter) {
    const matched = projects.find((project) => project.active && project.directory === directoryFilter)
    return ok({ projects: matched ? [matched] : [] })
  }

  return ok({ projects })
}

export async function handleGetProject(
  _req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const { directory } = deps.ctx

  return ok({ id: projectId, directory })
}

export async function handleGetGraphStatus(
  req: Request,
  _deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const url = new URL(req.url)
  const cwd = url.searchParams.get('cwd') ?? undefined
  return ok({ status: readGraphStatus(projectId, undefined, cwd) })
}
