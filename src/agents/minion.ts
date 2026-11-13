import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import {
  LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  LOOP_PHASE_TOOL_NAMES,
  SHARED_STRUCTURAL_DENY_PERMISSIONS,
} from '../constants/loop'

const MINION_TOOL_EXCLUDES = [
  ...SHARED_STRUCTURAL_DENY_PERMISSIONS,
  ...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS,
  ...LOOP_PHASE_TOOL_NAMES,
  'task',
]

export function buildMinionAgent(
  promptsDir?: string,
  model?: { model?: string; variant?: string },
): AgentDefinition {
  const agent: AgentDefinition = {
    role: 'minion',
    id: 'opencode-minion',
    displayName: 'minion',
    description:
      'Proactively use for fast implementation of exactly one explicitly scoped edit, bug fix, refactor, cleanup, validation fix, or coding change when detailed instructions are available. Minions can be launched in batches of up to four.',
    mode: 'subagent',
    color: '#22c55e',
    tools: {
      exclude: MINION_TOOL_EXCLUDES,
    },
    systemPrompt: loadPrompt(['agents', 'minion.md'], promptsDir),
  }
  if (model?.model) {
    agent.defaultModel = model.model
    if (model.variant) agent.variant = model.variant
  }
  return agent
}
