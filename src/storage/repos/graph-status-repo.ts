import type { Database } from 'bun:sqlite'

export interface GraphStatusRow {
  projectId: string
  cwd: string
  state: 'unavailable' | 'initializing' | 'indexing' | 'ready' | 'error'
  ready: boolean
  stats: { files: number; symbols: number; edges: number; calls: number } | null
  message: string | null
  updatedAt: number
}

export interface GraphStatusRepo {
  write(row: Omit<GraphStatusRow, 'updatedAt'>): void
  read(projectId: string, cwd: string): GraphStatusRow | null
}

export function createGraphStatusRepo(db: Database): GraphStatusRepo {
  const stmtWrite = db.prepare(`
    INSERT INTO graph_status (project_id, cwd, state, ready, stats_json, message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, cwd) DO UPDATE SET
      state = excluded.state,
      ready = excluded.ready,
      stats_json = excluded.stats_json,
      message = excluded.message,
      updated_at = excluded.updated_at
  `)

  const stmtRead = db.prepare(`
    SELECT project_id, cwd, state, ready, stats_json, message, updated_at
    FROM graph_status
    WHERE project_id = ? AND cwd = ?
  `)

  function write(row: Omit<GraphStatusRow, 'updatedAt'>): void {
    const statsJson = row.stats ? JSON.stringify(row.stats) : null
    stmtWrite.run(
      row.projectId,
      row.cwd,
      row.state,
      row.ready ? 1 : 0,
      statsJson,
      row.message,
      Date.now()
    )
  }

  function read(projectId: string, cwd: string): GraphStatusRow | null {
    const row = stmtRead.get(projectId, cwd) as
      | { project_id: string; cwd: string; state: string; ready: number; stats_json: string | null; message: string | null; updated_at: number }
      | undefined
    if (!row) return null
    return {
      projectId: row.project_id,
      cwd: row.cwd,
      state: row.state as GraphStatusRow['state'],
      ready: row.ready === 1,
      stats: row.stats_json ? JSON.parse(row.stats_json) : null,
      message: row.message,
      updatedAt: row.updated_at,
    }
  }

  return {
    write,
    read,
  }
}
