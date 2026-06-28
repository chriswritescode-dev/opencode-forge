import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

export function buildFeatureSplitterAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'feature-splitter',
    id: 'opencode-feature-splitter',
    displayName: 'feature-splitter',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: ['plan', 'plan_enter', 'plan_exit', 'question', 'write', 'edit', 'patch'],
    },
    systemPrompt: loadPrompt(['agents', 'feature-splitter.md'], promptsDir),
  }
}
