import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { GOAL_AUTHORING_TOOL_NAMES } from '../constants/loop'

export function buildArchitectAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'architect',
    id: 'opencode-architect',
    displayName: 'architect',
    mode: 'primary',
    color: '#ef4444',
    permission: {
      question: 'allow',
    },
    tools: {
      exclude: ['plan', 'plan_enter', 'plan_exit', ...GOAL_AUTHORING_TOOL_NAMES],
    },
    systemPrompt: loadPrompt(['agents', 'architect.md'], promptsDir),
  }
}

