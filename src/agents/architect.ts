import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

export const ARCHITECT_TOOL_EXCLUDES = [
  'edit',
  'write',
  'patch',
  'task',
]

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
      exclude: ARCHITECT_TOOL_EXCLUDES,
    },
    systemPrompt: loadPrompt(['agents', 'architect.md'], promptsDir),
  }
}
