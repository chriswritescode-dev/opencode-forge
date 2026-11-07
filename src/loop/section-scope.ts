import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import type { LoopState } from './state'
import { ancestorSectionIds, isLastOpenSectionIndex } from './section-graph'

/**
 * The sections whose findings block the section currently being audited.
 * `all` applies on the last open section, where every outstanding bug blocks.
 */
export type SectionScope =
  | { kind: 'all' }
  | { kind: 'sections'; indexes: ReadonlySet<number> }

/** Today's fallback: every index from the current one back through zero. */
function currentAndEarlierScope(currentIndex: number): SectionScope {
  const indexes = new Set<number>()
  for (let index = 0; index <= currentIndex; index++) indexes.add(index)
  return { kind: 'sections', indexes }
}

/**
 * Resolve the blocking scope for the section at `currentIndex`: the section
 * itself plus every section it depends on, directly or transitively. The last
 * open section has no later section to wait for, so every finding blocks there.
 * Without rows (or without a matching current row) fall back to the current and
 * every earlier index.
 */
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

/**
 * Whether a finding blocks the audited section: cross-section findings always
 * do, and a scoped finding does when its section is in scope. `all` blocks every
 * finding (the last open section).
 */
export function isFindingInSectionScope(finding: Pick<ReviewFindingRow, 'sectionIndex'>, scope: SectionScope): boolean {
  if (finding.sectionIndex === null) return true
  if (scope.kind === 'all') return true
  return scope.indexes.has(finding.sectionIndex)
}

/**
 * The single definition of the findings that block a section from being clean
 * and that the auditor/coder must see in a sectioned loop. Non-sectioned loops
 * keep the plan-wide rule: every bug blocks.
 */
export function blockingBugFindings(
  findings: ReviewFindingRow[],
  state: Pick<LoopState, 'totalSections'>,
  scope: SectionScope,
): ReviewFindingRow[] {
  const bugs = findings.filter(f => f.severity === 'bug')
  if (state.totalSections <= 0) return bugs
  return bugs.filter(f => isFindingInSectionScope(f, scope))
}
