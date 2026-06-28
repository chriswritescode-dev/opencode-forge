import type { Database } from 'bun:sqlite'
import type { ParsedFeature } from '../../utils/feature-list-parser'

export interface FeatureGroupRow {
  projectId: string
  groupId: string
  title: string
  status: 'extracting' | 'planning' | 'running' | 'completed' | 'cancelled' | 'errored' | 'interrupted'
  prdText: string | null
  maxConcurrent: number
  executionModel: string | null
  auditorModel: string | null
  splitterSessionId: string | null
  hostSessionId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface GroupFeatureRow {
  projectId: string
  groupId: string
  featureIndex: number
  title: string
  description: string
  stage: 'pending' | 'planning' | 'planned' | 'launching' | 'running' | 'completed' | 'failed' | 'cancelled'
  architectSessionId: string | null
  loopName: string | null
  error: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}

export interface CreateGroupInput {
  projectId: string
  groupId: string
  title: string
  status: FeatureGroupRow['status']
  prdText?: string | null
  maxConcurrent?: number
  executionModel?: string | null
  auditorModel?: string | null
  splitterSessionId?: string | null
  hostSessionId?: string | null
  error?: string | null
  createdAt?: number
  updatedAt?: number
  completedAt?: number | null
}

export interface ListGroupsOpts {
  status?: FeatureGroupRow['status']
}

export interface SetGroupStatusOpts {
  error?: string | null
  completedAt?: number | null
}

export interface FeatureGroupsRepo {
  createGroup(input: CreateGroupInput): void
  getGroup(projectId: string, groupId: string): FeatureGroupRow | null
  listGroups(projectId: string, opts?: ListGroupsOpts): FeatureGroupRow[]
  setGroupStatus(projectId: string, groupId: string, status: FeatureGroupRow['status'], opts?: SetGroupStatusOpts): void
  setSplitterSession(projectId: string, groupId: string, sessionId: string): void
  getGroupBySplitterSession(projectId: string, sessionId: string): FeatureGroupRow | null
  insertFeatures(projectId: string, groupId: string, features: ParsedFeature[]): void
  listFeatures(projectId: string, groupId: string): GroupFeatureRow[]
  getFeatureByArchitectSession(projectId: string, sessionId: string): GroupFeatureRow | null
  getFeatureByLoopName(projectId: string, loopName: string): GroupFeatureRow | null
  claimFeatureStage(projectId: string, groupId: string, featureIndex: number, fromStage: string, toStage: string): boolean
  /**
   * Atomically reset all stuck feature stages for a group in a single transaction:
   * `planning → pending` (also clearing the stale architect_session_id) and
   * `launching → planned`. Used by restart to requeue interrupted work.
   */
  resetStuckFeatureStages(projectId: string, groupId: string): void
  /**
   * Atomically mark every non-terminal feature `cancelled` and set the group `cancelled`
   * in a single transaction, so a partially-applied cancel cannot leave the group cancelled
   * while features remain in flight.
   */
  cancelGroupWithFeatures(projectId: string, groupId: string): void
  setFeatureArchitectSession(projectId: string, groupId: string, featureIndex: number, sessionId: string): void
  setFeatureLoopName(projectId: string, groupId: string, featureIndex: number, loopName: string): void
  setFeatureError(projectId: string, groupId: string, featureIndex: number, error: string, stage: string): void
  markInterrupted(projectId: string): number
  incrementFeatureAttempts(projectId: string, groupId: string, featureIndex: number): void
}

function mapGroupRow(row: FeatureGroupRowRaw): FeatureGroupRow {
  return {
    projectId: row.project_id,
    groupId: row.group_id,
    title: row.title,
    status: row.status as FeatureGroupRow['status'],
    prdText: row.prd_text,
    maxConcurrent: row.max_concurrent,
    executionModel: row.execution_model,
    auditorModel: row.auditor_model,
    splitterSessionId: row.splitter_session_id,
    hostSessionId: row.host_session_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

interface FeatureGroupRowRaw {
  project_id: string
  group_id: string
  title: string
  status: string
  prd_text: string | null
  max_concurrent: number
  execution_model: string | null
  auditor_model: string | null
  splitter_session_id: string | null
  host_session_id: string | null
  error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

function mapFeatureRow(row: GroupFeatureRowRaw): GroupFeatureRow {
  return {
    projectId: row.project_id,
    groupId: row.group_id,
    featureIndex: row.feature_index,
    title: row.title,
    description: row.description,
    stage: row.stage as GroupFeatureRow['stage'],
    architectSessionId: row.architect_session_id,
    loopName: row.loop_name,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface GroupFeatureRowRaw {
  project_id: string
  group_id: string
  feature_index: number
  title: string
  description: string
  stage: string
  architect_session_id: string | null
  loop_name: string | null
  error: string | null
  attempts: number
  created_at: number
  updated_at: number
}

export function createFeatureGroupsRepo(db: Database): FeatureGroupsRepo {
  const createGroupStmt = db.prepare(`
    INSERT INTO feature_groups (
      project_id, group_id, title, status, prd_text, max_concurrent,
      execution_model, auditor_model, splitter_session_id, host_session_id,
      error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const getGroupStmt = db.prepare(`
    SELECT project_id, group_id, title, status, prd_text, max_concurrent,
           execution_model, auditor_model, splitter_session_id, host_session_id,
           error, created_at, updated_at, completed_at
    FROM feature_groups
    WHERE project_id = ? AND group_id = ?
  `)

  const listGroupsStmt = db.prepare(`
    SELECT project_id, group_id, title, status, prd_text, max_concurrent,
           execution_model, auditor_model, splitter_session_id, host_session_id,
           error, created_at, updated_at, completed_at
    FROM feature_groups
    WHERE project_id = ? AND status = ?
    ORDER BY created_at DESC
  `)

  const listAllGroupsStmt = db.prepare(`
    SELECT project_id, group_id, title, status, prd_text, max_concurrent,
           execution_model, auditor_model, splitter_session_id, host_session_id,
           error, created_at, updated_at, completed_at
    FROM feature_groups
    WHERE project_id = ?
    ORDER BY created_at DESC
  `)

  const setGroupStatusStmt = db.prepare(`
    UPDATE feature_groups SET status = ?, error = ?, completed_at = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ?
  `)

  const setSplitterSessionStmt = db.prepare(`
    UPDATE feature_groups SET splitter_session_id = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ?
  `)

  const getGroupBySplitterSessionStmt = db.prepare(`
    SELECT project_id, group_id, title, status, prd_text, max_concurrent,
           execution_model, auditor_model, splitter_session_id, host_session_id,
           error, created_at, updated_at, completed_at
    FROM feature_groups
    WHERE project_id = ? AND splitter_session_id = ?
  `)

  const insertFeatureStmt = db.prepare(`
    INSERT INTO group_features (
      project_id, group_id, feature_index, title, description, stage,
      architect_session_id, loop_name, error, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const listFeaturesStmt = db.prepare(`
    SELECT project_id, group_id, feature_index, title, description, stage,
           architect_session_id, loop_name, error, attempts, created_at, updated_at
    FROM group_features
    WHERE project_id = ? AND group_id = ?
    ORDER BY feature_index ASC
  `)

  const getFeatureByArchitectSessionStmt = db.prepare(`
    SELECT project_id, group_id, feature_index, title, description, stage,
           architect_session_id, loop_name, error, attempts, created_at, updated_at
    FROM group_features
    WHERE project_id = ? AND architect_session_id = ?
  `)

  const getFeatureByLoopNameStmt = db.prepare(`
    SELECT project_id, group_id, feature_index, title, description, stage,
           architect_session_id, loop_name, error, attempts, created_at, updated_at
    FROM group_features
    WHERE project_id = ? AND loop_name = ?
  `)

  const claimFeatureStageStmt = db.prepare(`
    UPDATE group_features SET stage = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND feature_index = ? AND stage = ?
  `)

  const resetPlanningFeaturesStmt = db.prepare(`
    UPDATE group_features SET stage = 'pending', architect_session_id = NULL, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND stage = 'planning'
  `)

  const resetLaunchingFeaturesStmt = db.prepare(`
    UPDATE group_features SET stage = 'planned', updated_at = ?
    WHERE project_id = ? AND group_id = ? AND stage = 'launching'
  `)

  const cancelNonTerminalFeaturesStmt = db.prepare(`
    UPDATE group_features SET stage = 'cancelled', updated_at = ?
    WHERE project_id = ? AND group_id = ? AND stage NOT IN ('completed','failed','cancelled')
  `)

  const setFeatureArchitectSessionStmt = db.prepare(`
    UPDATE group_features SET architect_session_id = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND feature_index = ?
  `)

  const setFeatureLoopNameStmt = db.prepare(`
    UPDATE group_features SET loop_name = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND feature_index = ?
  `)

  const setFeatureErrorStmt = db.prepare(`
    UPDATE group_features SET error = ?, stage = ?, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND feature_index = ?
  `)

  const markInterruptedStmt = db.prepare(`
    UPDATE feature_groups SET status = 'interrupted', updated_at = ?
    WHERE project_id = ? AND status IN ('extracting','planning','running')
  `)

  const incrementFeatureAttemptsStmt = db.prepare(`
    UPDATE group_features SET attempts = attempts + 1, updated_at = ?
    WHERE project_id = ? AND group_id = ? AND feature_index = ?
  `)

  const now = () => Date.now()

  return {
    createGroup(input: CreateGroupInput): void {
      const ts = input.createdAt ?? now()
      createGroupStmt.run(
        input.projectId, input.groupId, input.title, input.status,
        input.prdText ?? null, input.maxConcurrent ?? 3,
        input.executionModel ?? null, input.auditorModel ?? null,
        input.splitterSessionId ?? null, input.hostSessionId ?? null,
        input.error ?? null, ts, input.updatedAt ?? ts,
        input.completedAt ?? null,
      )
    },

    getGroup(projectId: string, groupId: string): FeatureGroupRow | null {
      const row = getGroupStmt.get(projectId, groupId) as FeatureGroupRowRaw | null
      return row ? mapGroupRow(row) : null
    },

    listGroups(projectId: string, opts?: ListGroupsOpts): FeatureGroupRow[] {
      if (opts?.status) {
        return (listGroupsStmt.all(projectId, opts.status) as FeatureGroupRowRaw[]).map(mapGroupRow)
      }
      return (listAllGroupsStmt.all(projectId) as FeatureGroupRowRaw[]).map(mapGroupRow)
    },

    setGroupStatus(projectId: string, groupId: string, status: FeatureGroupRow['status'], opts?: SetGroupStatusOpts): void {
      const ts = now()
      setGroupStatusStmt.run(
        status,
        opts?.error ?? null,
        opts?.completedAt ?? null,
        ts,
        projectId,
        groupId,
      )
    },

    setSplitterSession(projectId: string, groupId: string, sessionId: string): void {
      setSplitterSessionStmt.run(sessionId, now(), projectId, groupId)
    },

    getGroupBySplitterSession(projectId: string, sessionId: string): FeatureGroupRow | null {
      const row = getGroupBySplitterSessionStmt.get(projectId, sessionId) as FeatureGroupRowRaw | null
      return row ? mapGroupRow(row) : null
    },

    insertFeatures(projectId: string, groupId: string, features: ParsedFeature[]): void {
      const runTxn = db.transaction(() => {
        const ts = now()
        for (let i = 0; i < features.length; i++) {
          insertFeatureStmt.run(
            projectId, groupId, i, features[i].title, features[i].description,
            'pending', null, null, null, 0, ts, ts,
          )
        }
      })
      runTxn()
    },

    listFeatures(projectId: string, groupId: string): GroupFeatureRow[] {
      return (listFeaturesStmt.all(projectId, groupId) as GroupFeatureRowRaw[]).map(mapFeatureRow)
    },

    getFeatureByArchitectSession(projectId: string, sessionId: string): GroupFeatureRow | null {
      const row = getFeatureByArchitectSessionStmt.get(projectId, sessionId) as GroupFeatureRowRaw | null
      return row ? mapFeatureRow(row) : null
    },

    getFeatureByLoopName(projectId: string, loopName: string): GroupFeatureRow | null {
      const row = getFeatureByLoopNameStmt.get(projectId, loopName) as GroupFeatureRowRaw | null
      return row ? mapFeatureRow(row) : null
    },

    claimFeatureStage(projectId: string, groupId: string, featureIndex: number, fromStage: string, toStage: string): boolean {
      const result = claimFeatureStageStmt.run(toStage, now(), projectId, groupId, featureIndex, fromStage) as unknown as { changes: number }
      return result.changes === 1
    },

    resetStuckFeatureStages(projectId: string, groupId: string): void {
      const runTxn = db.transaction(() => {
        const ts = now()
        resetPlanningFeaturesStmt.run(ts, projectId, groupId)
        resetLaunchingFeaturesStmt.run(ts, projectId, groupId)
      })
      runTxn()
    },

    cancelGroupWithFeatures(projectId: string, groupId: string): void {
      const runTxn = db.transaction(() => {
        const ts = now()
        cancelNonTerminalFeaturesStmt.run(ts, projectId, groupId)
        setGroupStatusStmt.run('cancelled', null, null, ts, projectId, groupId)
      })
      runTxn()
    },

    setFeatureArchitectSession(projectId: string, groupId: string, featureIndex: number, sessionId: string): void {
      setFeatureArchitectSessionStmt.run(sessionId, now(), projectId, groupId, featureIndex)
    },

    setFeatureLoopName(projectId: string, groupId: string, featureIndex: number, loopName: string): void {
      setFeatureLoopNameStmt.run(loopName, now(), projectId, groupId, featureIndex)
    },

    setFeatureError(projectId: string, groupId: string, featureIndex: number, error: string, stage: string): void {
      setFeatureErrorStmt.run(error, stage, now(), projectId, groupId, featureIndex)
    },

    markInterrupted(projectId: string): number {
      const result = markInterruptedStmt.run(now(), projectId) as unknown as { changes: number }
      return result.changes
    },

    incrementFeatureAttempts(projectId: string, groupId: string, featureIndex: number): void {
      incrementFeatureAttemptsStmt.run(now(), projectId, groupId, featureIndex)
    },
  }
}
