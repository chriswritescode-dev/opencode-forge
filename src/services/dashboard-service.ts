import type { Database } from 'bun:sqlite'
import { z } from 'zod'
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
  type ForgeAmendmentSectionDiff,
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

const DASHBOARD_TRANSITIONS_WINDOW = 100

export interface DashboardServiceDeps {
  db: Database
  loopsRepo: ReturnType<typeof createLoopsRepo>
  plansRepo: ReturnType<typeof createPlansRepo>
  sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo>
}

interface DashboardProjectDiscovery {
  projectId: string
  unexecutedPlanCount: number
}

function listDashboardProjects(deps: DashboardServiceDeps): DashboardProjectDiscovery[] {
  const { db, plansRepo } = deps

  const loopProjectRows = db.prepare(
    'SELECT DISTINCT project_id FROM loops ORDER BY project_id'
  ).all()
  const parsedLoopProjects = z.array(z.looseObject({ project_id: z.string() })).safeParse(loopProjectRows)
  const loopProjectIds = parsedLoopProjects.success ? parsedLoopProjects.data : []

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
  const summary: ForgeDashboardLoopSummary = {
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
    activityAt: loop.completedAt ?? loop.startedAt,
  }
  if (loop.completedAt !== null) summary.completedAt = loop.completedAt
  if (elapsedSeconds > 0) summary.durationText = formatDuration(elapsedSeconds)
  if (totalCost !== undefined) summary.totalCost = totalCost
  if (loop.worktreeBranch) summary.branch = loop.worktreeBranch
  if (loop.executionModel) summary.executionModel = loop.executionModel
  if (loop.auditorModel) summary.auditorModel = loop.auditorModel
  return summary
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
  const row: ForgeLoopDetailRow = {
    projectId: loop.projectId,
    loopName: loop.loopName,
    status: loop.status,
    currentSessionId: loop.currentSessionId,
    worktree: loop.worktree,
    worktreeDir: loop.worktreeDir,
    projectDir: loop.projectDir,
    maxIterations: loop.maxIterations,
    iteration: loop.iteration,
    auditCount: loop.auditCount,
    errorCount: loop.errorCount,
    phase: loop.phase,
    auditorFallbackIndex: loop.auditorFallbackIndex ?? 0,
    modelFailed: loop.modelFailed,
    sandbox: loop.sandbox,
    startedAt: loop.startedAt,
    currentSectionIndex: loop.currentSectionIndex,
    totalSections: loop.totalSections,
  }
  if (loop.worktreeBranch != null) row.worktreeBranch = loop.worktreeBranch
  if (loop.executionModel != null) row.executionModel = loop.executionModel
  if (loop.executionVariant != null) row.executionVariant = loop.executionVariant
  if (loop.auditorModel != null) row.auditorModel = loop.auditorModel
  if (loop.auditorVariant != null) row.auditorVariant = loop.auditorVariant
  if (loop.completedAt != null) row.completedAt = loop.completedAt
  if (loop.terminationReason != null) row.terminationReason = loop.terminationReason
  if (loop.baseCommit != null) row.baseCommit = loop.baseCommit
  return row
}

function sectionPlanRow(row: SectionPlanRow): ForgeSectionPlan {
  const plan: ForgeSectionPlan = {
    projectId: row.projectId,
    loopName: row.loopName,
    sectionIndex: row.sectionIndex,
    sectionId: row.sectionId,
    dependsOn: row.dependsOn,
    title: row.title,
    content: row.content,
    status: row.status,
    attempts: row.attempts,
  }
  if (row.summaryDone != null) plan.summaryDone = row.summaryDone
  if (row.summaryDeviations != null) plan.summaryDeviations = row.summaryDeviations
  if (row.summaryFollowUps != null) plan.summaryFollowUps = row.summaryFollowUps
  if (row.startedAt != null) plan.startedAt = row.startedAt
  if (row.completedAt != null) plan.completedAt = row.completedAt
  return plan
}

function reviewFindingRow(row: ReviewFindingRow): ForgeReviewFinding {
  const finding: ForgeReviewFinding = {
    projectId: row.projectId,
    file: row.file,
    line: row.line,
    severity: row.severity,
    description: row.description,
    createdAt: row.createdAt,
  }
  if (row.scenario != null) finding.scenario = row.scenario
  if (row.loopName != null) finding.loopName = row.loopName
  if (row.sectionIndex != null) finding.sectionIndex = row.sectionIndex
  return finding
}

function loopTransitionRow(row: LoopTransitionRow): ForgeLoopTransition {
  const transition: ForgeLoopTransition = {
    id: row.id,
    projectId: row.projectId,
    loopName: row.loopName,
    eventType: row.eventType,
    transitionKind: row.transitionKind,
    fromPhase: row.fromPhase,
    iteration: row.iteration,
    createdAt: row.createdAt,
  }
  if (row.toPhase != null) transition.toPhase = row.toPhase
  if (row.status != null) transition.status = row.status
  if (row.reason != null) transition.reason = row.reason
  if (row.sectionIndex != null) transition.sectionIndex = row.sectionIndex
  return transition
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
    sections: diff.sections.map((section) => {
      const change: ForgeAmendmentSectionDiff = {
        index: section.index,
        change: section.change,
        title: section.title,
        lines: section.lines.map((line) => ({ kind: line.kind, text: line.text })),
      }
      if (section.previousTitle != null) change.previousTitle = section.previousTitle
      return change
    }),
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

  const detail: ForgeLoopDetail = {
    loop: loopDetailRow(loop),
    sections: sectionPlansRepo.list(projectId, loopName).map(sectionPlanRow),
    findings: reviewFindingsRepo.listByLoopName(projectId, loopName).map(reviewFindingRow),
    transitions: transitions.map(loopTransitionRow),
    transitionsCapped: transitions.length >= DASHBOARD_TRANSITIONS_WINDOW,
    amendments: amendments.map(planAmendmentRow),
  }
  if (elapsedSeconds > 0) detail.durationText = formatDuration(elapsedSeconds)
  if (large?.lastAuditResult != null) detail.lastAuditResult = large.lastAuditResult
  if (large?.postActionReport != null) detail.postActionReport = large.postActionReport
  if (loop.completionSummary != null) detail.completionSummary = loop.completionSummary
  if (plan !== undefined) detail.plan = plan
  if (usage) detail.usage = usage
  return detail
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

    const summary: ForgeDashboardProjectSummary = {
      projectId: entry.projectId,
      loopCount: loops.length,
      unexecutedPlanCount: entry.unexecutedPlanCount,
      bugCount: loops.reduce((sum, loop) => sum + loop.bugCount, 0),
      loops,
      unexecutedPlans,
    }
    if (projectDir) summary.projectDir = projectDir
    return summary
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
