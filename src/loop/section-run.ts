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

/** Inverse of {@link sectionRunKey}: recovers the run kind and section id from a stored run key. */
export function splitRunKey(runKey: string): { kind: SectionRunKind; sectionId: string } {
  if (runKey.startsWith('section:')) {
    return { kind: 'section', sectionId: runKey.slice('section:'.length) }
  }
  return { kind: runKey as SectionRunKind, sectionId: '' }
}

/** The lane (loop plus section run) a loop state currently belongs to. */
export function laneOf(state: Pick<LoopState, 'loopName' | 'sectionRunKey'>): LoopLane {
  return { loopName: state.loopName, sectionRunKey: state.sectionRunKey }
}

/** True when a loop runs section runs in parallel lanes: a sectioned worktree loop with more than one slot. */
export function isLaneLoop(
  state: Pick<LoopState, 'worktree' | 'totalSections' | 'maxParallelSections'>,
): boolean {
  return Boolean(state.worktree) && state.totalSections > 0 && state.maxParallelSections > 1
}

/** The directory a run works in: its own lane worktree, else the loop's shared worktree. A post-action run always uses the shared worktree, even when the completed section ran in a lane. */
export function runDirectoryOf(state: { kind?: SectionRunKind; laneDir?: string | null; worktreeDir: string }): string {
  if (state.kind === 'post_action') return state.worktreeDir
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
