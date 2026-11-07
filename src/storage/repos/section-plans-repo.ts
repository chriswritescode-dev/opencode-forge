import type { Database } from 'bun:sqlite'
import type { Logger } from '../../types'
import type { ParsedSection } from '../../utils/section-capture'
import type { PlanSection } from '../../services/deterministic-decomposer'
import { generatedSectionId } from '../../loop/section-graph'
import { runImmediateTransaction } from '../sqlite-open'

export interface SectionPlanRow {
  projectId: string
  loopName: string
  sectionIndex: number
  sectionId: string
  dependsOn: string[]
  title: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  attempts: number
  summaryDone: string | null
  summaryDeviations: string | null
  summaryFollowUps: string | null
  codeGraph: string | null
  /** Commit sha of the section's checkpoint commit; section audits scope from it. */
  checkpointCommit: string | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

export interface SectionPlansRepo {
  bulkInsert(args: { projectId: string; loopName: string; sections: PlanSection[] }): { inserted: number }
  list(projectId: string, loopName: string): SectionPlanRow[]
  listCompleted(projectId: string, loopName: string): SectionPlanRow[]
  get(projectId: string, loopName: string, index: number): SectionPlanRow | null
  setStatus(projectId: string, loopName: string, index: number, status: SectionPlanRow['status']): void
  incrementAttempts(projectId: string, loopName: string, index: number): void
  setSummary(projectId: string, loopName: string, index: number, parts: { done?: string; deviations?: string; followUps?: string }): void
  setCodeGraph(projectId: string, loopName: string, index: number, text: string | null): void
  setCheckpointCommit(projectId: string, loopName: string, index: number, sha: string): void
  resetForRewind(projectId: string, loopName: string, index: number): void
  setStartedAt(projectId: string, loopName: string, index: number, ms: number): void
  setCompletedAt(projectId: string, loopName: string, index: number, ms: number): void
  updateContent(projectId: string, loopName: string, sections: ParsedSection[]): { updated: number }
  count(projectId: string, loopName: string): number
  /** Section-plan row count per loop for this project, in one scan. */
  countsByLoop(projectId: string): Map<string, number>
  deleteAll(projectId: string, loopName: string): number
  restoreAll(rows: SectionPlanRow[]): void
  /**
   * Run `fn` inside a single database transaction on the shared `db` that every
   * repo in this composition root is constructed with, acquiring a write lock
   * up front via `BEGIN IMMEDIATE`. Used to make cross-repo writes (section
   * replacement, loop-row update, amendment insert) atomic when `fn` reads
   * authoritative loop row state and writes against it, so a concurrent writer
   * (e.g. a section advance bumping `current_section_index`) cannot commit
   * between the read and the write inside `fn`. Nested `db.transaction` calls
   * inside `fn` become savepoints that roll back with the outer transaction
   * when `fn` throws.
   */
  immediateTransaction<T>(fn: () => T): T
  replacePendingSections(args: {
    projectId: string
    loopName: string
    fromIndex: number
    sections: { title: string; content: string; id: string; after: string[] }[]
  }): { ok: true; removed: number; inserted: number } | { ok: false; error: string }
}

export function createSectionPlansRepo(db: Database, _logger?: Logger): SectionPlansRepo {
  const stmtBulkInsert = db.prepare(`
    INSERT OR IGNORE INTO section_plans (project_id, loop_name, section_index, title, content, section_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const stmtInsertDependency = db.prepare(`
    INSERT OR IGNORE INTO section_dependencies (project_id, loop_name, section_id, depends_on_section_id)
    VALUES (?, ?, ?, ?)
  `)

  const stmtListDependencies = db.prepare(`
    SELECT d.section_id AS section_id, d.depends_on_section_id AS depends_on_section_id
    FROM section_dependencies d
    LEFT JOIN section_plans p
      ON p.project_id = d.project_id AND p.loop_name = d.loop_name AND p.section_id = d.depends_on_section_id
    WHERE d.project_id = ? AND d.loop_name = ?
    ORDER BY d.section_id ASC, p.section_index ASC, d.depends_on_section_id ASC
  `)

  const stmtList = db.prepare(`
    SELECT project_id, loop_name, section_index, section_id, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           code_graph, checkpoint_commit, started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ?
    ORDER BY section_index ASC
  `)

  const stmtListCompleted = db.prepare(`
    SELECT project_id, loop_name, section_index, section_id, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           code_graph, checkpoint_commit, started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND status = 'completed'
    ORDER BY section_index ASC
  `)

  const stmtGet = db.prepare(`
    SELECT project_id, loop_name, section_index, section_id, title, content, status, attempts,
           summary_done, summary_deviations, summary_follow_ups,
           code_graph, checkpoint_commit, started_at, completed_at, created_at
    FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
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
    summary_deviations = NULL, summary_follow_ups = NULL, code_graph = NULL, checkpoint_commit = NULL,
    completed_at = NULL
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetStartedAt = db.prepare(`
    UPDATE section_plans SET started_at = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetCompletedAt = db.prepare(`
    UPDATE section_plans SET completed_at = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtUpdateContent = db.prepare(`
    UPDATE section_plans
    SET code_graph = CASE WHEN content = ? THEN code_graph ELSE NULL END, title = ?, content = ?
    WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetCodeGraph = db.prepare(`
    UPDATE section_plans SET code_graph = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtSetCheckpointCommit = db.prepare(`
    UPDATE section_plans SET checkpoint_commit = ? WHERE project_id = ? AND loop_name = ? AND section_index = ?
  `)

  const stmtCount = db.prepare(`
    SELECT COUNT(*) as count FROM section_plans WHERE project_id = ? AND loop_name = ?
  `)

  const stmtCountsByLoop = db.prepare(`
    SELECT loop_name, COUNT(*) AS cnt
    FROM section_plans
    WHERE project_id = ?
    GROUP BY loop_name
  `)

  const stmtDeleteAll = db.prepare('DELETE FROM section_plans WHERE project_id = ? AND loop_name = ?')

  const stmtDeleteDependencies = db.prepare('DELETE FROM section_dependencies WHERE project_id = ? AND loop_name = ?')

  const stmtListForReplace = db.prepare(`
    SELECT section_index, status FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND section_index >= ?
    ORDER BY section_index ASC
  `)

  const stmtDeletePendingEdges = db.prepare(`
    DELETE FROM section_dependencies
    WHERE project_id = ? AND loop_name = ?
      AND section_id IN (
        SELECT section_id FROM section_plans
        WHERE project_id = ? AND loop_name = ? AND section_index >= ? AND status = 'pending'
      )
  `)

  const stmtDeletePendingFrom = db.prepare(`
    DELETE FROM section_plans
    WHERE project_id = ? AND loop_name = ? AND section_index >= ? AND status = 'pending'
  `)

  const stmtInsertReplacement = db.prepare(`
    INSERT INTO section_plans (project_id, loop_name, section_index, section_id, title, content, status, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `)

  function dependenciesBySection(projectId: string, loopName: string): Map<string, string[]> {
    const rows = stmtListDependencies.all(projectId, loopName) as Array<{
      section_id: string
      depends_on_section_id: string
    }>
    const bySection = new Map<string, string[]>()
    for (const row of rows) {
      const dependencies = bySection.get(row.section_id) ?? []
      dependencies.push(row.depends_on_section_id)
      bySection.set(row.section_id, dependencies)
    }
    return bySection
  }

  function mapRow(row: Record<string, unknown>, dependsOn: string[]): SectionPlanRow {
    return {
      projectId: row.project_id as string,
      loopName: row.loop_name as string,
      sectionIndex: row.section_index as number,
      sectionId: row.section_id as string,
      dependsOn,
      title: row.title as string,
      content: row.content as string,
      status: row.status as SectionPlanRow['status'],
      attempts: row.attempts as number,
      summaryDone: row.summary_done as string | null,
      summaryDeviations: row.summary_deviations as string | null,
      summaryFollowUps: row.summary_follow_ups as string | null,
      codeGraph: row.code_graph as string | null,
      checkpointCommit: row.checkpoint_commit as string | null,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
      createdAt: row.created_at as number,
    }
  }

  return {
    bulkInsert(args) {
      const run = db.transaction(() => {
        let inserted = 0
        const now = Date.now()
        for (const section of args.sections) {
          const id = section.id ?? generatedSectionId(section.index)
          const after = section.after ?? []
          const result = stmtBulkInsert.run(
            args.projectId, args.loopName, section.index, section.title, section.content, id, now,
          ) as unknown as { changes: number }
          if (result.changes === 0) continue
          inserted++
          for (const dependency of after) {
            stmtInsertDependency.run(args.projectId, args.loopName, id, dependency)
          }
        }
        return { inserted }
      })
      return run()
    },

    updateContent(projectId, loopName, sections) {
      let updated = 0
      for (const section of sections) {
        const result = stmtUpdateContent.run(
          section.content, section.title, section.content,
          projectId, loopName, section.index,
        ) as unknown as { changes: number }
        if (result.changes > 0) updated++
      }
      return { updated }
    },

    list(projectId, loopName) {
      const rows = stmtList.all(projectId, loopName) as Array<Record<string, unknown>>
      const dependencies = dependenciesBySection(projectId, loopName)
      return rows.map((row) => mapRow(row, dependencies.get(row.section_id as string) ?? []))
    },

    listCompleted(projectId, loopName) {
      const rows = stmtListCompleted.all(projectId, loopName) as Array<Record<string, unknown>>
      const dependencies = dependenciesBySection(projectId, loopName)
      return rows.map((row) => mapRow(row, dependencies.get(row.section_id as string) ?? []))
    },

    get(projectId, loopName, index) {
      const row = stmtGet.get(projectId, loopName, index) as Record<string, unknown> | null
      if (!row) return null
      const dependencies = dependenciesBySection(projectId, loopName)
      return mapRow(row, dependencies.get(row.section_id as string) ?? [])
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

    setCodeGraph(projectId, loopName, index, text) {
      stmtSetCodeGraph.run(text, projectId, loopName, index)
    },

    setCheckpointCommit(projectId, loopName, index, sha) {
      stmtSetCheckpointCommit.run(sha, projectId, loopName, index)
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

    countsByLoop(projectId) {
      const rows = stmtCountsByLoop.all(projectId) as { loop_name: string; cnt: number }[]
      return new Map(rows.map(r => [r.loop_name, r.cnt]))
    },

    deleteAll(projectId, loopName) {
      const run = db.transaction(() => {
        stmtDeleteDependencies.run(projectId, loopName)
        const result = stmtDeleteAll.run(projectId, loopName) as unknown as { changes: number }
        return result.changes
      })
      return run()
    },

    restoreAll(rows: SectionPlanRow[]): void {
      const stmtRestore = db.prepare(`
        INSERT OR REPLACE INTO section_plans (project_id, loop_name, section_index, section_id, title, content, status, attempts,
          summary_done, summary_deviations, summary_follow_ups, code_graph, checkpoint_commit, started_at, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const run = db.transaction(() => {
        for (const row of rows) {
          stmtRestore.run(
            row.projectId, row.loopName, row.sectionIndex, row.sectionId, row.title, row.content,
            row.status, row.attempts, row.summaryDone, row.summaryDeviations,
            row.summaryFollowUps, row.codeGraph, row.checkpointCommit, row.startedAt, row.completedAt, row.createdAt,
          )
          for (const dependency of row.dependsOn) {
            stmtInsertDependency.run(row.projectId, row.loopName, row.sectionId, dependency)
          }
        }
      })
      run()
    },

    immediateTransaction<T>(fn: () => T): T {
      return runImmediateTransaction(db, fn)
    },

    replacePendingSections(args) {
      const run = db.transaction(() => {
        const existing = stmtListForReplace.all(args.projectId, args.loopName, args.fromIndex) as Array<{ section_index: number; status: string }>
        // No existing rows at or beyond fromIndex is valid: it means the
        // auditor is appending new work after the current final section.
        // Only non-pending rows in the suffix block the operation.
        for (const row of existing) {
          if (row.status !== 'pending') {
            return { ok: false as const, error: `section ${row.section_index} is not pending (status=${row.status})` }
          }
        }
        stmtDeletePendingEdges.run(args.projectId, args.loopName, args.projectId, args.loopName, args.fromIndex)
        const deleteResult = stmtDeletePendingFrom.run(args.projectId, args.loopName, args.fromIndex) as unknown as { changes: number }
        const removed = deleteResult.changes
        const now = Date.now()
        let inserted = 0
        for (let i = 0; i < args.sections.length; i++) {
          const section = args.sections[i]
          const sectionIndex = args.fromIndex + i
          const id = section.id ?? generatedSectionId(sectionIndex)
          const after = section.after ?? []
          stmtInsertReplacement.run(
            args.projectId, args.loopName, sectionIndex, id, section.title, section.content, now,
          )
          for (const dependency of after) {
            stmtInsertDependency.run(args.projectId, args.loopName, id, dependency)
          }
          inserted++
        }
        return { ok: true as const, removed, inserted }
      })
      return run()
    },
  }
}
