import type { Database } from 'bun:sqlite'
import type { Logger, LoopSandboxSettings } from '../../types'
import { GOAL_ACTIVE_CHUNK_STAGES } from '../../utils/goal-chunks'
import { parseSandboxSettings, serializeSandboxSettings } from './loops-repo'

export type GoalStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled'

export type GoalChunkStage = 'planning' | 'launching' | 'running' | 'completed' | 'cancelled'

/** One entry of a goal's ordered task list, typically a ticket reference. */
export interface GoalTask {
  ref?: string
  title: string
  details?: string
}

export interface GoalRow {
  projectId: string
  goalId: string
  title: string
  objective: string
  tasks: GoalTask[]
  hostSessionId: string
  projectDir: string | null
  status: GoalStatus
  maxChunks: number
  executionModel: string | null
  auditorModel: string | null
  executionVariant: string | null
  auditorVariant: string | null
  sandboxSettings: LoopSandboxSettings | null
  maxIterations: number | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface GoalChunkRow {
  projectId: string
  goalId: string
  chunkIndex: number
  stage: GoalChunkStage
  title: string | null
  plannerSessionId: string | null
  planningDir: string | null
  baseCommit: string | null
  loopName: string | null
  branch: string | null
  summary: string | null
  createdAt: number
  updatedAt: number
}

/** Launch settings snapshotted from the first chunk and reused by every later chunk. */
export interface GoalLaunchSnapshot {
  projectDir: string
  executionModel: string | null
  auditorModel: string | null
  executionVariant: string | null
  auditorVariant: string | null
  sandboxSettings: LoopSandboxSettings | null
  maxIterations: number | null
}

export interface SaveGoalDraftInput {
  projectId: string
  goalId: string
  title: string
  objective: string
  tasks: GoalTask[]
  hostSessionId: string
  maxChunks: number
}

export interface FirstChunkInput {
  loopName: string
  branch: string | null
  title: string | null
  baseCommit: string | null
}

export interface GoalStatusUpdateOptions {
  error?: string | null
  completedAt?: number | null
}

export interface CancelGoalResult {
  cancelled: boolean
  runningLoopNames: string[]
  planningChunks: GoalChunkRow[]
}

export interface GoalsRepo {
  saveDraft(input: SaveGoalDraftInput): GoalRow
  getGoal(projectId: string, goalId: string): GoalRow | null
  listGoals(projectId: string): GoalRow[]
  getActiveForSession(projectId: string, hostSessionId: string): GoalRow | null
  attachFirstChunk(
    projectId: string,
    hostSessionId: string,
    snapshot: GoalLaunchSnapshot,
    chunk: FirstChunkInput,
  ): GoalRow | null
  updateStatus(
    projectId: string,
    goalId: string,
    from: GoalStatus[],
    to: GoalStatus,
    opts?: GoalStatusUpdateOptions,
  ): boolean
  setMaxChunks(projectId: string, goalId: string, maxChunks: number): boolean
  listChunks(projectId: string, goalId: string): GoalChunkRow[]
  listChunksByProject(projectId: string): Map<string, GoalChunkRow[]>
  getChunkByLoopName(projectId: string, loopName: string): GoalChunkRow | null
  getChunkByPlannerSession(projectId: string, sessionId: string): GoalChunkRow | null
  isChunkLoopName(projectId: string, loopName: string): boolean
  insertPlanningChunk(
    projectId: string,
    goalId: string,
    chunkIndex: number,
    input: { planningDir: string; baseCommit: string },
  ): boolean
  setChunkPlanner(projectId: string, goalId: string, chunkIndex: number, plannerSessionId: string): boolean
  claimChunkStage(
    projectId: string,
    goalId: string,
    chunkIndex: number,
    from: GoalChunkStage,
    to: GoalChunkStage,
  ): boolean
  markChunkRunning(
    projectId: string,
    goalId: string,
    chunkIndex: number,
    input: { loopName: string; branch: string | null; title: string | null },
  ): boolean
  completeChunk(projectId: string, goalId: string, chunkIndex: number, summary: string | null): boolean
  deleteChunk(projectId: string, goalId: string, chunkIndex: number): boolean
  cancelGoal(projectId: string, goalId: string): CancelGoalResult
}

interface GoalRowRaw {
  project_id: string
  goal_id: string
  title: string
  objective: string
  tasks: string
  host_session_id: string
  project_dir: string | null
  status: string
  max_chunks: number
  execution_model: string | null
  auditor_model: string | null
  execution_variant: string | null
  auditor_variant: string | null
  sandbox_settings: string | null
  max_iterations: number | null
  error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface GoalChunkRowRaw {
  project_id: string
  goal_id: string
  chunk_index: number
  stage: string
  title: string | null
  planner_session_id: string | null
  planning_dir: string | null
  base_commit: string | null
  loop_name: string | null
  branch: string | null
  summary: string | null
  created_at: number
  updated_at: number
}

const GOAL_COLUMNS = `project_id, goal_id, title, objective, tasks, host_session_id, project_dir,
  status, max_chunks, execution_model, auditor_model, execution_variant, auditor_variant,
  sandbox_settings, max_iterations, error, created_at, updated_at, completed_at`

const CHUNK_COLUMNS = `project_id, goal_id, chunk_index, stage, title, planner_session_id,
  planning_dir, base_commit, loop_name, branch, summary, created_at, updated_at`

const GOAL_ACTIVE_STAGE_SQL = GOAL_ACTIVE_CHUNK_STAGES.map((stage) => `'${stage}'`).join(', ')

/** Reads a persisted tasks JSON column; malformed content hydrates as an empty list. */
function parseTasks(value: string): GoalTask[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    const tasks: GoalTask[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (typeof record.title !== 'string') continue
      tasks.push({
        title: record.title,
        ...(typeof record.ref === 'string' ? { ref: record.ref } : {}),
        ...(typeof record.details === 'string' ? { details: record.details } : {}),
      })
    }
    return tasks
  } catch {
    return []
  }
}

function mapGoalRow(raw: GoalRowRaw): GoalRow {
  return {
    projectId: raw.project_id,
    goalId: raw.goal_id,
    title: raw.title,
    objective: raw.objective,
    tasks: parseTasks(raw.tasks),
    hostSessionId: raw.host_session_id,
    projectDir: raw.project_dir,
    status: raw.status as GoalStatus,
    maxChunks: raw.max_chunks,
    executionModel: raw.execution_model,
    auditorModel: raw.auditor_model,
    executionVariant: raw.execution_variant,
    auditorVariant: raw.auditor_variant,
    sandboxSettings: parseSandboxSettings(raw.sandbox_settings),
    maxIterations: raw.max_iterations,
    error: raw.error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    completedAt: raw.completed_at,
  }
}

function mapChunkRow(raw: GoalChunkRowRaw): GoalChunkRow {
  return {
    projectId: raw.project_id,
    goalId: raw.goal_id,
    chunkIndex: raw.chunk_index,
    stage: raw.stage as GoalChunkStage,
    title: raw.title,
    plannerSessionId: raw.planner_session_id,
    planningDir: raw.planning_dir,
    baseCommit: raw.base_commit,
    loopName: raw.loop_name,
    branch: raw.branch,
    summary: raw.summary,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export function createGoalsRepo(db: Database, _logger?: Logger): GoalsRepo {
  const deleteDraftStmt = db.prepare(`
    DELETE FROM goals
    WHERE project_id = ? AND host_session_id = ? AND status = 'draft'
  `)

  const insertGoalStmt = db.prepare(`
    INSERT INTO goals (${GOAL_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const getGoalStmt = db.prepare(`
    SELECT ${GOAL_COLUMNS}
    FROM goals
    WHERE project_id = ? AND goal_id = ?
  `)

  const listGoalsStmt = db.prepare(`
    SELECT ${GOAL_COLUMNS}
    FROM goals
    WHERE project_id = ?
    ORDER BY created_at DESC, goal_id DESC
  `)

  const getDraftForSessionStmt = db.prepare(`
    SELECT ${GOAL_COLUMNS}
    FROM goals
    WHERE project_id = ? AND host_session_id = ? AND status = 'draft'
    ORDER BY created_at DESC, goal_id DESC
    LIMIT 1
  `)

  const getActiveForSessionStmt = db.prepare(`
    SELECT ${GOAL_COLUMNS}
    FROM goals
    WHERE project_id = ? AND host_session_id = ? AND status IN ('running', 'paused')
    ORDER BY updated_at DESC, created_at DESC, goal_id DESC
    LIMIT 1
  `)

  const startGoalStmt = db.prepare(`
    UPDATE goals SET
      status = 'running',
      project_dir = ?,
      execution_model = ?,
      auditor_model = ?,
      execution_variant = ?,
      auditor_variant = ?,
      sandbox_settings = ?,
      max_iterations = ?,
      error = NULL,
      updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND status = 'draft'
  `)

  const insertChunkStmt = db.prepare(`
    INSERT INTO goal_chunks (${CHUNK_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const setMaxChunksStmt = db.prepare(`
    UPDATE goals SET max_chunks = ?, updated_at = ?
    WHERE project_id = ? AND goal_id = ?
  `)

  const listChunksStmt = db.prepare(`
    SELECT ${CHUNK_COLUMNS}
    FROM goal_chunks
    WHERE project_id = ? AND goal_id = ?
    ORDER BY chunk_index ASC
  `)

  const listChunksByProjectStmt = db.prepare(`
    SELECT ${CHUNK_COLUMNS}
    FROM goal_chunks
    WHERE project_id = ?
    ORDER BY goal_id ASC, chunk_index ASC
  `)

  const getChunkByLoopNameStmt = db.prepare(`
    SELECT ${CHUNK_COLUMNS}
    FROM goal_chunks
    WHERE project_id = ? AND loop_name = ?
  `)

  const isChunkLoopNameStmt = db.prepare(`
    SELECT 1 AS found
    FROM goal_chunks
    WHERE project_id = ? AND loop_name = ?
    LIMIT 1
  `)

  const getChunkByPlannerSessionStmt = db.prepare(`
    SELECT ${CHUNK_COLUMNS}
    FROM goal_chunks
    WHERE project_id = ? AND planner_session_id = ?
  `)

  const insertPlanningChunkStmt = db.prepare(`
    INSERT OR IGNORE INTO goal_chunks (
      project_id, goal_id, chunk_index, stage, title, planner_session_id,
      planning_dir, base_commit, loop_name, branch, summary, created_at, updated_at
    )
    VALUES (?, ?, ?, 'planning', NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)
  `)

  const setChunkPlannerStmt = db.prepare(`
    UPDATE goal_chunks SET planner_session_id = ?, updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND chunk_index = ? AND stage = 'planning'
  `)

  const claimChunkStageStmt = db.prepare(`
    UPDATE goal_chunks SET stage = ?, updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND chunk_index = ? AND stage = ?
  `)

  const markChunkRunningStmt = db.prepare(`
    UPDATE goal_chunks SET
      stage = 'running',
      loop_name = ?,
      branch = ?,
      title = ?,
      updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND chunk_index = ? AND stage = 'launching'
  `)

  const completeChunkStmt = db.prepare(`
    UPDATE goal_chunks SET stage = 'completed', summary = ?, updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND chunk_index = ? AND stage = 'running'
  `)

  const deleteChunkStmt = db.prepare(`
    DELETE FROM goal_chunks
    WHERE project_id = ? AND goal_id = ? AND chunk_index = ?
  `)

  const cancelGoalStmt = db.prepare(`
    UPDATE goals SET status = 'cancelled', completed_at = ?, updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND status IN ('draft', 'running', 'paused')
  `)

  const listPlanningChunksStmt = db.prepare(`
    SELECT ${CHUNK_COLUMNS}
    FROM goal_chunks
    WHERE project_id = ? AND goal_id = ? AND stage IN ('planning', 'launching')
    ORDER BY chunk_index ASC
  `)

  const listRunningChunksStmt = db.prepare(`
    SELECT loop_name
    FROM goal_chunks
    WHERE project_id = ? AND goal_id = ? AND stage = 'running' AND loop_name IS NOT NULL
    ORDER BY chunk_index ASC
  `)

  const cancelChunksStmt = db.prepare(`
    UPDATE goal_chunks SET stage = 'cancelled', updated_at = ?
    WHERE project_id = ? AND goal_id = ? AND stage IN (${GOAL_ACTIVE_STAGE_SQL})
  `)

  function getGoal(projectId: string, goalId: string): GoalRow | null {
    const row = getGoalStmt.get(projectId, goalId) as GoalRowRaw | null
    return row ? mapGoalRow(row) : null
  }

  function saveDraft(input: SaveGoalDraftInput): GoalRow {
    const now = Date.now()
    const runSave = db.transaction(() => {
      deleteDraftStmt.run(input.projectId, input.hostSessionId)
      insertGoalStmt.run(
        input.projectId,
        input.goalId,
        input.title,
        input.objective,
        JSON.stringify(input.tasks ?? []),
        input.hostSessionId,
        null,
        'draft',
        input.maxChunks,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        now,
        now,
        null,
      )
      return getGoal(input.projectId, input.goalId) as GoalRow
    })
    return runSave()
  }

  function attachFirstChunk(
    projectId: string,
    hostSessionId: string,
    snapshot: GoalLaunchSnapshot,
    chunk: FirstChunkInput,
  ): GoalRow | null {
    const runAttach = db.transaction(() => {
      const draftRow = getDraftForSessionStmt.get(projectId, hostSessionId) as GoalRowRaw | null
      if (!draftRow) return null

      const now = Date.now()
      const started = startGoalStmt.run(
        snapshot.projectDir,
        snapshot.executionModel,
        snapshot.auditorModel,
        snapshot.executionVariant,
        snapshot.auditorVariant,
        serializeSandboxSettings(snapshot.sandboxSettings),
        snapshot.maxIterations,
        now,
        projectId,
        draftRow.goal_id,
      ) as unknown as { changes: number }
      if (started.changes === 0) return null

      insertChunkStmt.run(
        projectId,
        draftRow.goal_id,
        0,
        'running',
        chunk.title,
        null,
        null,
        chunk.baseCommit,
        chunk.loopName,
        chunk.branch,
        null,
        now,
        now,
      )

      return getGoal(projectId, draftRow.goal_id)
    })
    return runAttach()
  }

  function updateStatus(
    projectId: string,
    goalId: string,
    from: GoalStatus[],
    to: GoalStatus,
    opts?: GoalStatusUpdateOptions,
  ): boolean {
    if (from.length === 0) return false
    const placeholders = from.map(() => '?').join(', ')
    const stmt = db.prepare(`
      UPDATE goals SET
        status = ?,
        updated_at = ?,
        error = CASE WHEN ? = 1 THEN ? ELSE error END,
        completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
      WHERE project_id = ? AND goal_id = ? AND status IN (${placeholders})
    `)
    const setsError = opts && 'error' in opts ? 1 : 0
    const setsCompletedAt = opts && 'completedAt' in opts ? 1 : 0
    const result = stmt.run(
      to,
      Date.now(),
      setsError,
      opts?.error ?? null,
      setsCompletedAt,
      opts?.completedAt ?? null,
      projectId,
      goalId,
      ...from,
    ) as unknown as { changes: number }
    return result.changes > 0
  }

  function cancelGoal(projectId: string, goalId: string): CancelGoalResult {
    const runCancel = db.transaction(() => {
      const now = Date.now()
      const result = cancelGoalStmt.run(now, now, projectId, goalId) as unknown as { changes: number }
      if (result.changes === 0) {
        return { cancelled: false, runningLoopNames: [], planningChunks: [] }
      }
      const planningChunks = (listPlanningChunksStmt.all(projectId, goalId) as GoalChunkRowRaw[]).map(mapChunkRow)
      const runningLoopNames = (listRunningChunksStmt.all(projectId, goalId) as Array<{ loop_name: string }>).map(
        (row) => row.loop_name,
      )
      cancelChunksStmt.run(now, projectId, goalId)
      return { cancelled: true, runningLoopNames, planningChunks }
    })
    return runCancel()
  }

  return {
    saveDraft,

    getGoal,

    listGoals(projectId: string): GoalRow[] {
      const rows = listGoalsStmt.all(projectId) as GoalRowRaw[]
      return rows.map(mapGoalRow)
    },

    getActiveForSession(projectId: string, hostSessionId: string): GoalRow | null {
      const row = getActiveForSessionStmt.get(projectId, hostSessionId) as GoalRowRaw | null
      return row ? mapGoalRow(row) : null
    },

    attachFirstChunk,

    updateStatus,

    setMaxChunks(projectId: string, goalId: string, maxChunks: number): boolean {
      const result = setMaxChunksStmt.run(maxChunks, Date.now(), projectId, goalId) as unknown as { changes: number }
      return result.changes > 0
    },

    listChunks(projectId: string, goalId: string): GoalChunkRow[] {
      const rows = listChunksStmt.all(projectId, goalId) as GoalChunkRowRaw[]
      return rows.map(mapChunkRow)
    },

    listChunksByProject(projectId: string): Map<string, GoalChunkRow[]> {
      const rows = listChunksByProjectStmt.all(projectId) as GoalChunkRowRaw[]
      const byGoal = new Map<string, GoalChunkRow[]>()
      for (const row of rows) {
        const chunk = mapChunkRow(row)
        const bucket = byGoal.get(chunk.goalId)
        if (bucket) bucket.push(chunk)
        else byGoal.set(chunk.goalId, [chunk])
      }
      return byGoal
    },

    getChunkByLoopName(projectId: string, loopName: string): GoalChunkRow | null {
      const row = getChunkByLoopNameStmt.get(projectId, loopName) as GoalChunkRowRaw | null
      return row ? mapChunkRow(row) : null
    },

    isChunkLoopName(projectId: string, loopName: string): boolean {
      return Boolean(isChunkLoopNameStmt.get(projectId, loopName))
    },

    getChunkByPlannerSession(projectId: string, sessionId: string): GoalChunkRow | null {
      const row = getChunkByPlannerSessionStmt.get(projectId, sessionId) as GoalChunkRowRaw | null
      return row ? mapChunkRow(row) : null
    },

    insertPlanningChunk(
      projectId: string,
      goalId: string,
      chunkIndex: number,
      input: { planningDir: string; baseCommit: string },
    ): boolean {
      const now = Date.now()
      const result = insertPlanningChunkStmt.run(
        projectId,
        goalId,
        chunkIndex,
        input.planningDir,
        input.baseCommit,
        now,
        now,
      ) as unknown as { changes: number }
      return result.changes > 0
    },

    setChunkPlanner(projectId: string, goalId: string, chunkIndex: number, plannerSessionId: string): boolean {
      const result = setChunkPlannerStmt.run(
        plannerSessionId,
        Date.now(),
        projectId,
        goalId,
        chunkIndex,
      ) as unknown as { changes: number }
      return result.changes > 0
    },

    claimChunkStage(
      projectId: string,
      goalId: string,
      chunkIndex: number,
      from: GoalChunkStage,
      to: GoalChunkStage,
    ): boolean {
      const result = claimChunkStageStmt.run(
        to,
        Date.now(),
        projectId,
        goalId,
        chunkIndex,
        from,
      ) as unknown as { changes: number }
      return result.changes > 0
    },

    markChunkRunning(
      projectId: string,
      goalId: string,
      chunkIndex: number,
      input: { loopName: string; branch: string | null; title: string | null },
    ): boolean {
      const result = markChunkRunningStmt.run(
        input.loopName,
        input.branch,
        input.title,
        Date.now(),
        projectId,
        goalId,
        chunkIndex,
      ) as unknown as { changes: number }
      return result.changes > 0
    },

    completeChunk(projectId: string, goalId: string, chunkIndex: number, summary: string | null): boolean {
      const result = completeChunkStmt.run(
        summary,
        Date.now(),
        projectId,
        goalId,
        chunkIndex,
      ) as unknown as { changes: number }
      return result.changes > 0
    },

    deleteChunk(projectId: string, goalId: string, chunkIndex: number): boolean {
      const result = deleteChunkStmt.run(projectId, goalId, chunkIndex) as unknown as { changes: number }
      return result.changes > 0
    },

    cancelGoal,
  }
}
