import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

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
      exclude: ['review-write','review-delete', 'plan', 'plan_enter', 'plan_exit']
    },
    systemPrompt: loadPrompt(['agents', 'code.md'], promptsDir),
  }
}


