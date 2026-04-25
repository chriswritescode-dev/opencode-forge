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

export function listKnownProjects(): Array<{ id: string; name: string | null }> {
  const result =
    withOpencodeProjectDb((db) => {
      const rows = db.prepare('SELECT id, worktree FROM project').all() as Array<{
        id: string
        worktree: string
      }>
      return rows.map((row) => ({
        id: row.id,
        name: basename(row.worktree),
      }))
    }) ?? []
  return result
}

export async function handleListProjects(
  _req: Request,
  deps: ApiDeps
): Promise<Response> {
  const knownProject = listKnownProjects().find((project) => project.id === deps.ctx.projectId)
  const projects = [knownProject ?? { id: deps.ctx.projectId, name: basename(deps.ctx.directory) }]
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
