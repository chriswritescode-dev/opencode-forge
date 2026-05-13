import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../utils/section-summary'

export { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER }

export function parseSectionSummary(text: string): { done: string | null; deviations: string | null; followUps: string | null } | null {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  let startLine = -1
  let endLine = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === SECTION_SUMMARY_START_MARKER) {
      startLine = i
      break
    }
  }

  if (startLine !== -1) {
    for (let i = startLine + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === SECTION_SUMMARY_END_MARKER) {
        endLine = i
        break
      }
    }
  }

  if (startLine === -1 || endLine === -1 || endLine <= startLine) return null

  const innerLines = lines.slice(startLine + 1, endLine)
  const sections: Record<string, string[]> = {}
  let currentSection: string | null = null

  for (const line of innerLines) {
    const trimmed = line.trim()
    const knownHeadingMatch = trimmed.match(/^###\s+(Done|Deviations|Follow-ups)\s*$/)
    if (knownHeadingMatch) {
      currentSection = knownHeadingMatch[1]
      sections[currentSection] = []
    } else if (/^###\s+/.test(trimmed)) {
      currentSection = null
    } else if (currentSection && trimmed.length > 0) {
      sections[currentSection].push(trimmed)
    }
  }

  const done = sections['Done']?.join('\n').trim() || null
  const deviations = sections['Deviations']?.join('\n').trim() || null
  const followUps = sections['Follow-ups']?.join('\n').trim() || null

  return { done, deviations, followUps }
}
