import type { Database } from 'bun:sqlite'

export interface ApiCoordinatorRow {
  host: string
  port: number
  url: string
  instanceId: string
  pid: number
  startedAt: number
  heartbeatAt: number
  expiresAt: number
}

export interface ApiProjectInstanceRow {
  instanceId: string
  projectId: string
  directory: string
  ownerUrl: string
  pid: number
  startedAt: number
  heartbeatAt: number
  expiresAt: number
}

export interface UpsertCoordinatorInput {
  host: string
  port: number
  url: string
  instanceId: string
  pid: number
  now: number
  ttlMs: number
}

export interface UpsertProjectInstanceInput {
  instanceId: string
  projectId: string
  directory: string
  ownerUrl: string
  pid: number
  now: number
  ttlMs: number
}

export interface ApiRegistryRepo {
  upsertCoordinator(input: UpsertCoordinatorInput): void
  getCoordinator(host: string, port: number): ApiCoordinatorRow | null
  touchCoordinator(instanceId: string, now: number, ttlMs: number): void
  deleteCoordinator(instanceId: string): void

  upsertProjectInstance(input: UpsertProjectInstanceInput): void
  touchProjectInstance(instanceId: string, now: number, ttlMs: number): void
  deleteProjectInstance(instanceId: string): void
  getProjectInstanceByProject(projectId: string): ApiProjectInstanceRow | null
  getProjectInstanceByDirectory(directory: string): ApiProjectInstanceRow | null
  listProjectInstances(): ApiProjectInstanceRow[]
  pruneExpired(now: number): number
}

interface ApiCoordinatorRowRaw {
  host: string
  port: number
  url: string
  instance_id: string
  pid: number
  started_at: number
  heartbeat_at: number
  expires_at: number
}

interface ApiProjectInstanceRowRaw {
  instance_id: string
  project_id: string
  directory: string
  owner_url: string
  pid: number
  started_at: number
  heartbeat_at: number
  expires_at: number
}

function mapCoordinatorRow(row: ApiCoordinatorRowRaw): ApiCoordinatorRow {
  return {
    host: row.host,
    port: row.port,
    url: row.url,
    instanceId: row.instance_id,
    pid: row.pid,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  }
}

function mapProjectInstanceRow(row: ApiProjectInstanceRowRaw): ApiProjectInstanceRow {
  return {
    instanceId: row.instance_id,
    projectId: row.project_id,
    directory: row.directory,
    ownerUrl: row.owner_url,
    pid: row.pid,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  }
}

export function createApiRegistryRepo(db: Database): ApiRegistryRepo {
  const upsertCoordinatorStmt = db.prepare(`
    INSERT INTO api_coordinators (host, port, url, instance_id, pid, started_at, heartbeat_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, port) DO UPDATE SET
      instance_id = excluded.instance_id,
      pid = excluded.pid,
      started_at = excluded.started_at,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at
  `)

  const getCoordinatorStmt = db.prepare(`
    SELECT host, port, url, instance_id, pid, started_at, heartbeat_at, expires_at
    FROM api_coordinators
    WHERE host = ? AND port = ?
  `)

  const touchCoordinatorStmt = db.prepare(`
    UPDATE api_coordinators
    SET heartbeat_at = ?, expires_at = ?
    WHERE instance_id = ?
  `)

  const deleteCoordinatorStmt = db.prepare(`
    DELETE FROM api_coordinators
    WHERE instance_id = ?
  `)

  const upsertProjectInstanceStmt = db.prepare(`
    INSERT INTO api_project_instances (instance_id, project_id, directory, owner_url, pid, started_at, heartbeat_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (instance_id) DO UPDATE SET
      project_id = excluded.project_id,
      directory = excluded.directory,
      owner_url = excluded.owner_url,
      pid = excluded.pid,
      started_at = excluded.started_at,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at
  `)

  const touchProjectInstanceStmt = db.prepare(`
    UPDATE api_project_instances
    SET heartbeat_at = ?, expires_at = ?
    WHERE instance_id = ?
  `)

  const deleteProjectInstanceStmt = db.prepare(`
    DELETE FROM api_project_instances
    WHERE instance_id = ?
  `)

  const getProjectInstanceByProjectStmt = db.prepare(`
    SELECT instance_id, project_id, directory, owner_url, pid, started_at, heartbeat_at, expires_at
    FROM api_project_instances
    WHERE project_id = ?
    ORDER BY heartbeat_at DESC
    LIMIT 1
  `)

  const getProjectInstanceByDirectoryStmt = db.prepare(`
    SELECT instance_id, project_id, directory, owner_url, pid, started_at, heartbeat_at, expires_at
    FROM api_project_instances
    WHERE directory = ?
    ORDER BY heartbeat_at DESC
    LIMIT 1
  `)

  const listProjectInstancesStmt = db.prepare(`
    SELECT instance_id, project_id, directory, owner_url, pid, started_at, heartbeat_at, expires_at
    FROM api_project_instances
  `)

  const pruneExpiredCoordinatorStmt = db.prepare(`
    DELETE FROM api_coordinators
    WHERE expires_at < ?
  `)

  const pruneExpiredProjectInstancesStmt = db.prepare(`
    DELETE FROM api_project_instances
    WHERE expires_at < ?
  `)

  return {
    upsertCoordinator(input: UpsertCoordinatorInput): void {
      const expiresAt = input.now + input.ttlMs
      upsertCoordinatorStmt.run(
        input.host,
        input.port,
        input.url,
        input.instanceId,
        input.pid,
        input.now,
        input.now,
        expiresAt
      )
    },

    getCoordinator(host: string, port: number): ApiCoordinatorRow | null {
      const row = getCoordinatorStmt.get(host, port) as ApiCoordinatorRowRaw | null
      return row ? mapCoordinatorRow(row) : null
    },

    touchCoordinator(instanceId: string, now: number, ttlMs: number): void {
      touchCoordinatorStmt.run(now, now + ttlMs, instanceId)
    },

    deleteCoordinator(instanceId: string): void {
      deleteCoordinatorStmt.run(instanceId)
    },

    upsertProjectInstance(input: UpsertProjectInstanceInput): void {
      const expiresAt = input.now + input.ttlMs
      upsertProjectInstanceStmt.run(
        input.instanceId,
        input.projectId,
        input.directory,
        input.ownerUrl,
        input.pid,
        input.now,
        input.now,
        expiresAt
      )
    },

    touchProjectInstance(instanceId: string, now: number, ttlMs: number): void {
      touchProjectInstanceStmt.run(now, now + ttlMs, instanceId)
    },

    deleteProjectInstance(instanceId: string): void {
      deleteProjectInstanceStmt.run(instanceId)
    },

    getProjectInstanceByProject(projectId: string): ApiProjectInstanceRow | null {
      const row = getProjectInstanceByProjectStmt.get(projectId) as ApiProjectInstanceRowRaw | null
      return row ? mapProjectInstanceRow(row) : null
    },

    getProjectInstanceByDirectory(directory: string): ApiProjectInstanceRow | null {
      const row = getProjectInstanceByDirectoryStmt.get(directory) as ApiProjectInstanceRowRaw | null
      return row ? mapProjectInstanceRow(row) : null
    },

    listProjectInstances(): ApiProjectInstanceRow[] {
      const rows = listProjectInstancesStmt.all() as ApiProjectInstanceRowRaw[]
      return rows.map(mapProjectInstanceRow)
    },

    pruneExpired(now: number): number {
      const result1 = pruneExpiredCoordinatorStmt.run(now)
      const result2 = pruneExpiredProjectInstancesStmt.run(now)
      return (result1.changes || 0) + (result2.changes || 0)
    },
  }
}
