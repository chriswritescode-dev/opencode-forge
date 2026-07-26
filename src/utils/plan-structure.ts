import { computeFenceMask } from './markdown-fences'
import { SECTION_MARKER_REGEX, decomposeDeterministically } from '../services/deterministic-decomposer'
import { findExplicitLoopName } from './plan-execution'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'

export interface PlanSectionOutline {
  index: number
  title: string
}

export interface PlanStructureSummary {
  lines: number
  characters: number
  /** Count of unfenced <!-- forge-section --> marker lines, before any cap. */
  sectionMarkers: number
  /** Sections the decomposer would actually produce, after cap and empty-body skipping. */
  sections: PlanSectionOutline[]
  loopName: string | null
  warnings: string[]
}

const NON_REPO_RELATIVE_PATH_REGEX = /(?:^|\s|`|\()((?:~\/|\/Users\/|\/home\/|\/private\/)[^\s`]+)/

/**
 * Counts unfenced `<!-- forge-section -->` marker lines in a plan, reusing the
 * shared fence mask and the decomposer's canonical marker regex so the count
 * matches what the decomposer would actually split on.
 */
export function countSectionMarkers(planText: string): number {
  const lines = planText.split('\n')
  const mask = computeFenceMask(lines)
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    if (SECTION_MARKER_REGEX.test(lines[i].trim())) count++
  }
  return count
}

/**
 * Produces a structural summary of a plan: line/char counts, section marker
 * count, the sections the decomposer would actually emit (after cap and
 * empty-body skipping), the explicit loop name (if any), and a list of
 * authoring warnings in a stable order.
 */
export function summarizePlanStructure(planText: string): PlanStructureSummary {
  const lines = planText.split('\n')
  const sectionMarkers = countSectionMarkers(planText)
  const decomposed = decomposeDeterministically(planText, { maxSections: MAX_TOTAL_SECTIONS })
  const sections: PlanSectionOutline[] = decomposed.map((s) => ({ index: s.index, title: s.title }))
  const loopName = findExplicitLoopName(planText)

  const warnings: string[] = []

  if (sectionMarkers === 0) {
    warnings.push('No <!-- forge-section --> markers found: the whole plan will run as a single section.')
  }

  if (sectionMarkers > MAX_TOTAL_SECTIONS) {
    warnings.push(
      `${sectionMarkers} section markers exceed the cap of ${MAX_TOTAL_SECTIONS}: sections beyond ${MAX_TOTAL_SECTIONS} are dropped at loop start. Consolidate phases.`,
    )
  }

  // Compute empty-body loss independently from cap truncation. Decomposing
  // without a cap yields every marker with a non-empty body; the difference
  // from `sectionMarkers` is exactly the markers the decomposer skips for
  // being empty. Counting it via the uncapped decompose (rather than the
  // capped `sections.length`) keeps the two warnings from suppressing each
  // other when a plan both overflows the cap and has empty phases.
  const uncappedSections = decomposeDeterministically(planText, { maxSections: Number.MAX_SAFE_INTEGER })
  const emptyBodyLoss = Math.max(0, sectionMarkers - uncappedSections.length)
  if (emptyBodyLoss > 0) {
    warnings.push(`${emptyBodyLoss} section marker(s) have empty bodies and will be skipped.`)
  }

  if (loopName === null) {
    warnings.push('No "Loop Name:" line found: the loop name will be derived from the plan title.')
  }

  const pathMatch = planText.match(NON_REPO_RELATIVE_PATH_REGEX)
  if (pathMatch?.[1]) {
    warnings.push(`Plan contains a non-repo-relative path (${pathMatch[1]}). Use repo-relative paths.`)
  }

  return {
    lines: lines.length,
    characters: planText.length,
    sectionMarkers,
    sections,
    loopName,
    warnings,
  }
}

/**
 * Formats a `PlanStructureSummary` as a compact multi-line string suitable for
 * showing the architect immediate structural feedback. Omits the `Loop Name:`
 * line when null and the `Warnings:` block entirely when empty.
 */
export function formatPlanStructureSummary(summary: PlanStructureSummary): string {
  const out: string[] = [`Plan stored: ${summary.lines} lines, ${summary.characters} chars.`]

  if (summary.loopName !== null) {
    out.push(`Loop Name: ${summary.loopName}`)
  }

  if (summary.sections.length === 0) {
    out.push('Sections (0): none detected')
  } else {
    out.push(`Sections (${summary.sections.length}):`)
    for (const s of summary.sections) {
      out.push(`  ${s.index + 1}. ${s.title}`)
    }
  }

  if (summary.warnings.length > 0) {
    out.push('Warnings:')
    for (const w of summary.warnings) {
      out.push(`  - ${w}`)
    }
  }

  return out.join('\n')
}
