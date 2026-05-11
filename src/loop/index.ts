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

export { createLoop, isWorkspaceNotFoundError } from './runtime'
export type { Loop, LoopEvent, LoopRuntimeDeps, OnTerminatedCallback, StartLoopInput } from './runtime'

export {
  rowToLoopState,
  MAX_RETRIES,
} from './service'
export type { LoopService, LoopChangeReason, LoopChangeNotifier } from './service'

export { generateUniqueName } from './name-uniqueness'

export { sweepOrphanWorkspaces } from './orphan-sweep'

export { fetchSessionOutput } from './session-output'
export type { LoopSessionOutput } from './session-output'
