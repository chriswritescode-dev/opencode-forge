import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopState } from './state'
import { ancestorSectionIds, isLastOpenSectionIndex } from './section-graph'

export type SectionScope =
  | { kind: 'all' }
  | { kind: 'sections'; indexes: ReadonlySet<number> }

function currentAndEarlierScope(currentIndex: number): SectionScope {
  const indexes = new Set<number>()
  for (let index = 0; index <= currentIndex; index++) indexes.add(index)
  return { kind: 'sections', indexes }
}

export function resolveSectionScope(rows: SectionPlanRow[], currentIndex: number): SectionScope {
  if (rows.length === 0) return currentAndEarlierScope(currentIndex)
  if (isLastOpenSectionIndex(rows, currentIndex)) return { kind: 'all' }

  const current = rows.find((row) => row.sectionIndex === currentIndex)
  if (!current) return currentAndEarlierScope(currentIndex)

  const ancestors = ancestorSectionIds(rows, current.sectionId)
  const indexes = new Set<number>([currentIndex])
  for (const row of rows) {
    if (ancestors.has(row.sectionId)) indexes.add(row.sectionIndex)
  }
  return { kind: 'sections', indexes }
}

export function isFindingInSectionScope(finding: Pick<ReviewFindingRow, 'sectionIndex'>, scope: SectionScope): boolean {
  if (finding.sectionIndex === null) return true
  if (scope.kind === 'all') return true
  return scope.indexes.has(finding.sectionIndex)
}

export function blockingBugFindings(
  findings: ReviewFindingRow[],
  state: Pick<LoopState, 'totalSections'>,
  scope: SectionScope,
): ReviewFindingRow[] {
  const bugs = findings.filter(f => f.severity === 'bug')
  if (state.totalSections <= 0) return bugs
  return bugs.filter(f => isFindingInSectionScope(f, scope))
}
