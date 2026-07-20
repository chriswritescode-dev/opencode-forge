import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  createLoopSessionUsageRepo,
  createLoopTransitionsRepo,
  createPlanAmendmentsRepo,
} from '../storage'
import type { LoopRow } from '../storage'
import type { SectionPlanRow } from '../storage'
import type { ReviewFindingRow } from '../storage'
import type { LoopUsageAggregate } from '../storage'
import type { LoopTransitionRow } from '../storage'
import type { PlanAmendmentRow } from '../storage'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'

export type { LoopRow, LoopTransitionRow }

export interface DashboardLoop {
  /** Stable identity for keyed store reconciliation (unique within a project's loop set). */
  id: string
  loop: LoopRow
  lastAuditResult: string | null
  postActionReport: string | null
  plan: string | null
  sections: SectionPlanRow[]
  findings: ReviewFindingRow[]
  usage: LoopUsageAggregate | null
  duration: string | null
  transitions: LoopTransitionRow[]
  amendments: PlanAmendmentRow[]
}

export interface DashboardProject {
  /** Stable identity for keyed store reconciliation; equals `projectId`. */
  id: string
  projectId: string
  projectDir: string | null
  loops: DashboardLoop[]
}

export interface DashboardTotals {
  projects: number
  loops: number
  running: number
  completed: number
  cancelled: number
  errored: number
  stalled: number
}

export interface DashboardPayload {
  generatedAt: number
  projects: DashboardProject[]
  totals: DashboardTotals
}

export function collectDashboardData(db: Database): DashboardPayload {
  // For older databases (pre-migration 139/140), the new tables may not exist.
  // Detect availability so the dashboard serves 200 with empty collections instead of failing.
  const hasTransitionsTable = hasTable(db, 'loop_transitions')
  const hasAmendmentsTable = hasTable(db, 'plan_amendments')

  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
  const loopTransitionsRepo = hasTransitionsTable ? createLoopTransitionsRepo(db) : null
  const amendmentsRepo = hasAmendmentsTable ? createPlanAmendmentsRepo(db) : null

  /** Check whether *tbl* exists on this database. */
  function hasTable(database: Database, tbl: string): boolean {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tbl) as { cnt: number }
    return (row?.cnt ?? 0) > 0
  }

  const projectIdRows = db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id'
  ).all() as { project_id: string }[]

  const projectIds = projectIdRows.map(r => r.project_id)
  const projects: DashboardProject[] = []
  const totals: DashboardTotals = {
    projects: 0,
    loops: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    errored: 0,
    stalled: 0,
  }

  for (const projectId of projectIds) {
    const loopRows = loopsRepo.listAll(projectId)

    // Determine projectDir from first (most recent) loop row
    const projectDir = loopRows.length > 0 ? loopRows[0].projectDir : null

    // Sort: running first, then by startedAt desc within each group
    const sortedLoops = [...loopRows].sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      const runningDiff = aRunning - bRunning
      if (runningDiff !== 0) return runningDiff
      return b.startedAt - a.startedAt
    })

    const dashboardLoops: DashboardLoop[] = sortedLoops.map(loop => {
      const loopName = loop.loopName
      const large = loopsRepo.getLarge(projectId, loopName)
      const lastAuditResult = large?.lastAuditResult ?? null
      const postActionReport = large?.postActionReport ?? null
      const plan = plansRepo.getForLoop(projectId, loopName)?.content ?? null
      const sections = sectionPlansRepo.list(projectId, loopName)
      const findings = reviewFindingsRepo.listByLoopName(projectId, loopName)
      const usage = loopSessionUsageRepo.getAggregate(projectId, loopName)
      const transitions = loopTransitionsRepo ? loopTransitionsRepo.listForLoop(projectId, loopName, 100) : []
      const amendments = amendmentsRepo ? amendmentsRepo.listForLoop(projectId, loopName) : []
      const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)
      const duration = elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : null

      return { id: loopName, loop, lastAuditResult, postActionReport, plan, sections, findings, usage, duration, transitions, amendments }
    })

    projects.push({ id: projectId, projectId, projectDir, loops: dashboardLoops })

    // Accumulate totals
    totals.projects = projectIds.length
    totals.loops += sortedLoops.length
    for (const loop of sortedLoops) {
      totals[loop.status]++
    }
  }

  return {
    generatedAt: Date.now(),
    projects,
    totals,
  }
}
