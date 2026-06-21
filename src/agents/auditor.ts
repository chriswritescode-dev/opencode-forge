import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'

const AUDITOR_TOOL_EXCLUDES = [
  'apply_patch',
  'edit',
  'write',
  'multiedit',
  'plan',
  'plan_exit',
  'loop',
  'loop-cancel',
  'loop-status',
]

function buildBasePrompt(promptsDir?: string): string {
  return loadPrompt(['agents', 'auditor.md'], promptsDir)
}

function buildLoopPrompt(promptsDir?: string): string {
  const base = buildBasePrompt(promptsDir)
  const loop = loadPrompt(['agents', 'auditor-loop-addendum.md'], promptsDir)
  const final = loadPrompt(['agents', 'auditor-final-audit-addendum.md'], promptsDir)
  return `${base}\n\n${loop}\n\n${final}`
}

export function buildAuditorAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'auditor',
    id: 'opencode-auditor',
    displayName: 'auditor',
    mode: 'subagent',
    tools: {
      exclude: AUDITOR_TOOL_EXCLUDES,
    },
    systemPrompt: buildBasePrompt(promptsDir),
  }
}

export function buildAuditorLoopAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'auditor-loop',
    id: 'opencode-auditor-loop',
    displayName: 'auditor-loop',
    mode: 'primary',
    hidden: true,
    tools: {
      exclude: AUDITOR_TOOL_EXCLUDES,
    },
    systemPrompt: buildLoopPrompt(promptsDir),
  }
}

export const auditorAgent: AgentDefinition = buildAuditorAgent()
export const auditorLoopAgent: AgentDefinition = buildAuditorLoopAgent()
