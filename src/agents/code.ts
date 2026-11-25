import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, PLAN_AUTHORING_TOOL_NAMES } from '../constants/loop'

const CODE_TOOL_EXCLUDES = [...LOOP_ONLY_STRUCTURAL_DENY_PERMISSIONS, ...PLAN_AUTHORING_TOOL_NAMES]

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
      exclude: CODE_TOOL_EXCLUDES
    },
    systemAddendum: loadPrompt(['agents', 'code.md'], promptsDir),
  }
}

export function buildCodeLoopAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'code-loop',
    id: 'opencode-code-loop',
    displayName: 'code-loop',
    mode: 'primary',
    hidden: true,
    color: '#3b82f6',
    permission: {
      question: 'allow',
    },
    tools: {
      exclude: CODE_TOOL_EXCLUDES
    },
    systemAddendum: loadPrompt(['agents', 'code-loop.md'], promptsDir),
  }
}
