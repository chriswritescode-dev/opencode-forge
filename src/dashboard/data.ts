import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  createLoopSessionUsageRepo,
  createLoopTransitionsRepo,
  createPlanAmendmentsRepo,
  createGoalsRepo,
  hasTable,
} from '../storage'
import type { LoopRow } from '../storage'
import type { SectionPlanRow } from '../storage'
import type { ReviewFindingRow } from '../storage'
import type { LoopUsageAggregate } from '../storage'
import type { LoopTransitionRow } from '../storage'
import type { PlanAmendmentRow } from '../storage'
import type { GoalStatus, GoalChunkStage } from '../storage'
import { summarizeAmendmentSnapshots, type AmendmentChangeSummary } from './amendment-diff'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'
import { extractPlanTitle } from '../utils/plan-execution'

/** Newest transitions shipped per loop; the dashboard's "100-row fetch window". */
const DASHBOARD_TRANSITIONS_WINDOW = 100

/** Character cap on goal objective and chunk summary previews shipped to the client. */
const GOAL_PREVIEW_MAX = 400

export type { LoopRow, LoopTransitionRow }

export type DashboardAmendment = Omit<PlanAmendmentRow, 'sectionsBefore' | 'sectionsAfter'> & { summary: AmendmentChangeSummary }

export interface DashboardLoop {
  /** Stable identity for keyed store reconciliation (unique within a project's loop set). */
  id: string
  loop: LoopRow
  lastAuditResult: string | null
  postActionReport: string | null
  plan: string | null
  /** Whether a plan row exists. Always populated; `plan` content ships only for the scoped loop. */
  hasPlan: boolean
  sections: SectionPlanRow[]
  /** Number of section-plan rows. Always populated; `sections` rows ship only for the scoped loop. */
  sectionCount: number
  /** Full findings rows; ship only for the scoped project. */
  findings: ReviewFindingRow[]
  /** Number of bug-severity findings. Always populated; `findings` rows ship only for the scoped project. */
  bugCount: number
  /** Token/cost aggregate; ships only for the scoped project. */
  usage: LoopUsageAggregate | null
  duration: string | null
  transitions: LoopTransitionRow[]
  /** Whether `transitions` filled the fetch window, so older rows may be missing. */
  transitionsCapped: boolean
  /**
   * Per-amendment change counts. The multi-KB section snapshots stay in
   * `plan_amendments` and are fetched on demand via the diff endpoint.
   */
  amendments: DashboardAmendment[]
}

/** One entry of a goal's ordered task list, typically a ticket reference. */
export interface DashboardGoalTask {
  ref?: string
  title: string
}

export interface DashboardGoalChunk {
  chunkIndex: number
  stage: GoalChunkStage
  title: string | null
  loopName: string | null
  branch: string | null
  summaryPreview: string | null
}

/**
 * A goal executed as sequential plan-loop chunks. The objective and each chunk
 * summary ship as capped previews; the full text stays in the goals tables.
 */
export interface DashboardGoal {
  /** Stable identity for keyed store reconciliation; equals `goalId`. */
  id: string
  goalId: string
  title: string
  objectivePreview: string
  status: GoalStatus
  error: string | null
  maxChunks: number
  tasks: DashboardGoalTask[]
  executionModel: string | null
  auditorModel: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  chunks: DashboardGoalChunk[]
}

export interface DashboardProject {
  /** Stable identity for keyed store reconciliation; equals `projectId`. */
  id: string
  projectId: string
  projectDir: string | null
  loops: DashboardLoop[]
  goals: DashboardGoal[]
  /**
   * Session-scoped plans no loop has executed, newest first. Content itself is
   * not shipped — only the derived title and size — because a project can retain
   * many of them; the full plan is fetched on demand from `/api/plan`. Rows ship
   * for the scoped project, and for a project with no loops whenever the payload
   * is unscoped: such a project has no repo-menu entry, so the repo index lists
   * its plans in the unofficial-projects section instead.
   */
  unexecutedPlans: DashboardUnexecutedPlan[]
  /** Number of unexecuted session-scoped plans. Always populated. */
  unexecutedPlanCount: number
}

export interface DashboardUnexecutedPlan {
  /** Stable identity for keyed store reconciliation; equals `sessionId`. */
  id: string
  projectId: string
  sessionId: string
  /** Plan title from the stored content, via the shared plan-title extractor. */
  title: string
  updatedAt: number
  /** Plan length in characters, so a row can show size without the body. */
  charCount: number
}

export interface DashboardPayload {
  generatedAt: number
  projects: DashboardProject[]
}

/**
 * The client's current view. Large per-loop text is only materialised for the
 * scoped loop, and per-loop transitions only for the scoped project, because
 * nothing else renders them. Both fields null means the repo-index view, which
 * reads none of the scoped fields.
 */
export interface DashboardScope {
  projectId: string | null
  loopName: string | null
}

const UNSCOPED: DashboardScope = { projectId: null, loopName: null }

interface DashboardRepos {
  loopsRepo: ReturnType<typeof createLoopsRepo>
  plansRepo: ReturnType<typeof createPlansRepo>
  reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo> | null
  amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo> | null
  goalsRepo: ReturnType<typeof createGoalsRepo> | null
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
      goalsRepo: hasTable(db, 'goals') ? createGoalsRepo(db) : null,
    }
    repoCache.set(db, repos)
  }
  return repos
}

/**
 * Goals for one project, newest first, with capped text previews. Returns an
 * empty list when the goals table is absent (older databases). `projectDir` is
 * the newest goal's persisted directory, null for a goal that has not launched
 * its first chunk.
 */
function collectProjectGoals(
  goalsRepo: ReturnType<typeof createGoalsRepo> | null,
  projectId: string,
): { goals: DashboardGoal[]; projectDir: string | null } {
  if (!goalsRepo) return { goals: [], projectDir: null }
  const repo = goalsRepo
  const rows = repo.listGoals(projectId)
  const projectDir = rows.find(row => row.projectDir)?.projectDir ?? null
  const goals = rows.map(row => ({
    id: row.goalId,
    goalId: row.goalId,
    title: row.title,
    objectivePreview: row.objective.slice(0, GOAL_PREVIEW_MAX),
    status: row.status,
    error: row.error,
    maxChunks: row.maxChunks,
    tasks: row.tasks.map(task => ({ ...(task.ref ? { ref: task.ref } : {}), title: task.title })),
    executionModel: row.executionModel,
    auditorModel: row.auditorModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    chunks: repo.listChunks(projectId, row.goalId).map(chunk => ({
      chunkIndex: chunk.chunkIndex,
      stage: chunk.stage,
      title: chunk.title,
      loopName: chunk.loopName,
      branch: chunk.branch,
      summaryPreview: chunk.summary ? chunk.summary.slice(0, GOAL_PREVIEW_MAX) : null,
    })),
  }))
  return { goals, projectDir }
}

/**
 * Dashboard payload for every discovered project. Projects are discovered from
 * the union of loop projects, goal projects, and projects with unexecuted
 * plans, so a project that only holds a goal or an unexecuted plan still
 * appears.
 */
export function collectDashboardData(db: Database, scope: DashboardScope = UNSCOPED): DashboardPayload {
  const { loopsRepo, plansRepo, reviewFindingsRepo, sectionPlansRepo, loopSessionUsageRepo, loopTransitionsRepo, amendmentsRepo, goalsRepo } = reposFor(db)

  const loopProjectIds = db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id'
  ).all() as { project_id: string }[]

  const goalProjectIds = goalsRepo
    ? (db.prepare(
        'SELECT DISTINCT project_id FROM goals ORDER BY project_id'
      ).all() as { project_id: string }[])
    : []

  const unexecutedCounts = plansRepo.unexecutedCountsByProject()

  const projectIds = Array.from(
    new Set([
      ...loopProjectIds.map(r => r.project_id),
      ...goalProjectIds.map(r => r.project_id),
      ...unexecutedCounts.keys(),
    ])
  ).sort()
  const projects: DashboardProject[] = []

  for (const projectId of projectIds) {
    const loopRows = loopsRepo.listAll(projectId)
    const hasLoops = loopRows.length > 0

    const { goals: projectGoals, projectDir: goalProjectDir } = collectProjectGoals(goalsRepo, projectId)

    const projectDir = hasLoops ? loopRows[0].projectDir : goalProjectDir

    // Sort: running first, then by startedAt desc within each group
    const sortedLoops = [...loopRows].sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      const runningDiff = aRunning - bRunning
      if (runningDiff !== 0) return runningDiff
      return b.startedAt - a.startedAt
    })

    const inScopedProject = scope.projectId !== null && projectId === scope.projectId
    const planLoopNames = new Set(plansRepo.listLoopNames(projectId))
    const sectionCounts = sectionPlansRepo.countsByLoop(projectId)
    const bugCounts = reviewFindingsRepo.bugCountsByLoop(projectId)
    const transitionsByLoop = inScopedProject && loopTransitionsRepo
      ? loopTransitionsRepo.listForProject(projectId, DASHBOARD_TRANSITIONS_WINDOW)
      : null

    const dashboardLoops: DashboardLoop[] = sortedLoops.map(loop => {
      const loopName = loop.loopName
      const isScopedLoop = inScopedProject && loopName === scope.loopName

      const large = isScopedLoop ? loopsRepo.getLarge(projectId, loopName) : null
      const lastAuditResult = large?.lastAuditResult ?? null
      const postActionReport = large?.postActionReport ?? null

      const hasPlan = planLoopNames.has(loopName)
      const plan = isScopedLoop ? (plansRepo.getForLoop(projectId, loopName)?.content ?? null) : null

      const sectionCount = sectionCounts.get(loopName) ?? 0
      const sections = isScopedLoop ? sectionPlansRepo.list(projectId, loopName) : []

      const bugCount = bugCounts.get(loopName) ?? 0
      const findings = inScopedProject ? reviewFindingsRepo.listByLoopName(projectId, loopName) : []
      const usage = inScopedProject ? loopSessionUsageRepo.getAggregate(projectId, loopName) : null

      const transitions = transitionsByLoop?.get(loopName) ?? []
      const transitionsCapped = transitions.length >= DASHBOARD_TRANSITIONS_WINDOW

      const amendments = isScopedLoop && amendmentsRepo
        ? amendmentsRepo.listForLoop(projectId, loopName).map(({ sectionsBefore, sectionsAfter, ...rest }) => ({
            ...rest,
            summary: summarizeAmendmentSnapshots(sectionsBefore, sectionsAfter),
          }))
        : []

      const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)
      const duration = elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : null

      const loopRow: LoopRow = isScopedLoop
        ? loop
        : { ...loop, completionSummary: null }

      return {
        id: loopName, loop: loopRow, lastAuditResult, postActionReport,
        plan, hasPlan, sections, sectionCount,
        findings, bugCount, usage, duration, transitions, transitionsCapped, amendments,
      }
    })

    const unexecutedPlanCount = unexecutedCounts.get(projectId) ?? 0
    // A loopless project is hidden from the repo menu (no projectDir labels
    // it), so an unscoped payload ships its plan rows for the repo index's
    // unofficial-projects section to list and delete.
    const shipUnexecutedPlans = inScopedProject || (scope.projectId === null && !hasLoops)
    const unexecutedPlans: DashboardUnexecutedPlan[] = shipUnexecutedPlans
      ? plansRepo.listUnexecuted(projectId).map(row => ({
          id: row.sessionId,
          projectId: row.projectId,
          sessionId: row.sessionId,
          title: extractPlanTitle(row.content),
          updatedAt: row.updatedAt,
          charCount: row.content.length,
        }))
      : []

    projects.push({
      id: projectId,
      projectId,
      projectDir,
      loops: dashboardLoops,
      goals: projectGoals,
      unexecutedPlans,
      unexecutedPlanCount,
    })
  }

  return {
    generatedAt: Date.now(),
    projects,
  }
}
