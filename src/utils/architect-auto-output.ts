import { extractMarkedPlan } from './marked-plan-parser'
import { summarizePlanStructure } from './plan-structure'

export const PLAN_NONE_MARKER = '<!-- forge-plan:none -->'

export type ArchitectAutoOutput =
  | { kind: 'plan'; planText: string }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'none' }

export type ArchitectPlanReadiness =
  | { ready: true }
  | { ready: false; reason: string }

export function inspectArchitectPlanReadiness(planText: string): ArchitectPlanReadiness {
  const warnings = summarizePlanStructure(planText).warnings
  if (warnings.length === 0) return { ready: true }
  return { ready: false, reason: `Stored plan is incomplete:\n- ${warnings.join('\n- ')}` }
}

/**
 * Classify an architect's output based on the presence of plan markers
 * or the explicit "none" marker.
 *
 * 1. If the text contains a valid marked plan, return it as `kind: 'plan'`.
 * 2. If the text contains the `PLAN_NONE_MARKER`, return `kind: 'insufficient'`
 *    with the trimmed remainder of the marker line as the reason (or a default message).
 * 3. Otherwise return `kind: 'none'`.
 */
export function classifyArchitectOutput(text: string): ArchitectAutoOutput {
  const extraction = extractMarkedPlan(text)
  if (extraction.ok) {
    return { kind: 'plan', planText: extraction.planText }
  }

  const noneMarker = findMarkerLine(text, PLAN_NONE_MARKER)
  if (noneMarker !== undefined) {
    const remainder = noneMarker.line.slice(noneMarker.index + PLAN_NONE_MARKER.length).trim()
    return {
      kind: 'insufficient',
      reason: remainder || 'Insufficient context to generate a plan.',
    }
  }

  return { kind: 'none' }
}

function findMarkerLine(text: string, marker: string): { line: string; index: number } | undefined {
  for (const rawLine of text.split('\n')) {
    const index = rawLine.indexOf(marker)
    if (index !== -1) return { line: rawLine, index }
  }
  return undefined
}
