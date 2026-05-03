import type { ApiDeps } from '../types'
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
  deps: ApiDeps,
  _params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const queryParams = body as Record<string, string> | undefined
  const directoryFilter = queryParams?.directory

  const known = listKnownProjects()
  
  // Always include the current active project from deps.ctx with its current directory.
  // This ensures the TUI can match the active directory even if the opencode DB has a stale entry.
  const activeProject = {
    id: deps.ctx.projectId,
    name: deps.ctx.directory.split('/').pop() ?? deps.ctx.directory,
    directory: deps.ctx.directory,
    active: true,
  }

  // Merge known projects with active project, avoiding duplicates by id.
  // If the active project id exists in known projects, update its directory to the current one.
  const knownProjects = known.map((project) => {
    if (project.id === deps.ctx.projectId) {
      return {
        id: project.id,
        name: activeProject.name,
        directory: activeProject.directory,
        active: true,
      }
    }
    return {
      id: project.id,
      name: project.name,
      directory: project.directory,
      active: false,
    }
  })
  
  // Ensure active project is included even if not in known projects
  const knownIds = new Set(known.map(p => p.id))
  const allProjects = knownIds.has(activeProject.id)
    ? knownProjects
    : [...knownProjects, activeProject]
  
  const projects = allProjects

  if (directoryFilter) {
    const matched = projects.find((project) => project.directory === directoryFilter)
    return { projects: matched ? [matched] : [] }
  }

  return { projects }
}

export async function handleGetProject(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId } = params
  const { directory } = deps.ctx

  return { id: projectId, directory }
}

export async function handleGetGraphStatus(
  _deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  const queryParams = body as Record<string, string> | undefined
  const cwd = queryParams?.cwd ?? undefined
  return { status: readGraphStatus(projectId, undefined, cwd) }
}
