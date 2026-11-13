import type { ParsedSection } from '../utils/section-capture'
import { computeFenceMask } from '../utils/markdown-fences'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import { truncateAtWordBoundary, stripLeadingStructuralOrdinal } from '../utils/format'
import { generatedSectionId, validateSectionGraph } from '../loop/section-graph'

const SECTION_MARKER_REGEX = /^<!--\s*forge-section((?:\s+[a-z]+="[^"]*")*)\s*-->$/
const SECTION_MARKER_PREFIX_REGEX = /^<!--\s*forge-section/
const LEGACY_SECTION_PAIR_REGEX = /^<!--\s*forge-section:(?:start|end)\s*-->$/
const MARKER_ATTRIBUTE_REGEX = /\s+([a-z]+)="([^"]*)"/g
const MARKER_ATTRIBUTE_NAMES = new Set(['id', 'after'])
const STOP_HEADINGS = ['## Verification', '## Decisions', '## Conventions', '## Key Context']
const STRUCTURAL_TITLES = new Set(['verification', 'decisions', 'conventions', 'key context', 'objective', 'loop name'])

export interface ParsedSectionMarker {
  id?: string
  after?: string[]
  errors: string[]
}

export function parseSectionMarker(line: string): ParsedSectionMarker | null {
  const text = line.trim()
  const match = text.match(SECTION_MARKER_REGEX)
  if (!match) {
    if (SECTION_MARKER_PREFIX_REGEX.test(text) && !LEGACY_SECTION_PAIR_REGEX.test(text)) {
      return {
        errors: ['Malformed section marker: expected <!-- forge-section id="..." after="..." -->'],
      }
    }
    return null
  }

  const errors: string[] = []
  const seen = new Set<string>()
  let id: string | undefined
  let after: string[] | undefined

  for (const attribute of match[1].matchAll(MARKER_ATTRIBUTE_REGEX)) {
    const name = attribute[1]
    const value = attribute[2]
    if (!MARKER_ATTRIBUTE_NAMES.has(name)) {
      errors.push(`Unknown section marker attribute "${name}". Allowed attributes are "id" and "after".`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`Section marker attribute "${name}" is repeated.`)
      continue
    }
    seen.add(name)
    if (name === 'id') {
      id = value.trim()
    } else {
      after = value.split(',').map((entry) => entry.trim()).filter(Boolean)
    }
  }

  return { id, after, errors }
}

export function isSectionMarkerLine(line: string): boolean {
  return SECTION_MARKER_REGEX.test(line.trim())
}

interface SectionMarkerScan {
  lines: string[]
  inFence: boolean[]
  markerIndices: number[]
  markers: Map<number, ParsedSectionMarker>
  markerErrors: string[]
}

function scanSectionMarkers(planText: string): SectionMarkerScan {
  const startMatch = planText.match(/<!--\s*forge-plan:start\s*-->\s*\n?/)
  const lineOffset = startMatch ? (startMatch[0].match(/\n/g) ?? []).length : 0
  const text = planText
    .replace(/<!--\s*forge-plan:start\s*-->\s*\n?/, '')
    .replace(/\n?\s*<!--\s*forge-plan:end\s*-->/, '')

  const rawLines = text.split('\n')

  const rawInFence = computeFenceMask(rawLines)

  const kept: { line: string; number: number }[] = []
  for (let i = 0; i < rawLines.length; i++) {
    if (!rawInFence[i] && LEGACY_SECTION_PAIR_REGEX.test(rawLines[i].trim())) continue
    kept.push({ line: rawLines[i], number: i + 1 + lineOffset })
  }
  const lines = kept.map((entry) => entry.line)
  const lineNumbers = kept.map((entry) => entry.number)

  const inFence = computeFenceMask(lines)
  const markerIndices: number[] = []
  const markers = new Map<number, ParsedSectionMarker>()
  const markerErrors: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue
    const parsed = parseSectionMarker(lines[i])
    if (!parsed) continue
    if (isSectionMarkerLine(lines[i])) {
      markerIndices.push(i)
      markers.set(i, parsed)
    }
    for (const error of parsed.errors) {
      markerErrors.push(`Plan line ${lineNumbers[i]}: ${error}`)
    }
  }

  return { lines, inFence, markerIndices, markers, markerErrors }
}

export interface PlanSection extends ParsedSection {
  id: string
  after: string[]
}

export interface PlanDecomposition {
  sections: PlanSection[]
  markerCount: number
  graphErrors: string[]
}

export function decomposePlanSections(planText: string, opts?: { maxSections?: number }): PlanDecomposition {
  const maxSections = opts?.maxSections ?? MAX_TOTAL_SECTIONS
  const { lines, inFence, markerIndices, markers, markerErrors } = scanSectionMarkers(planText)

  if (markerIndices.length === 0) return { sections: [], markerCount: 0, graphErrors: markerErrors }

  const allSections: PlanSection[] = []
  let previousId: string | undefined

  for (let i = 0; i < markerIndices.length; i++) {
    const startLine = markerIndices[i] + 1
    const nextMarker = i + 1 < markerIndices.length ? markerIndices[i + 1] : lines.length

    let endLine = nextMarker
    for (let j = startLine; j < nextMarker; j++) {
      const trimmed = lines[j].trim()
      if (!inFence[j] && STOP_HEADINGS.some(h => trimmed.startsWith(h))) {
        endLine = j
        break
      }
    }

    const bodyLines = lines.slice(startLine, endLine)
    const content = bodyLines.join('\n').trim()
    if (content.length === 0) continue

    let title = `Section ${allSections.length + 1}`
    for (const line of bodyLines) {
      const m = line.match(/^##\s+(.+)$/)
      if (m) {
        const candidate = stripLeadingStructuralOrdinal(m[1].trim())
        if (candidate.length === 0) continue
        if (STRUCTURAL_TITLES.has(candidate.toLowerCase())) continue
        title = truncateAtWordBoundary(candidate, 60)
        break
      }
    }

    const marker = markers.get(markerIndices[i])
    const id = marker?.id ?? generatedSectionId(allSections.length)
    const after = marker?.after ?? (previousId === undefined ? [] : [previousId])
    allSections.push({
      index: allSections.length,
      title,
      content,
      startLine,
      endLine,
      id,
      after,
    })
    previousId = id
  }

  const graphErrors = [
    ...markerErrors,
    ...validateSectionGraph(
      allSections.map((section) => ({ index: section.index, id: section.id, after: section.after })),
      { maxSections },
    ),
  ]

  return {
    sections: allSections.slice(0, maxSections),
    markerCount: markerIndices.length,
    graphErrors,
  }
}

export function decomposeDeterministically(planText: string, opts?: { maxSections?: number }): PlanSection[] {
  return decomposePlanSections(planText, opts).sections
}
