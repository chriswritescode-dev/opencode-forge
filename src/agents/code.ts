import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, PLAN_AUTHORING_TOOL_NAMES } from '../constants/loop'

export function buildCodeAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'code',
    id: 'opencode-code',
    displayName: 'code',
    mode: 'all',
    color: '#3b82f6',
    permission: {
      question: 'allow',
    },
    tools: {
      exclude: [...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, 'plan', 'plan_enter', 'plan_exit', ...PLAN_AUTHORING_TOOL_NAMES]
    },
    systemPrompt: loadPrompt(['agents', 'code.md'], promptsDir),
  }
}

