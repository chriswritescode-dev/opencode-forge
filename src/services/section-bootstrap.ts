import { decomposeDeterministically } from './deterministic-decomposer'
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

/** Single source of truth for the one-shot decompose-and-persist step shared by
 *  loop start (attachLoopToSession) and loop restart (handleLoopRestart). */
export function applyPlanDecomposition(args: ApplyPlanDecompositionArgs): { totalSections: number } {
  const { projectId, loopName, planText, loopsRepo, sectionPlansRepo } = args
  const maxSections = args.maxSections ?? 12
  const sections = decomposeDeterministically(planText, { maxSections })
  if (sections.length > 0 && sectionPlansRepo) {
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
    loopsRepo.setTotalSections(projectId, loopName, sections.length)
    loopsRepo.setCurrentSectionIndex(projectId, loopName, 0)
    sectionPlansRepo.setStatus(projectId, loopName, 0, 'in_progress')
    sectionPlansRepo.setStartedAt(projectId, loopName, 0, Date.now())
    return { totalSections: sections.length }
  }
  loopsRepo.setTotalSections(projectId, loopName, 0)
  return { totalSections: 0 }
}
