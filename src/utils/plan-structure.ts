import { decomposePlanSections, isSectionMarkerLine, parseSectionMarker } from '../services/deterministic-decomposer'
import { findCanonicalLoopNameDeclarations, findExplicitLoopName, MAX_LOOP_NAME_LENGTH } from './plan-execution'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import { computeFenceMask } from './markdown-fences'

export interface PlanSectionOutline {
  index: number
  id: string
  title: string
  after: string[]
  startLine?: number
  endLine?: number
}

export interface PlanStructureSummary {
  lines: number
  characters: number
  sectionMarkers: number
  sections: PlanSectionOutline[]
  hasSectionAttributes: boolean
  loopName: string | null
  warnings: string[]
}

const ABSOLUTE_PATH_REGEX = /(?:^|[[\s`"'(])((?:~[\\/]|[a-z]:[\\/]|\\\\|\/(?!\/))[^\s`"')\]]+)/i
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
  options: { skipFencedContent?: boolean } = {},
): Map<string, string[]> {
  const bodies = new Map<string, string[]>()
  let currentHeading: string | null = null

  for (const line of scanLines(text)) {
    if (line.index < minimumIndex) continue
    if (line.isFenceBoundary) continue
    if (options.skipFencedContent && line.inFence) continue

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
    if (!line.inFence && isSectionMarkerLine(line.text)) {
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

function isRepoRelativeNonGlobPath(file: string): boolean {
  if (file.startsWith('/') || file.startsWith('~') || file.startsWith('\\\\')) return false
  if (/^[a-z]:[\\/]/i.test(file)) return false
  return !/[*?]/.test(file)
}

export function extractSectionFiles(sectionContent: string): string[] {
  const body = collectHeadingBodies(sectionContent, 3, 0, { skipFencedContent: true }).get('Files') ?? []
  const seen = new Set<string>()
  const files: string[] = []

  const add = (candidate: string): void => {
    const file = candidate.replace(/\s*\(new\)\s*$/i, '').trim()
    if (!file || seen.has(file) || !isRepoRelativeNonGlobPath(file)) return
    seen.add(file)
    files.push(file)
  }

  for (const line of body) {
    const text = line.replace(/^(?:[-*+]|\d+\.)\s+/, '')
    const tokens = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    if (tokens.length > 0) tokens.forEach(add)
    else add(text)
  }

  return files
}

export function summarizePlanStructure(planText: string): PlanStructureSummary {
  const capped = decomposePlanSections(planText)
  const uncapped = decomposePlanSections(planText, { maxSections: Number.MAX_SAFE_INTEGER })
  const sectionMarkers = capped.markerCount
  const allSections = uncapped.sections
  const sections: PlanSectionOutline[] = capped.sections
    .map((s) => ({
      index: s.index,
      id: s.id,
      title: s.title,
      after: s.after,
      startLine: s.startLine,
      endLine: s.endLine,
    }))
  const loopName = findExplicitLoopName(planText)

  const warnings: string[] = []

  if (sectionMarkers === 0) {
    warnings.push('No <!-- forge-section --> markers found: the whole plan will run as a single section.')
  }

  for (const error of capped.graphErrors) {
    warnings.push(`Section graph: ${error}`)
  }

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
  const hasSectionAttributes = unfencedLines.some(({ text }) => {
    const marker = parseSectionMarker(text)
    return marker !== null && (marker.id !== undefined || marker.after !== undefined)
  })
  const markerLines = unfencedLines.filter(({ text }) => isSectionMarkerLine(text))
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
      && (isSectionMarkerLine(text) || /^Loop Name:/.test(text) || /^#{1,6}\s+/.test(text)),
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

  for (const section of capped.sections) {
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
    hasSectionAttributes,
    loopName,
    warnings,
  }
}

export function findSectionsForLineRange(
  planText: string,
  startLine: number,
  endLine: number,
): PlanSectionOutline[] {
  const { sections: allSections } = decomposePlanSections(planText, {
    maxSections: Number.MAX_SAFE_INTEGER,
  })
  return allSections
    .slice(0, MAX_TOTAL_SECTIONS)
    .filter(
      (s) =>
        s.startLine !== undefined
        && s.endLine !== undefined
        && startLine < s.endLine
        && endLine > s.startLine,
    )
    .map((s) => ({
      index: s.index,
      id: s.id,
      title: s.title,
      after: s.after,
      startLine: s.startLine,
      endLine: s.endLine,
    }))
}

export function formatPlanStructureSummary(
  summary: PlanStructureSummary,
  options: { sectionIndexes?: number[] } = {},
): string {
  const out: string[] = [`Plan stored: ${summary.lines} lines, ${summary.characters} chars.`]

  if (summary.loopName !== null) {
    out.push(`Loop Name: ${summary.loopName}`)
  }

  if (summary.sections.length === 0) {
    out.push('Sections (0): none detected')
  } else {
    const focus = options.sectionIndexes === undefined ? null : new Set(options.sectionIndexes)
    out.push(`Sections (${summary.sections.length}):`)
    for (const s of summary.sections) {
      if (focus === null || focus.has(s.index)) {
        const graph = summary.hasSectionAttributes
          ? ` [id: ${s.id}; after: ${s.after.length > 0 ? s.after.join(', ') : 'none'}]`
          : ''
        out.push(`  ${s.index + 1}. ${s.title}${graph}`)
      }
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
