import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { PLAN_AUTHORING_TOOL_NAMES } from '../constants/loop'

export function buildGoalAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'goal',
    id: 'opencode-goal',
    displayName: 'goal',
    mode: 'primary',
    permission: { question: 'allow' },
    tools: {
      exclude: [
        'write', 'edit', 'multiedit', 'apply_patch', 'patch',
        'plan', 'plan_enter', 'plan_exit',
        'execute-plan', 'execute-goal',
        'launch-group', 'group-status', 'group-cancel',
        'loop-cancel', 'loop-status',
        'review-write', 'review-delete',
        'plan-adjust',
        ...PLAN_AUTHORING_TOOL_NAMES,
      ],
    },
    systemPrompt: loadPrompt(['agents', 'goal.md'], promptsDir),
  }
}
