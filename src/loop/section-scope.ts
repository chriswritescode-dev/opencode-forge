import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { LoopState } from './state'

/**
 * Whether a finding is in the blocking scope of the section being audited:
 * cross-section findings and findings attributed to the current or an earlier
 * section. Findings attributed to a later, not-yet-started section do not block.
 */
export function isFindingInSectionScope(finding: Pick<ReviewFindingRow, 'sectionIndex'>, currentSectionIndex: number): boolean {
  return finding.sectionIndex === null || finding.sectionIndex <= currentSectionIndex
}

/**
 * The single definition of the findings that block a section from being clean
 * and that the auditor/coder must see in a sectioned loop. Non-sectioned loops
 * keep the plan-wide rule: every bug blocks.
 */
export function blockingBugFindings(
  findings: ReviewFindingRow[],
  state: Pick<LoopState, 'currentSectionIndex' | 'totalSections'>,
): ReviewFindingRow[] {
  const bugs = findings.filter(f => f.severity === 'bug')
  if (state.totalSections <= 0) return bugs
  return bugs.filter(f => isFindingInSectionScope(f, state.currentSectionIndex))
}
