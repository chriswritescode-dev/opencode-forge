import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS, SHARED_STRUCTURAL_DENY_PERMISSIONS } from '../constants/loop'

export function buildFeatureSplitterAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'feature-splitter',
    id: 'opencode-feature-splitter',
    displayName: 'feature-splitter',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: [...AUDIT_ONLY_STRUCTURAL_DENY_PERMISSIONS, ...SHARED_STRUCTURAL_DENY_PERMISSIONS],
    },
    systemPrompt: loadPrompt(['agents', 'feature-splitter.md'], promptsDir),
  }
}
