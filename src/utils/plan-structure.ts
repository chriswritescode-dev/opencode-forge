import { decomposePlanSections } from '../services/deterministic-decomposer'
import { findCanonicalLoopNameDeclarations, findExplicitLoopName, MAX_LOOP_NAME_LENGTH } from './plan-execution'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import { computeFenceMask } from './markdown-fences'

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

const ABSOLUTE_PATH_REGEX = /(?:^|[[\s`"'(])((?:~[\\/]|[a-z]:[\\/]|\\\\|\/(?!\/))[^\s`"')\]]+)/i
const SECTION_MARKER_REGEX = /^<!--\s*forge-section\s*-->$/
const REQUIRED_SECTION_HEADINGS = ['Files', 'Edits', 'Acceptance Criteria', 'Verification'] as const
const REQUIRED_TRAILING_HEADINGS = ['Decisions', 'Conventions', 'Key Context'] as const

interface PlanLine {
  index: number
  text: string
  inFence: boolean
  isFenceBoundary: boolean
}

function scanLines(text: string): PlanLine[] {
  const lines = text.split('\n')
  const fenceMask = computeFenceMask(lines)
  return lines.map((line, index) => ({
    index,
    text: line.trim(),
    inFence: fenceMask[index],
    isFenceBoundary: fenceMask[index] !== (fenceMask[index - 1] ?? false),
  }))
}

function scanUnfencedLines(text: string): PlanLine[] {
  return scanLines(text).filter((line) => !line.inFence && !line.isFenceBoundary)
}

function collectHeadingBodies(
  text: string,
  level: 2 | 3,
  minimumIndex = 0,
): Map<string, string[]> {
  const bodies = new Map<string, string[]>()
  let currentHeading: string | null = null

  for (const line of scanLines(text)) {
    if (line.index < minimumIndex) continue
    if (line.isFenceBoundary) continue

    const targetHeading = !line.inFence
      ? line.text.match(new RegExp(`^#{${level}}\\s+(.+?)\\s*$`))
      : null
    if (targetHeading?.[1]) {
      currentHeading = targetHeading[1]
      if (!bodies.has(currentHeading)) bodies.set(currentHeading, [])
      continue
    }

    const anyHeading = !line.inFence ? line.text.match(/^(#{1,6})\s+/) : null
    if (anyHeading) {
      if (anyHeading[1].length <= level) currentHeading = null
      continue
    }
    if (!line.inFence && SECTION_MARKER_REGEX.test(line.text)) {
      currentHeading = null
      continue
    }
    if (currentHeading && line.text) bodies.get(currentHeading)!.push(line.text)
  }

  return bodies
}

function findAbsolutePath(lines: string[]): string | null {
  return lines.join('\n').match(ABSOLUTE_PATH_REGEX)?.[1] ?? null
}

/**
 * Produces a structural summary of a plan: line/char counts, section marker
 * count, the sections the decomposer would actually emit (after cap and
 * empty-body skipping), the explicit loop name (if any), and a list of
 * authoring warnings in a stable order.
 */
export function summarizePlanStructure(planText: string): PlanStructureSummary {
  // One uncapped decomposition answers everything. The capped run is exactly
  // this list's prefix: the decomposer skips empty bodies without consuming cap
  // budget and numbers sections by output position, so slicing yields identical
  // indices and titles.
  const { sections: allSections, markerCount: sectionMarkers } = decomposePlanSections(planText, {
    maxSections: Number.MAX_SAFE_INTEGER,
  })
  const effectiveSections = allSections.slice(0, MAX_TOTAL_SECTIONS)
  const sections: PlanSectionOutline[] = effectiveSections
    .map((s) => ({ index: s.index, title: s.title }))
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

  // Compute empty-body loss independently from cap truncation. `allSections`
  // holds every marker with a non-empty body, so the difference from
  // `sectionMarkers` is exactly the markers the decomposer skips for being
  // empty. Measuring it against the uncapped list (rather than the capped
  // `sections.length`) keeps the two warnings from suppressing each other when
  // a plan both overflows the cap and has empty phases.
  const emptyBodyLoss = Math.max(0, sectionMarkers - allSections.length)
  if (emptyBodyLoss > 0) {
    warnings.push(`${emptyBodyLoss} section marker(s) have empty bodies and will be skipped.`)
  }

  const canonicalLoopNames = findCanonicalLoopNameDeclarations(planText)
  if (loopName === null) {
    warnings.push('No "Loop Name:" line found: the loop name will be derived from the plan title.')
  } else if (canonicalLoopNames.length === 0) {
    warnings.push('Loop Name must be a plain "Loop Name: short-slug" line using lowercase letters, numbers, and hyphens.')
  } else if (canonicalLoopNames.length > 1) {
    warnings.push('Plan must contain exactly one canonical "Loop Name: short-slug" line outside code fences.')
  }
  if (canonicalLoopNames.some((name) => name.length > MAX_LOOP_NAME_LENGTH)) {
    warnings.push(`Loop Name exceeds ${MAX_LOOP_NAME_LENGTH} characters and will be truncated.`)
  }

  const unfencedLines = scanUnfencedLines(planText)
  const markerLines = unfencedLines.filter(({ text }) => SECTION_MARKER_REGEX.test(text))
  const firstMarkerIndex = markerLines[0]?.index ?? Number.POSITIVE_INFINITY
  const lastMarkerIndex = markerLines.at(-1)?.index ?? -1

  const objectiveHeading = unfencedLines.find(
    ({ index, text }) => index < firstMarkerIndex && /^#{1,6}\s+Objective\s*$/i.test(text),
  )
  if (!objectiveHeading) {
    warnings.push('No Objective heading found before the first executable phase.')
  } else {
    const objectiveBoundaryIndex = unfencedLines.find(({ index, text }) =>
      index > objectiveHeading.index
      && (SECTION_MARKER_REGEX.test(text) || /^Loop Name:/.test(text) || /^#{1,6}\s+/.test(text)),
    )?.index ?? firstMarkerIndex
    const objectiveContent = scanLines(planText).filter(({ index, text, isFenceBoundary }) =>
      index > objectiveHeading.index
      && index < objectiveBoundaryIndex
      && !isFenceBoundary
      && text.length > 0,
    )
    if (objectiveContent.length === 0) {
      warnings.push('Objective must include non-empty content before the Loop Name declaration.')
    }
  }

  for (const section of effectiveSections) {
    const sectionLines = scanUnfencedLines(section.content).map(({ text }) => text).filter(Boolean)
    if (!/^##\s+Phase\b/i.test(sectionLines[0] ?? '')) {
      warnings.push(`Section ${section.index + 1} must start with a "## Phase ..." heading immediately after its marker.`)
    }

    const headingBodies = collectHeadingBodies(section.content, 3)
    const missing = REQUIRED_SECTION_HEADINGS.filter((heading) => !headingBodies.has(heading))
    if (missing.length > 0) {
      warnings.push(`Section ${section.index + 1} is missing required headings: ${missing.join(', ')}.`)
    }
    const empty = REQUIRED_SECTION_HEADINGS.filter(
      (heading) => headingBodies.has(heading) && headingBodies.get(heading)!.length === 0,
    )
    if (empty.length > 0) {
      warnings.push(`Section ${section.index + 1} has empty required headings: ${empty.join(', ')}.`)
    }

    const absolutePath = findAbsolutePath(headingBodies.get('Files') ?? [])
    if (absolutePath) {
      warnings.push(`Plan contains a non-repo-relative path (${absolutePath}). Use repo-relative paths.`)
    }
  }

  const trailingBodies = collectHeadingBodies(planText, 2, lastMarkerIndex + 1)
  const missingTrailing = REQUIRED_TRAILING_HEADINGS.filter((heading) => !trailingBodies.has(heading))
  if (missingTrailing.length > 0) {
    warnings.push(`Plan is missing trailing headings: ${missingTrailing.join(', ')}.`)
  }
  const emptyTrailing = REQUIRED_TRAILING_HEADINGS.filter(
    (heading) => trailingBodies.has(heading) && trailingBodies.get(heading)!.length === 0,
  )
  if (emptyTrailing.length > 0) {
    warnings.push(`Plan has empty trailing headings: ${emptyTrailing.join(', ')}.`)
  }

  return {
    lines: planText.split('\n').length,
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
export function formatPlanStructureSummary(
  summary: PlanStructureSummary,
  options: { sectionDetail?: 'all' | 'latest' } = {},
): string {
  const out: string[] = [`Plan stored: ${summary.lines} lines, ${summary.characters} chars.`]

  if (summary.loopName !== null) {
    out.push(`Loop Name: ${summary.loopName}`)
  }

  if (summary.sections.length === 0) {
    out.push('Sections (0): none detected')
  } else if (options.sectionDetail === 'latest') {
    const latest = summary.sections.at(-1)!
    out.push(`Sections (${summary.sections.length}); latest: ${latest.index + 1}. ${latest.title}`)
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
