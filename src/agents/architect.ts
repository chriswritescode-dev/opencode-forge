import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

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
      exclude: ['plan', 'plan_enter', 'plan_exit'],
    },
    systemPrompt: loadPrompt(['agents', 'architect.md'], promptsDir),
  }
}

