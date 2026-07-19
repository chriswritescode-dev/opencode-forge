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
import type {
  LoopRow,
  SectionPlanRow,
  ReviewFindingRow,
  LoopUsageAggregate,
  LoopEventRow,
  LoopRunRow,
} from '../storage'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'

export interface DashboardLoopSummary {
  loop: LoopRow
  findings: ReviewFindingRow[]
  usage: Pick<LoopUsageAggregate, 'totalCost'> | null
  duration: string | null
}

export interface DashboardLoop extends DashboardLoopSummary {
  usage: LoopUsageAggregate | null
  lastAuditResult: string | null
  postActionReport: string | null
  plan: string | null
  sections: SectionPlanRow[]
  events: LoopEventRow[]
}

export interface DashboardProject {
  projectId: string
  projectDir: string | null
  loops: DashboardLoopSummary[]
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

export interface DashboardRunsPage {
  runs: LoopRunRow[]
  total: number
  offset: number
  limit: number
}

function durationForLoop(loop: LoopRow): string | null {
  const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)
  return elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : null
}

function collectDashboardLoopSummary(
  loop: LoopRow,
  findings: ReviewFindingRow[],
  totalCost: number | null,
): DashboardLoopSummary {
  return {
    loop,
    findings,
    usage: totalCost === null ? null : { totalCost },
    duration: durationForLoop(loop),
  }
}

export function collectDashboardLoopDetail(
  db: Database,
  projectId: string,
  loopName: string,
): DashboardLoop | null {
  const loopsRepo = createLoopsRepo(db)
  const loop = loopsRepo.get(projectId, loopName)
  if (!loop) return null
  const large = loopsRepo.getLarge(projectId, loopName)
  return {
    loop,
    findings: createReviewFindingsRepo(db).listByLoopName(projectId, loopName),
    usage: createLoopSessionUsageRepo(db).getAggregateForRun(projectId, loopName, loop.startedAt),
    duration: durationForLoop(loop),
    lastAuditResult: large?.lastAuditResult ?? null,
    postActionReport: large?.postActionReport ?? null,
    plan: createPlansRepo(db).getForLoop(projectId, loopName)?.content ?? null,
    sections: createSectionPlansRepo(db).list(projectId, loopName),
    events: createLoopEventsRepo(db).listByLoop(projectId, loopName, loop.startedAt),
  }
}

export function collectDashboardRunsPage(
  db: Database,
  options: { projectId?: string; offset: number; limit: number },
): DashboardRunsPage {
  const page = createLoopRunsRepo(db).listPage(options)
  return { runs: page.rows, total: page.total, offset: options.offset, limit: options.limit }
}

export function collectDashboardData(db: Database): DashboardPayload {
  const loopsRepo = createLoopsRepo(db)
  const loopRunsRepo = createLoopRunsRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const loopProjectIds = (db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id',
  ).all() as { project_id: string }[]).map(row => row.project_id)
  const projectIds = Array.from(new Set([...loopProjectIds, ...loopRunsRepo.listProjectIds()])).sort()
  const totals: DashboardTotals = {
    projects: projectIds.length,
    loops: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    errored: 0,
    stalled: 0,
  }

  const projects = projectIds.map(projectId => {
    const loopRows = loopsRepo.listAll(projectId)
    const findingsByLoop = new Map<string, ReviewFindingRow[]>()
    for (const finding of reviewFindingsRepo.listAll(projectId)) {
      if (finding.loopName === null) continue
      const findings = findingsByLoop.get(finding.loopName) ?? []
      findings.push(finding)
      findingsByLoop.set(finding.loopName, findings)
    }
    const usageCosts = new Map(
      (db.prepare(`
        SELECT loop_name, run_started_at, SUM(cost) AS total_cost
        FROM loop_session_usage
        WHERE project_id = ?
        GROUP BY loop_name, run_started_at
      `).all(projectId) as Array<{ loop_name: string; run_started_at: number; total_cost: number }>)
        .map(row => [`${row.loop_name}\u0000${row.run_started_at}`, row.total_cost] as const),
    )
    const sortedLoops = [...loopRows].sort((a, b) => {
      const runningDiff = (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1)
      return runningDiff || b.startedAt - a.startedAt
    })
    totals.loops += sortedLoops.length
    for (const loop of sortedLoops) totals[loop.status]++
    return {
      projectId,
      projectDir: loopRows[0]?.projectDir ?? null,
      loops: sortedLoops.map(loop => collectDashboardLoopSummary(
        loop,
        findingsByLoop.get(loop.loopName) ?? [],
        usageCosts.get(`${loop.loopName}\u0000${loop.startedAt}`) ?? null,
      )),
    }
  })

  return { generatedAt: Date.now(), projects, totals }
}
