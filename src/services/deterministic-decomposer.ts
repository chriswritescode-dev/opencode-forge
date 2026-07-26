import type { ParsedSection } from '../utils/section-capture'
import { computeFenceMask } from '../utils/markdown-fences'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'

export const SECTION_MARKER_REGEX = /^<!--\s*forge-section\s*-->$/
const LEGACY_SECTION_PAIR_REGEX = /^<!--\s*forge-section:(?:start|end)\s*-->$/
const STOP_HEADINGS = ['## Verification', '## Decisions', '## Conventions', '## Key Context']
const STRUCTURAL_TITLES = new Set(['verification', 'decisions', 'conventions', 'key context', 'objective', 'loop name'])

interface SectionMarkerScan {
  lines: string[]
  inFence: boolean[]
  markerIndices: number[]
}

/**
 * The canonical section-marker scan: strips the plan wrapper and legacy paired
 * markers, then locates every unfenced `<!-- forge-section -->` line. Both
 * `decomposeDeterministically` and `countSectionMarkers` read it so a reported
 * marker count can never disagree with what the decomposer splits on.
 */
function scanSectionMarkers(planText: string): SectionMarkerScan {
  const text = planText
    .replace(/<!--\s*forge-plan:start\s*-->\s*\n?/, '')
    .replace(/\n?\s*<!--\s*forge-plan:end\s*-->/, '')

  const rawLines = text.split('\n')

  // Track fence state to skip markers inside ``` blocks
  const rawInFence = computeFenceMask(rawLines)

  // Strip legacy paired markers from output (but they do NOT trigger sectioning)
  const lines = rawLines.map((l, i) =>
    !rawInFence[i] && LEGACY_SECTION_PAIR_REGEX.test(l.trim()) ? null : l
  ).filter((l): l is string => l !== null)
  // Re-scan fence state aligned with the filtered lines array.
  const inFence = computeFenceMask(lines)

  const markerIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!inFence[i] && SECTION_MARKER_REGEX.test(lines[i].trim())) {
      markerIndices.push(i)
    }
  }

  return { lines, inFence, markerIndices }
}

export interface PlanDecomposition {
  sections: ParsedSection[]
  /**
   * Unfenced `<!-- forge-section -->` markers found, before the cap and before
   * empty-body skipping. Reported from the same scan that produced `sections`,
   * so a marker count can never disagree with what was split on.
   */
  markerCount: number
}

/**
 * Decomposes a plan and reports how many markers were seen. Callers that need
 * both counts use this so they do not have to scan the plan twice.
 */
export function decomposePlanSections(planText: string, opts?: { maxSections?: number }): PlanDecomposition {
  const maxSections = opts?.maxSections ?? MAX_TOTAL_SECTIONS
  const { lines, inFence, markerIndices } = scanSectionMarkers(planText)

  if (markerIndices.length === 0) return { sections: [], markerCount: 0 }

  const sections: ParsedSection[] = []

  for (let i = 0; i < markerIndices.length && sections.length < maxSections; i++) {
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

    let title = `Section ${sections.length + 1}`
    for (const line of bodyLines) {
      const m = line.match(/^##\s+(.+)$/)
      if (m) {
        const candidate = m[1].trim()
        if (STRUCTURAL_TITLES.has(candidate.toLowerCase())) continue
        title = candidate.substring(0, 60)
        break
      }
    }

    sections.push({ index: sections.length, title, content })
  }

  return { sections, markerCount: markerIndices.length }
}

/** Sections only. The common case; see `decomposePlanSections` for the count. */
export function decomposeDeterministically(planText: string, opts?: { maxSections?: number }): ParsedSection[] {
  return decomposePlanSections(planText, opts).sections
}