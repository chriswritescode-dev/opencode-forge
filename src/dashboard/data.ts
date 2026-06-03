import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  createLoopSessionUsageRepo,
} from '../storage'
import type { LoopRow } from '../storage'
import type { SectionPlanRow } from '../storage'
import type { ReviewFindingRow } from '../storage'
import type { LoopUsageAggregate } from '../storage'

export interface DashboardLoop {
  loop: LoopRow
  lastAuditResult: string | null
  plan: string | null
  sections: SectionPlanRow[]
  findings: ReviewFindingRow[]
  usage: LoopUsageAggregate | null
}

export interface DashboardProject {
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
  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopSessionUsageRepo = createLoopSessionUsageRepo(db)

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
      const lastAuditResult = loopsRepo.getLarge(projectId, loopName)?.lastAuditResult ?? null
      const plan = plansRepo.getForLoop(projectId, loopName)?.content ?? null
      const sections = sectionPlansRepo.list(projectId, loopName)
      const findings = reviewFindingsRepo.listByLoopName(projectId, loopName)
      const usage = loopSessionUsageRepo.getAggregate(projectId, loopName)

      return { loop, lastAuditResult, plan, sections, findings, usage }
    })

    projects.push({ projectId, projectDir, loops: dashboardLoops })

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
