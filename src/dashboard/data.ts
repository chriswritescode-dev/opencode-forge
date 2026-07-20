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

/** Check whether *tbl* exists on this database. */
function hasTable(database: Database, tbl: string): boolean {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tbl) as { cnt: number }
  return (row?.cnt ?? 0) > 0
}

interface DashboardRepos {
  loopsRepo: ReturnType<typeof createLoopsRepo>
  plansRepo: ReturnType<typeof createPlansRepo>
  reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo> | null
  amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo> | null
}

// The dashboard poll handler calls collectDashboardData every 5s per open tab;
// cache the prepared repos (and the table probes — the table set cannot change
// after startup) per database handle instead of re-preparing on every request.
const repoCache = new WeakMap<Database, DashboardRepos>()

function reposFor(db: Database): DashboardRepos {
  let repos = repoCache.get(db)
  if (!repos) {
    repos = {
      loopsRepo: createLoopsRepo(db),
      plansRepo: createPlansRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      sectionPlansRepo: createSectionPlansRepo(db),
      loopSessionUsageRepo: createLoopSessionUsageRepo(db),
      // For older databases (pre-migration 142/143), the new tables may not exist.
      // Detect availability so the dashboard serves 200 with empty collections instead of failing.
      loopTransitionsRepo: hasTable(db, 'loop_transitions') ? createLoopTransitionsRepo(db) : null,
      amendmentsRepo: hasTable(db, 'plan_amendments') ? createPlanAmendmentsRepo(db) : null,
    }
    repoCache.set(db, repos)
  }
  return repos
}

/**
 * The dashboard renders only section index+title from amendment snapshots;
 * strip the multi-KB section content before it enters the poll payload. The
 * full snapshots stay in plan_amendments as the audit trail.
 */
function projectAmendmentSections(json: string): string {
  try {
    const rows = JSON.parse(json) as { index: number; title: string }[]
    return JSON.stringify(rows.map((r) => ({ index: r.index, title: r.title })))
  } catch {
    return '[]'
  }
}

export function collectDashboardData(db: Database): DashboardPayload {
  const { loopsRepo, plansRepo, reviewFindingsRepo, sectionPlansRepo, loopSessionUsageRepo, loopTransitionsRepo, amendmentsRepo } = reposFor(db)

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
      const amendments = amendmentsRepo
        ? amendmentsRepo.listForLoop(projectId, loopName).map((a) => ({
            ...a,
            sectionsBefore: projectAmendmentSections(a.sectionsBefore),
            sectionsAfter: projectAmendmentSections(a.sectionsAfter),
          }))
        : []
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
