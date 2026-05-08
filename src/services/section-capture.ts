import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { Logger, DecomposerConfig } from '../types'
import { extractSections } from '../utils/section-capture'

export interface SectionCaptureResult {
  count: number
  persisted: boolean
}

export function createSectionCaptureService(deps: {
  sectionPlansRepo: SectionPlansRepo
  loopsRepo: LoopsRepo
  logger: Logger
  config: () => DecomposerConfig
}) {
  function captureFromText(args: { projectId: string; loopName: string; text: string }): SectionCaptureResult {
    const cfg = deps.config()
    const maxSections = cfg.maxSections ?? 12
    const sections = extractSections(args.text, { maxSections })

    if (sections.length === 0) {
      deps.logger.log(`section-capture: no sections found in text for loop ${args.loopName}`)
      return { count: 0, persisted: false }
    }

    const result = deps.sectionPlansRepo.bulkInsert({
      projectId: args.projectId,
      loopName: args.loopName,
      sections,
    })

    deps.logger.log(`section-capture: captured ${result.inserted} sections for loop ${args.loopName}`)

    return { count: result.inserted, persisted: result.inserted > 0 }
  }

  return { captureFromText }
}
