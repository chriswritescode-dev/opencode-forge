import { generatedSectionId } from './section-graph'
import type { LoopState } from './state'

export type SectionRunKind = 'section' | 'plan' | 'post_action'

export interface LoopLane {
  loopName: string
  sectionRunKey: string
}

export interface SectionRunTarget {
  kind: SectionRunKind
  sectionId: string
  sectionIndex: number
}

/** Stable identity of a section run within one loop. */
export function sectionRunKey(kind: SectionRunKind, sectionId: string): string {
  return kind === 'section' ? `section:${sectionId}` : kind
}

/** The lane (loop plus section run) a loop state currently belongs to. */
export function laneOf(state: Pick<LoopState, 'loopName' | 'sectionRunKey'>): LoopLane {
  return { loopName: state.loopName, sectionRunKey: state.sectionRunKey }
}

/** The directory a run works in: its own lane worktree, else the loop's shared worktree. */
export function runDirectoryOf(state: { laneDir?: string | null; worktreeDir: string }): string {
  return state.laneDir ?? state.worktreeDir
}

/** The section run target implied by the loop's phase and current section. */
export function resolveSectionRunTarget(
  input: {
    phase: 'coding' | 'auditing' | 'post_action'
    totalSections: number
    currentSectionIndex: number
  },
  sectionIdAt: (index: number) => string | null,
): SectionRunTarget {
  const { phase, totalSections, currentSectionIndex } = input
  if (phase === 'post_action') {
    return { kind: 'post_action', sectionId: '', sectionIndex: currentSectionIndex }
  }
  if (totalSections > 0) {
    return {
      kind: 'section',
      sectionId: sectionIdAt(currentSectionIndex) ?? generatedSectionId(currentSectionIndex),
      sectionIndex: currentSectionIndex,
    }
  }
  return { kind: 'plan', sectionId: '', sectionIndex: currentSectionIndex }
}
