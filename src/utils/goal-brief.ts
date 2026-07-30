export const GOAL_BRIEF_REQUIRED_HEADINGS = ['Goal', 'Context', 'Constraints', 'Acceptance Criteria'] as const

export interface GoalBriefStructure {
  lines: number
  chars: number
  missingHeadings: string[]
  planStructureViolations: string[]
}

const SECTION_MARKER = '<!-- forge-section -->'
const PHASE_HEADING_REGEX = /^#{2,3}\s+Phase\b/i

function hasRequiredHeading(text: string, heading: string): boolean {
  const regex = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
  return text.split('\n').some((line) => regex.test(line))
}

export function summarizeGoalBrief(text: string): GoalBriefStructure {
  const lines = text.split('\n').length
  const chars = text.length

  const missingHeadings: string[] = []
  for (const heading of GOAL_BRIEF_REQUIRED_HEADINGS) {
    if (!hasRequiredHeading(text, heading)) {
      missingHeadings.push(heading)
    }
  }

  const planStructureViolations: string[] = []
  if (text.includes(SECTION_MARKER)) {
    planStructureViolations.push('<!-- forge-section --> marker')
  }
  if (text.split('\n').some((line) => PHASE_HEADING_REGEX.test(line))) {
    planStructureViolations.push('Phase heading')
  }

  return { lines, chars, missingHeadings, planStructureViolations }
}

export function hasPlanStructureViolations(structure: GoalBriefStructure): boolean {
  return structure.planStructureViolations.length > 0
}

export function formatGoalBriefSummary(structure: GoalBriefStructure): string {
  const out: string[] = [`Goal brief stored: ${structure.lines} lines, ${structure.chars} chars.`]

  if (structure.missingHeadings.length > 0) {
    out.push('Warnings:')
    for (const heading of structure.missingHeadings) {
      out.push(`  - Missing required section: ## ${heading}`)
    }
  }

  if (structure.planStructureViolations.length > 0) {
    out.push('Plan structure not allowed:')
    for (const violation of structure.planStructureViolations) {
      out.push(`  - ${violation}`)
    }
  }

  return out.join('\n')
}
