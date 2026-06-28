import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

export function buildArchitectAutoAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'architect-auto',
    id: 'opencode-architect-auto',
    displayName: 'architect-auto',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: ['plan', 'plan_enter', 'plan_exit', 'question'],
    },
    systemPrompt: loadPrompt(['agents', 'architect-auto.md'], promptsDir),
  }
}
