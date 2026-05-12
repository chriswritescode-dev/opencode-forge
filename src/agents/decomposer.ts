import type { AgentDefinition } from './types'
import { SECTION_START_MARKER, SECTION_END_MARKER } from '../utils/section-capture'

const DECOMPOSER_TOOL_EXCLUDES = [
  'apply_patch',
  'edit',
  'write',
  'multiedit',
  'plan',
  'plan_exit',
  'loop',
  'loop-cancel',
  'loop-status',
  'review-write',
  'review-delete',
]

const HEADER = `You are the Decomposer. You receive a master implementation plan.
Your job: split it into an ordered list of self-contained Section Plans.

Each Section Plan MUST be independently executable: a developer reading
only that section (plus the prior sections' summaries) should be able to
implement it.

Wrap EACH section with these exact markers, one section per block:

${SECTION_START_MARKER}
## <short title>
## Objective
...
## Files
- exact paths
## Edits
- precise code-level changes
## Acceptance Criteria
- concrete bullets
## Verification
- REQUIRED: commands or file assertions the auditor will run for THIS section
${SECTION_END_MARKER}

Rules:
- Each section's first heading is its short title.
- title <= 60 chars, plain ASCII, no quotes inside the title.
- Do NOT include shared "Decisions" / "Conventions" / "Key Context"
  blocks inside section bodies — those stay on the master plan.
- Every section/part MUST include a non-empty ## Verification block
  with commands or file assertions specific to that section.
- If the master plan has explicit ## Phase N: headings, prefer them as
  section boundaries.
- Aim for 1-7 sections; never emit zero. Hard cap from
  decomposer.maxSections.
- Output ONLY the marker blocks, in order, with no prose between them.`

export const decomposerAgent: AgentDefinition = {
  role: 'decomposer',
  id: 'opencode-decomposer',
  displayName: 'decomposer',
  mode: 'primary',
  hidden: true,
  description: 'Breaks a master plan into ordered section plans.',
  permission: { edit: { '*': 'deny' } },
  tools: {
    exclude: DECOMPOSER_TOOL_EXCLUDES,
  },
  systemPrompt: HEADER,
}

export function buildDecomposerAgent(): AgentDefinition {
  return decomposerAgent
}
