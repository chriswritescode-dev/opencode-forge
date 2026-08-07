import type { AgentDefinition } from './types'
import { loadPrompt } from '../prompts/loader'
import { AUDITOR_TOOL_EXCLUDES } from './auditor'

const IMPACT_REVIEWER_TOOL_EXCLUDES = [
  ...AUDITOR_TOOL_EXCLUDES,
  'review-write',
  'review-delete',
  'plan-adjust',
  'task',
]

export function buildImpactReviewerAgent(promptsDir?: string): AgentDefinition {
  return {
    role: 'impact-reviewer',
    id: 'opencode-impact-reviewer',
    displayName: 'impact-reviewer',
    description: 'Read-only reviewer that checks a scoped change set for duplication of existing helpers, parallel implementations, missed callers of changed shared code, and dead code. Reports findings as text; never writes review findings.',
    mode: 'subagent',
    hidden: true,
    tools: {
      exclude: IMPACT_REVIEWER_TOOL_EXCLUDES,
    },
    systemPrompt: loadPrompt(['agents', 'impact-reviewer.md'], promptsDir),
  }
}
