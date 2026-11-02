import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createLoopSessionUsageRepo,
  createLoopTransitionsRepo,
  createPlanAmendmentsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  type LoopTransitionRow,
  type PlanAmendmentRow,
  type ReviewFindingRow,
  type SectionPlanRow,
} from '../storage'
import type { LoopRow } from '../storage/repos/loops-repo'
import {
  type ForgeAmendmentDiff,
  type ForgeAmendmentDiffOutput,
  type ForgeDashboardLoopSummary,
  type ForgeDashboardProjectSummary,
  type ForgeDashboardSummary,
  type ForgeDashboardSummaryOutput,
  type ForgeDashboardUnexecutedPlan,
  type ForgeLoopDetail,
  type ForgeLoopDetailOutput,
  type ForgeLoopDetailRow,
  type ForgeLoopTransition,
  type ForgePlanAmendment,
  type ForgeProjectFindings,
  type ForgeProjectFindingsOutput,
  type ForgePlanDeleteOutput,
  type ForgeReviewFinding,
  type ForgeSectionPlan,
} from '../host/forge-rpc-dashboard'
import { errorMessage } from '../utils/error-message'
import { computeElapsedSeconds, formatDuration } from '../utils/duration'
import {
  diffAmendmentSnapshots,
  summarizeAmendmentSnapshots,
  type AmendmentDiff,
} from '../utils/amendment-diff'
import { extractPlanTitle } from '../utils/plan-execution'

/** Newest transitions shipped for one loop; reaching it means older rows may be missing. */
const DASHBOARD_TRANSITIONS_WINDOW = 100

export interface DashboardServiceDeps {
  /** Raw handle used only for the project-discovery queries no repo exposes. */
  db: Database
  loopsRepo: ReturnType<typeof createLoopsRepo>
  /** Wrapped plan repo the write path uses, so deleting a plan publishes `plansChanged`. */
  plansRepo: ReturnType<typeof createPlansRepo>
  sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo>
}

interface DashboardProjectDiscovery {
  projectId: string
  /** Unexecuted session plans for this project, computed once for the whole discovery scan. */
  unexecutedPlanCount: number
}

/**
 * Every project the dashboard reports on: the union of loop projects and
 * projects with unexecuted session plans, sorted by project id.
 */
function listDashboardProjects(deps: DashboardServiceDeps): DashboardProjectDiscovery[] {
  const { db, plansRepo } = deps

  const loopProjectIds = db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id'
  ).all() as { project_id: string }[]

  const unexecutedCounts = plansRepo.unexecutedCountsByProject()

  return Array.from(new Set([
    ...loopProjectIds.map((row) => row.project_id),
    ...unexecutedCounts.keys(),
  ])).sort().map((projectId) => ({
    projectId,
    unexecutedPlanCount: unexecutedCounts.get(projectId) ?? 0,
  }))
}

function sortDashboardLoops(loopRows: LoopRow[]): LoopRow[] {
  return [...loopRows].sort((a, b) => {
    const runningDiff = Number(a.status !== 'running') - Number(b.status !== 'running')
    if (runningDiff !== 0) return runningDiff
    return b.startedAt - a.startedAt
  })
}

function loopSummary(
  loop: LoopRow,
  sectionCounts: Map<string, number>,
  bugCounts: Map<string, number>,
  planLoopNames: Set<string>,
  totalCosts: Map<string, number>,
): ForgeDashboardLoopSummary {
  const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)
  const totalCost = totalCosts.get(loop.loopName)
  return {
    loopName: loop.loopName,
    status: loop.status,
    phase: loop.phase,
    iteration: loop.iteration,
    maxIterations: loop.maxIterations,
    currentSectionIndex: loop.currentSectionIndex,
    totalSections: loop.totalSections,
    sectionCount: sectionCounts.get(loop.loopName) ?? 0,
    bugCount: bugCounts.get(loop.loopName) ?? 0,
    hasPlan: planLoopNames.has(loop.loopName),
    startedAt: loop.startedAt,
    ...(loop.completedAt !== null ? { completedAt: loop.completedAt } : {}),
    activityAt: loop.completedAt ?? loop.startedAt,
    ...(elapsedSeconds > 0 ? { durationText: formatDuration(elapsedSeconds) } : {}),
    ...(totalCost !== undefined ? { totalCost } : {}),
    ...(loop.worktreeBranch ? { branch: loop.worktreeBranch } : {}),
    ...(loop.executionModel ? { executionModel: loop.executionModel } : {}),
    ...(loop.auditorModel ? { auditorModel: loop.auditorModel } : {}),
  }
}

function planTitle(content: string): string {
  const title = extractPlanTitle(content)
  const stripped = title.replace(/^#+\s*/, '')
  return stripped.length > 0 ? stripped : title
}

function planSummary(row: { sessionId: string; content: string; updatedAt: number }): ForgeDashboardUnexecutedPlan {
  return {
    sessionId: row.sessionId,
    title: planTitle(row.content),
    updatedAt: row.updatedAt,
    charCount: row.content.length,
  }
}

function loopDetailRow(loop: LoopRow): ForgeLoopDetailRow {
  return {
    projectId: loop.projectId,
    loopName: loop.loopName,
    status: loop.status,
    currentSessionId: loop.currentSessionId,
    worktree: loop.worktree,
    worktreeDir: loop.worktreeDir,
    ...(loop.worktreeBranch != null ? { worktreeBranch: loop.worktreeBranch } : {}),
    projectDir: loop.projectDir,
    maxIterations: loop.maxIterations,
    iteration: loop.iteration,
    auditCount: loop.auditCount,
    errorCount: loop.errorCount,
    phase: loop.phase,
    ...(loop.executionModel != null ? { executionModel: loop.executionModel } : {}),
    ...(loop.executionVariant != null ? { executionVariant: loop.executionVariant } : {}),
    ...(loop.auditorModel != null ? { auditorModel: loop.auditorModel } : {}),
    ...(loop.auditorVariant != null ? { auditorVariant: loop.auditorVariant } : {}),
    auditorFallbackIndex: loop.auditorFallbackIndex ?? 0,
    modelFailed: loop.modelFailed,
    sandbox: loop.sandbox,
    startedAt: loop.startedAt,
    ...(loop.completedAt != null ? { completedAt: loop.completedAt } : {}),
    ...(loop.terminationReason != null ? { terminationReason: loop.terminationReason } : {}),
    currentSectionIndex: loop.currentSectionIndex,
    totalSections: loop.totalSections,
    ...(loop.baseCommit != null ? { baseCommit: loop.baseCommit } : {}),
  }
}

function sectionPlanRow(row: SectionPlanRow): ForgeSectionPlan {
  return {
    projectId: row.projectId,
    loopName: row.loopName,
    sectionIndex: row.sectionIndex,
    title: row.title,
    content: row.content,
    status: row.status,
    attempts: row.attempts,
    ...(row.summaryDone != null ? { summaryDone: row.summaryDone } : {}),
    ...(row.summaryDeviations != null ? { summaryDeviations: row.summaryDeviations } : {}),
    ...(row.summaryFollowUps != null ? { summaryFollowUps: row.summaryFollowUps } : {}),
    ...(row.startedAt != null ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt != null ? { completedAt: row.completedAt } : {}),
  }
}

function reviewFindingRow(row: ReviewFindingRow): ForgeReviewFinding {
  return {
    projectId: row.projectId,
    file: row.file,
    line: row.line,
    severity: row.severity,
    description: row.description,
    ...(row.scenario != null ? { scenario: row.scenario } : {}),
    ...(row.loopName != null ? { loopName: row.loopName } : {}),
    ...(row.sectionIndex != null ? { sectionIndex: row.sectionIndex } : {}),
    createdAt: row.createdAt,
  }
}

function loopTransitionRow(row: LoopTransitionRow): ForgeLoopTransition {
  return {
    id: row.id,
    projectId: row.projectId,
    loopName: row.loopName,
    eventType: row.eventType,
    transitionKind: row.transitionKind,
    fromPhase: row.fromPhase,
    ...(row.toPhase != null ? { toPhase: row.toPhase } : {}),
    ...(row.status != null ? { status: row.status } : {}),
    ...(row.reason != null ? { reason: row.reason } : {}),
    iteration: row.iteration,
    ...(row.sectionIndex != null ? { sectionIndex: row.sectionIndex } : {}),
    createdAt: row.createdAt,
  }
}

function planAmendmentRow(row: PlanAmendmentRow): ForgePlanAmendment {
  return {
    id: row.id,
    projectId: row.projectId,
    loopName: row.loopName,
    source: row.source,
    rationale: row.rationale,
    appliedAtSection: row.appliedAtSection,
    createdAt: row.createdAt,
    summary: summarizeAmendmentSnapshots(row.sectionsBefore, row.sectionsAfter),
  }
}

function amendmentDiffResult(diff: AmendmentDiff): ForgeAmendmentDiff {
  return {
    summary: diff.summary,
    sections: diff.sections.map((section) => ({
      index: section.index,
      change: section.change,
      title: section.title,
      ...(section.previousTitle != null ? { previousTitle: section.previousTitle } : {}),
      lines: section.lines.map((line) => ({ kind: line.kind, text: line.text })),
    })),
  }
}

function buildLoopDetail(deps: DashboardServiceDeps, loop: LoopRow): ForgeLoopDetail {
  const {
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopSessionUsageRepo,
    loopTransitionsRepo,
    amendmentsRepo,
  } = deps
  const { projectId, loopName } = loop
  const large = loopsRepo.getLarge(projectId, loopName)
  const plan = plansRepo.getForLoop(projectId, loopName)?.content
  const usage = loopSessionUsageRepo.getAggregate(projectId, loopName)
  const transitions = loopTransitionsRepo.listForLoop(projectId, loopName, DASHBOARD_TRANSITIONS_WINDOW)
  const amendments = amendmentsRepo.listForLoop(projectId, loopName)
  const elapsedSeconds = computeElapsedSeconds(loop.startedAt, loop.completedAt ?? undefined)

  return {
    loop: loopDetailRow(loop),
    ...(elapsedSeconds > 0 ? { durationText: formatDuration(elapsedSeconds) } : {}),
    ...(large?.lastAuditResult != null ? { lastAuditResult: large.lastAuditResult } : {}),
    ...(large?.postActionReport != null ? { postActionReport: large.postActionReport } : {}),
    ...(loop.completionSummary != null ? { completionSummary: loop.completionSummary } : {}),
    ...(plan !== undefined ? { plan } : {}),
    sections: sectionPlansRepo.list(projectId, loopName).map(sectionPlanRow),
    findings: reviewFindingsRepo.listByLoopName(projectId, loopName).map(reviewFindingRow),
    ...(usage ? { usage } : {}),
    transitions: transitions.map(loopTransitionRow),
    transitionsCapped: transitions.length >= DASHBOARD_TRANSITIONS_WINDOW,
    amendments: amendments.map(planAmendmentRow),
  }
}

function buildProjectFindings(deps: DashboardServiceDeps, projectId: string): ForgeProjectFindings {
  const findingsByLoop = new Map<string, ReviewFindingRow[]>()
  for (const finding of deps.reviewFindingsRepo.listAll(projectId)) {
    if (finding.loopName === null) continue
    const bucket = findingsByLoop.get(finding.loopName)
    if (bucket) bucket.push(finding)
    else findingsByLoop.set(finding.loopName, [finding])
  }
  const loops = sortDashboardLoops(deps.loopsRepo.listAll(projectId)).flatMap((loop) => {
    const findings = findingsByLoop.get(loop.loopName)
    return findings ? [{
      loopName: loop.loopName,
      findings: findings.map(reviewFindingRow),
    }] : []
  })
  return { loops }
}

function buildSummary(deps: DashboardServiceDeps): ForgeDashboardSummary {
  const {
    loopsRepo,
    plansRepo,
    reviewFindingsRepo,
    sectionPlansRepo,
    loopSessionUsageRepo,
  } = deps

  const discovery = listDashboardProjects(deps)

  const projects: ForgeDashboardProjectSummary[] = discovery.map((entry) => {
    const loopRows = loopsRepo.listAll(entry.projectId)
    const planLoopNames = new Set(plansRepo.listLoopNames(entry.projectId))
    const sectionCounts = sectionPlansRepo.countsByLoop(entry.projectId)
    const bugCounts = reviewFindingsRepo.bugCountsByLoop(entry.projectId)
    const totalCosts = loopSessionUsageRepo.totalCostsByLoop(entry.projectId)

    const loops = sortDashboardLoops(loopRows).map((loop) =>
      loopSummary(loop, sectionCounts, bugCounts, planLoopNames, totalCosts))
    const unexecutedPlans = plansRepo.listUnexecuted(entry.projectId).map(planSummary)
    const projectDir = loopRows.length > 0 ? loopRows[0].projectDir : null

    return {
      projectId: entry.projectId,
      ...(projectDir ? { projectDir } : {}),
      loopCount: loops.length,
      unexecutedPlanCount: entry.unexecutedPlanCount,
      bugCount: loops.reduce((sum, loop) => sum + loop.bugCount, 0),
      loops,
      unexecutedPlans,
    }
  })

  return { generatedAt: Date.now(), projects }
}

export interface DashboardService {
  getSummary(): ForgeDashboardSummaryOutput
  getLoopDetail(projectId: string, loopName: string): ForgeLoopDetailOutput
  getProjectFindings(projectId: string): ForgeProjectFindingsOutput
  getAmendmentDiff(projectId: string, loopName: string, id: number): ForgeAmendmentDiffOutput
  deletePlan(projectId: string, sessionId: string): ForgePlanDeleteOutput
}

/** Read model the dashboard RPC serves; every method returns the shared error envelope on failure. */
export function createDashboardService(deps: DashboardServiceDeps): DashboardService {
  return {
    getSummary(): ForgeDashboardSummaryOutput {
      try {
        return buildSummary(deps)
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    getLoopDetail(projectId: string, loopName: string): ForgeLoopDetailOutput {
      try {
        const loop = deps.loopsRepo.get(projectId, loopName)
        if (!loop) return { error: 'Loop not found' }
        return buildLoopDetail(deps, loop)
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    getProjectFindings(projectId: string): ForgeProjectFindingsOutput {
      try {
        return buildProjectFindings(deps, projectId)
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    getAmendmentDiff(projectId: string, loopName: string, id: number): ForgeAmendmentDiffOutput {
      try {
        const row = deps.amendmentsRepo.get(projectId, loopName, id)
        if (!row) return { error: 'Amendment not found' }
        return amendmentDiffResult(diffAmendmentSnapshots(row.sectionsBefore, row.sectionsAfter))
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },

    deletePlan(projectId: string, sessionId: string): ForgePlanDeleteOutput {
      try {
        return deps.plansRepo.deleteForSession(projectId, sessionId)
          ? { deleted: true }
          : { error: 'Plan not found' }
      } catch (err) {
        return { error: errorMessage(err) }
      }
    },
  }
}
