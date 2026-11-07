import { decomposePlanSections } from './deterministic-decomposer'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'

export interface ApplyPlanDecompositionArgs {
  projectId: string
  loopName: string
  planText: string
  loopsRepo: LoopsRepo
  sectionPlansRepo?: SectionPlansRepo
  maxSections?: number
}

export type ApplyPlanDecompositionResult =
  | { ok: true; totalSections: number }
  | { ok: false; errors: string[] }

/** Single source of truth for the one-shot decompose-and-persist step shared by
 *  loop start (attachLoopToSession) and loop restart (handleLoopRestart).
 *  A plan whose section graph is invalid is rejected before anything is written,
 *  so an invalid graph can never leave partial section rows behind. */
export function applyPlanDecomposition(args: ApplyPlanDecompositionArgs): ApplyPlanDecompositionResult {
  const { projectId, loopName, planText, loopsRepo, sectionPlansRepo } = args
  const maxSections = args.maxSections ?? MAX_TOTAL_SECTIONS
  const { sections, graphErrors } = decomposePlanSections(planText, { maxSections })
  if (graphErrors.length > 0) return { ok: false, errors: graphErrors }
  if (sections.length > 0 && sectionPlansRepo) {
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
    loopsRepo.setTotalSections(projectId, loopName, sections.length)
    loopsRepo.setCurrentSectionIndex(projectId, loopName, 0)
    sectionPlansRepo.setStatus(projectId, loopName, 0, 'in_progress')
    sectionPlansRepo.setStartedAt(projectId, loopName, 0, Date.now())
    return { ok: true, totalSections: sections.length }
  }
  loopsRepo.setTotalSections(projectId, loopName, 0)
  return { ok: true, totalSections: 0 }
}
