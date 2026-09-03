import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { ARCHITECT_TOOL_EXCLUDES } from './architect'
import { PLAN_AUTHORING_TOOL_NAMES, SHARED_STRUCTURAL_DENY_PERMISSIONS } from '../constants/loop'

export const ARCHITECT_AUTO_TOOL_EXCLUDES = [
  ...ARCHITECT_TOOL_EXCLUDES,
  ...SHARED_STRUCTURAL_DENY_PERMISSIONS.filter(
    (name) => !(ARCHITECT_TOOL_EXCLUDES as string[]).includes(name) && !(PLAN_AUTHORING_TOOL_NAMES as readonly string[]).includes(name),
  ),
]

export function buildArchitectAutoAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'architect-auto',
    id: 'opencode-architect-auto',
    displayName: 'architect-auto',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: ARCHITECT_AUTO_TOOL_EXCLUDES,
    },
    systemPrompt: loadPrompt(['agents', 'architect-auto.md'], promptsDir),
  }
}
