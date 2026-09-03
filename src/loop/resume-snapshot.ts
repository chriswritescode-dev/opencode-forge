import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { LoopState } from './state'
import { resolveResumePhase, type ResumePhase } from './resume-prompt'
import { isRecord } from '../utils/is-record'

/**
 * Host-independent snapshot of a loop's resumable progress. Section rows and
 * findings are stripped of project/loop scoping and timestamps so the payload
 * can be serialized across a migration boundary and re-attached under a
 * different project id / loop name.
 */
export interface LoopResumeSnapshot {
  version: 1
  kind: 'plan' | 'goal'
  phase: ResumePhase
  currentSectionIndex: number
  totalSections: number
  finalAuditDone: boolean
  /** Goal text, present only for goal loops. */
  goal?: string
  sections: ResumeSectionRow[]
  findings: ResumeFindingRow[]
}

export type ResumeSectionRow = Omit<SectionPlanRow, 'projectId' | 'loopName' | 'createdAt'>

export type ResumeFindingRow = Pick<ReviewFindingRow, 'file' | 'line' | 'severity' | 'description' | 'scenario' | 'sectionIndex'>

const RESUME_PHASES: readonly ResumePhase[] = ['coding', 'final_auditing', 'post_action']

export function captureLoopResumeSnapshot(input: {
  projectId: string
  state: LoopState
  sectionPlansRepo: SectionPlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
}): LoopResumeSnapshot {
  const { projectId, state, sectionPlansRepo, reviewFindingsRepo } = input
  const sections = sectionPlansRepo.list(projectId, state.loopName).map(({ projectId: _p, loopName: _l, createdAt: _c, ...row }) => row)
  const findings = reviewFindingsRepo
    .listByLoopName(projectId, state.loopName)
    .map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      description: f.description,
      scenario: f.scenario,
      sectionIndex: f.sectionIndex,
    }))
  return {
    version: 1,
    kind: state.kind ?? 'plan',
    phase: resolveResumePhase(state.phase),
    currentSectionIndex: state.currentSectionIndex,
    totalSections: state.totalSections,
    finalAuditDone: state.finalAuditDone,
    ...(state.kind === 'goal' && state.goal ? { goal: state.goal } : {}),
    sections,
    findings,
  }
}

export function restoreLoopResumeRows(input: {
  projectId: string
  loopName: string
  snapshot: LoopResumeSnapshot
  sectionPlansRepo: SectionPlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
}): void {
  const { projectId, loopName, snapshot, sectionPlansRepo, reviewFindingsRepo } = input
  sectionPlansRepo.immediateTransaction(() => {
    sectionPlansRepo.restoreAll(
      snapshot.sections.map((section) => ({
        ...section,
        projectId,
        loopName,
        createdAt: Date.now(),
      })),
    )
    for (const finding of snapshot.findings) {
      reviewFindingsRepo.write({
        projectId,
        loopName,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        description: finding.description,
        scenario: finding.scenario,
        sectionIndex: finding.sectionIndex,
      })
    }
  })
}

const SECTION_STATUSES: readonly SectionPlanRow['status'][] = ['pending', 'in_progress', 'completed', 'failed']

function isValidResumeSection(value: unknown): value is ResumeSectionRow {
  if (!isRecord(value)) return false
  if (typeof value.sectionIndex !== 'number') return false
  if (typeof value.title !== 'string') return false
  if (typeof value.content !== 'string') return false
  if (!SECTION_STATUSES.includes(value.status as SectionPlanRow['status'])) return false
  if (typeof value.attempts !== 'number') return false
  for (const key of ['summaryDone', 'summaryDeviations', 'summaryFollowUps'] as const) {
    const item = value[key]
    if (item !== null && item !== undefined && typeof item !== 'string') return false
  }
  for (const key of ['startedAt', 'completedAt'] as const) {
    const item = value[key]
    if (item !== null && item !== undefined && typeof item !== 'number') return false
  }
  return true
}

function isValidResumeFinding(value: unknown): value is ResumeFindingRow {
  if (!isRecord(value)) return false
  if (typeof value.file !== 'string') return false
  if (typeof value.line !== 'number') return false
  if (value.severity !== 'bug' && value.severity !== 'warning') return false
  if (typeof value.description !== 'string') return false
  if (value.scenario !== null && value.scenario !== undefined && typeof value.scenario !== 'string') return false
  if (value.sectionIndex !== null && value.sectionIndex !== undefined && typeof value.sectionIndex !== 'number') return false
  return true
}

export function isLoopResumeSnapshot(value: unknown): value is LoopResumeSnapshot {
  if (!isRecord(value)) return false
  if (value.version !== 1) return false
  if (value.kind !== 'plan' && value.kind !== 'goal') return false
  if (!RESUME_PHASES.includes(value.phase as ResumePhase)) return false
  if (typeof value.currentSectionIndex !== 'number') return false
  if (typeof value.totalSections !== 'number') return false
  if (typeof value.finalAuditDone !== 'boolean') return false
  if (value.goal !== undefined && typeof value.goal !== 'string') return false
  if (!Array.isArray(value.sections)) return false
  if (!Array.isArray(value.findings)) return false
  if (!value.sections.every(isValidResumeSection)) return false
  if (!value.findings.every(isValidResumeFinding)) return false
  return true
}
