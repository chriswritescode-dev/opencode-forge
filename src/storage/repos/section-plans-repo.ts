import type { Database } from 'bun:sqlite'
import type { Logger } from '../../types'
import type { ParsedSection } from '../../utils/section-capture'

export interface SectionPlanRow {
  projectId: string
  loopName: string
  sectionIndex: number
  title: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  attempts: number
  summaryDone: string | null
  summaryDeviations: string | null
  summaryFollowUps: string | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

export interface SectionPlansRepo {
  bulkInsert(args: { projectId: string; loopName: string; sections: ParsedSection[] }): { inserted: number }
  list(projectId: string, loopName: string): SectionPlanRow[]
  listCompleted(projectId: string, loopName: string): SectionPlanRow[]
  get(projectId: string, loopName: string, index: number): SectionPlanRow | null
  getNextIncomplete(projectId: string, loopName: string): SectionPlanRow | null
  setStatus(projectId: string, loopName: string, index: number, status: SectionPlanRow['status']): void
  incrementAttempts(projectId: string, loopName: string, index: number): void
  setSummary(projectId: string, loopName: string, index: number, parts: { done?: string; deviations?: string; followUps?: string }): void
  resetForRewind(projectId: string, loopName: string, index: number): void
  setStartedAt(projectId: string, loopName: string, index: number, ms: number): void
  setCompletedAt(projectId: string, loopName: string, index: number, ms: number): void
  updateContent(projectId: string, loopName: string, sections: ParsedSection[]): { updated: number }
  count(projectId: string, loopName: string): number
  restoreAll(rows: SectionPlanRow[]): void
}

export function createSectionPlansRepo(db: Database, _logger?: Logger): SectionPlansRepo {
  const stmtBulkInsert = db.prepare(`
    INSERT OR IGNORE INTO section_plans (project_id, loop_name, section_index, title, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const stmtList = db.prepare(`
    SELECT project_id, loop_name, section_index, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ?
    ORDER BY section_index ASC
  `)

  const stmtListCompleted = db.prepare(`
    SELECT project_id, loop_name, section_index, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND status = 'completed'
    ORDER BY section_index ASC
  `)

  const stmtGet = db.prepare(`
    SELECT project_id, loop_name, section_index, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtGetNextIncomplete = db.prepare(`
    SELECT project_id, loop_name, section_index, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND status != 'completed'
    ORDER BY section_index ASC
    LIMIT 1
  `)

  const stmtSetStatus = db.prepare(`
    UPDATE section_plans SET status = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtIncrementAttempts = db.prepare(`
    UPDATE section_plans SET attempts = attempts + 1 WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetSummary = db.prepare(`
    UPDATE section_plans SET summary_done = ?, summary_deviations = ?, summary_follow_ups = ?
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtResetForRewind = db.prepare(`
    UPDATE section_plans SET status = 'in_progress', attempts = 0, summary_done = NULL,
    summary_deviations = NULL, summary_follow_ups = NULL, completed_at = NULL
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetStartedAt = db.prepare(`
    UPDATE section_plans SET started_at = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetCompletedAt = db.prepare(`
    UPDATE section_plans SET completed_at = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtUpdateContent = db.prepare(`
    UPDATE section_plans SET title = ?, content = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtCount = db.prepare(`
    SELECT COUNT(*) as count FROM section_plans WHERE project_id = ? AND loop_name = ?
  `)

  function mapRow(row: Record<string, unknown>): SectionPlanRow {
    return {
      projectId: row.project_id as string,
      loopName: row.loop_name as string,
      sectionIndex: row.section_index as number,
      title: row.title as string,
      content: row.content as string,
      status: row.status as SectionPlanRow['status'],
      attempts: row.attempts as number,
      summaryDone: row.summary_done as string | null,
      summaryDeviations: row.summary_deviations as string | null,
      summaryFollowUps: row.summary_follow_ups as string | null,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
      createdAt: row.created_at as number,
    }
  }

  return {
    bulkInsert(args) {
      let inserted = 0
      const now = Date.now()
      for (const section of args.sections) {
        const result = stmtBulkInsert.run(args.projectId, args.loopName, section.index, section.title, section.content, now) as unknown as { changes: number }
        if (result.changes > 0) inserted++
      }
      return { inserted }
    },

    updateContent(projectId, loopName, sections) {
      let updated = 0
      for (const section of sections) {
        const result = stmtUpdateContent.run(section.title, section.content, projectId, loopName, section.index) as unknown as { changes: number }
        if (result.changes > 0) updated++
      }
      return { updated }
    },

    list(projectId, loopName) {
      const rows = stmtList.all(projectId, loopName) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },

    listCompleted(projectId, loopName) {
      const rows = stmtListCompleted.all(projectId, loopName) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },

    get(projectId, loopName, index) {
      const row = stmtGet.get(projectId, loopName, index) as Record<string, unknown> | null
      return row ? mapRow(row) : null
    },

    getNextIncomplete(projectId, loopName) {
      const row = stmtGetNextIncomplete.get(projectId, loopName) as Record<string, unknown> | null
      return row ? mapRow(row) : null
    },

    setStatus(projectId, loopName, index, status) {
      stmtSetStatus.run(status, projectId, loopName, index)
    },

    incrementAttempts(projectId, loopName, index) {
      stmtIncrementAttempts.run(projectId, loopName, index)
    },

    setSummary(projectId, loopName, index, parts) {
      const row = stmtGet.get(projectId, loopName, index) as Record<string, unknown> | null
      if (!row) return
      stmtSetSummary.run(
        parts.done ?? row.summary_done,
        parts.deviations ?? row.summary_deviations,
        parts.followUps ?? row.summary_follow_ups,
        projectId, loopName, index
      )
    },

    resetForRewind(projectId, loopName, index) {
      stmtResetForRewind.run(projectId, loopName, index)
    },

    setStartedAt(projectId, loopName, index, ms) {
      stmtSetStartedAt.run(ms, projectId, loopName, index)
    },

    setCompletedAt(projectId, loopName, index, ms) {
      stmtSetCompletedAt.run(ms, projectId, loopName, index)
    },

    count(projectId, loopName) {
      const result = stmtCount.get(projectId, loopName) as { count: number }
      return result.count
    },

    restoreAll(rows: SectionPlanRow[]): void {
      const stmtRestore = db.prepare(`
        INSERT INTO section_plans (project_id, loop_name, section_index, title, content, status, attempts,
          summary_done, summary_deviations, summary_follow_ups, started_at, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const row of rows) {
        stmtRestore.run(
          row.projectId, row.loopName, row.sectionIndex, row.title, row.content,
          row.status, row.attempts, row.summaryDone, row.summaryDeviations,
          row.summaryFollowUps, row.startedAt, row.completedAt, row.createdAt,
        )
      }
    },
  }
}
