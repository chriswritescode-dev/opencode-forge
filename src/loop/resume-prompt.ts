import type { PluginConfig } from '../types'
import type { LoopService } from './service'
import type { LoopState } from './state'
import { resolvePostActionConfig } from './post-action-config'
import { auditorModelChoiceAt, buildAuditorModelChain } from '../utils/loop-helpers'
import { parseModelString } from '../utils/model-fallback'

export type ResumePhase = 'coding' | 'final_auditing' | 'post_action'

export interface ResumePromptPlan {
  phase: ResumePhase
  promptText: string
  agent: 'code' | 'auditor-loop'
  model?: { providerID: string; modelID: string }
  fallbackModel?: { providerID: string; modelID: string }
  variant?: string
  auditorModel?: string
}

function normalizeModelString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * A stopped final_audit_fix loop is a coding pass (the fix session), not an
 * auditor phase — restart it as coding with the code prompt agent. The other
 * auditor phases (final_auditing, post_action) preserve their persisted phase.
 */
export function resolveResumePhase(phase: LoopState['phase']): ResumePhase {
  return phase === 'final_auditing'
    ? 'final_auditing'
    : phase === 'post_action'
      ? 'post_action'
      : 'coding'
}

/**
 * Single owner of the restart agent selection: a stopped final_audit_fix loop
 * is a coding pass (the fix session), not an auditor phase — it re-dispatches
 * as the code agent. Only the final_auditing phase re-dispatches the
 * auditor-loop agent.
 */
export function resolveResumeAgent(phase: ResumePhase): 'code' | 'auditor-loop' {
  return phase === 'final_auditing' ? 'auditor-loop' as const : 'code' as const
}

/**
 * Single owner of the restart prompt selection: maps a stopped loop's persisted
 * state to the resume phase, prompt text, agent, and model used to re-dispatch
 * it. handleLoopRestart consumes the plan instead of inlining this chain so
 * restart behavior has exactly one definition.
 */
export function buildResumePromptPlan(input: {
  service: LoopService
  config: PluginConfig
  state: LoopState
}): ResumePromptPlan {
  const { service, config, state } = input

  const phase = resolveResumePhase(state.phase)

  const postActionCfg = state.phase === 'post_action' ? resolvePostActionConfig(config) : undefined

  let promptText: string
  if (state.phase === 'post_action') {
    promptText = service.buildPostActionPrompt(state, { skill: postActionCfg?.skill, prompt: postActionCfg?.prompt })
  } else if (state.kind === 'goal') {
    // Goal loops have no plan, sections, or approval flow — restate the goal
    // directly as a fresh coding pass. No initial audit findings on restart.
    promptText = service.buildContinuationPrompt(state, undefined)
  } else if (state.phase === 'final_audit_fix') {
    // Resume fixing the final-audit findings rather than re-coding the last
    // section: the persisted findings carry the remediation for this
    // recovery path.
    const outstandingBugs = service.getOutstandingFindings(state.loopName, 'bug')
    promptText = service.buildFinalAuditFixPrompt(state, outstandingBugs)
  } else if (state.totalSections > 0) {
    // Use persisted section state to build the correct section prompt
    if (state.phase === 'final_auditing') {
      promptText = service.buildFinalAuditPrompt(state)
    } else {
      promptText = service.buildSectionInitialPrompt(state)
    }
  } else {
    // Legacy non-sectioned prompt
    promptText = state.prompt ?? ''
  }

  const restartAuditorState = {
    ...state,
    auditorModel: normalizeModelString(state.auditorModel ?? config.auditorModel),
    modelFailed: false,
    auditorFallbackIndex: 0,
  }
  const restartAuditorChoice = auditorModelChoiceAt(buildAuditorModelChain(config, restartAuditorState), 0)
  const restartAuditorModel = restartAuditorChoice.model
  const model = state.phase === 'post_action' && postActionCfg?.model
    ? parseModelString(postActionCfg.model)
    : state.phase === 'final_auditing' || state.phase === 'post_action'
      ? restartAuditorModel
      : parseModelString(state.executionModel) ?? parseModelString(config.executionModel)
  // When a configured post-action model is used, fall back to the loop's auditor model if it fails.
  const fallbackModel = state.phase === 'post_action' && postActionCfg?.model
    ? restartAuditorModel
    : undefined

  const agent = resolveResumeAgent(phase)

  return {
    phase,
    promptText,
    agent,
    model,
    fallbackModel,
    variant: agent === 'auditor-loop' ? restartAuditorChoice.variant : state.executionVariant,
    auditorModel: restartAuditorState.auditorModel,
  }
}
