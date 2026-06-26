import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { hasSectionSummaryMarkers } from '../utils/section-summary'

const AUDITOR_TOOL_EXCLUDES = [
  'apply_patch',
  'edit',
  'write',
  'multiedit',
  'plan',
  'plan_exit',
  'execute-plan',
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
  if (!hasSectionSummaryMarkers(loop)) {
    console.warn('[forge] auditor-loop-addendum.md is missing section-summary markers; loop section parsing may fail')
  }
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

