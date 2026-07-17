import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  createLoopSessionUsageRepo,
  createLoopEventsRepo,
  createLoopRunsRepo,
} from '../storage'
import type { LoopRow } from '../storage'
import type { SectionPlanRow } from '../storage'
import type { ReviewFindingRow } from '../storage'
import type { LoopUsageAggregate } from '../storage'
import type { LoopEventRow } from '../storage'
import type { LoopRunRow } from '../storage'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'

export interface DashboardLoop {
  loop: LoopRow
  lastAuditResult: string | null
  postActionReport: string | null
  plan: string | null
  sections: SectionPlanRow[]
  findings: ReviewFindingRow[]
  usage: LoopUsageAggregate | null
  duration: string | null
  events: LoopEventRow[]
}

export interface DashboardProject {
  projectId: string
  projectDir: string | null
  loops: DashboardLoop[]
  runs: LoopRunRow[]
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
  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
  const loopEventsRepo = createLoopEventsRepo(db)
  const loopRunsRepo = createLoopRunsRepo(db)

  const loopProjectIdRows = db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id'
  ).all() as { project_id: string }[]
  const runsProjectIds = loopRunsRepo.listProjectIds()

  const projectIds = Array.from(
    new Set<string>([
      ...loopProjectIdRows.map(r => r.project_id),
      ...runsProjectIds,
    ]),
  ).sort()

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

    // Determine projectDir from first (most recent) loop row; null when no live loops remain.
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
      const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)
      const duration = elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : null
      const events = loopEventsRepo.listByLoop(projectId, loopName, loop.startedAt)

      return { loop, lastAuditResult, postActionReport, plan, sections, findings, usage, duration, events }
    })

    const runs = loopRunsRepo.listByProject(projectId)

    projects.push({ projectId, projectDir, loops: dashboardLoops, runs })

    // Accumulate totals; swept-only projects contribute runs but no loop status counts.
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
