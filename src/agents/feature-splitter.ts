import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { PLAN_AUTHORING_TOOL_NAMES } from '../constants/loop'

export function buildFeatureSplitterAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'feature-splitter',
    id: 'opencode-feature-splitter',
    displayName: 'feature-splitter',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: ['plan', 'plan_enter', 'plan_exit', 'question', 'write', 'edit', 'patch', ...PLAN_AUTHORING_TOOL_NAMES],
    },
    systemPrompt: loadPrompt(['agents', 'feature-splitter.md'], promptsDir),
  }
}
