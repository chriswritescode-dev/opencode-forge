import type { LoopState } from './state'

export type { LoopState } from './state'
export type { CodingState, AuditingState, DecomposingState, FinalAuditingState } from './state'
export type { Phase } from './state'
export type { TerminationStatus } from './termination'

export {
  loopRowToState,
  loopStateToRow,
} from './state'

export {
  terminationStatusFor,
  terminationReasonToString,
  parseTerminationReasonString,
} from './termination'

export type { TerminationReason } from './termination'

export {
  nextTransition,
} from './transitions'
export type { Transition, TransitionEvent } from './transitions'

export {
  buildContinuationPrompt,
  buildAuditPrompt,
  buildDecomposerInitialPrompt,
  buildSectionInitialPrompt,
  buildSectionAuditPrompt,
  buildSectionContinuationPrompt,
  buildFinalAuditPrompt,
} from './prompts'
export type { PromptContext } from './prompts'

export { parseSectionSummary, SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from './section-summary'

export {
  sessionsAwaitingBusy,
  AWAITING_BUSY_TIMEOUT_MS,
  markPromptSent,
  clearPromptPending,
  isAwaitingBusy,
  isAwaitingBusyExpired,
} from './idle-gate'

export interface LoopEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface Loop {
  tick(event: LoopEvent): Promise<void>
  cancel(name: string): Promise<void>
  inspect(name: string): LoopState | null
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  terminateAll(): Promise<void>
}
