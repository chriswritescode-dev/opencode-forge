import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { ARCHITECT_TOOL_EXCLUDES } from './architect'

export function buildArchitectAutoAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'architect-auto',
    id: 'opencode-architect-auto',
    displayName: 'architect-auto',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: [
        ...ARCHITECT_TOOL_EXCLUDES,
        'question',
        'execute-plan',
        'goal-write',
        'loop-status',
        'loop-cancel',
        'goal-status',
        'goal-cancel',
      ],
    },
    systemPrompt: loadPrompt(['agents', 'architect-auto.md'], promptsDir),
  }
}
