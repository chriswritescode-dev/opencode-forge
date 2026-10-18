import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { ARCHITECT_TOOL_EXCLUDES } from './architect'
import { AUTONOMOUS_ARCHITECT_STRUCTURAL_DENY_PERMISSIONS } from '../constants/loop'

export function buildArchitectAutoAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'architect-auto',
    id: 'opencode-architect-auto',
    displayName: 'architect-auto',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: [...ARCHITECT_TOOL_EXCLUDES, ...AUTONOMOUS_ARCHITECT_STRUCTURAL_DENY_PERMISSIONS],
    },
    systemPrompt: loadPrompt(['agents', 'architect-auto.md'], promptsDir),
  }
}
