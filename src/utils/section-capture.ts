export const SECTION_START_MARKER = '<!-- forge-section:start -->'
export const SECTION_END_MARKER = '<!-- forge-section:end -->'

export interface ParsedSection {
  index: number
  title: string
  content: string
}

// Re-export decomposeDeterministically for consumers (avoids direct dependency on deterministic-decomposer)
export { decomposeDeterministically } from '../services/deterministic-decomposer'

function deriveTitle(innerLines: string[], fallbackIndex: number): string {
  for (const line of innerLines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const headingMatch = trimmed.match(/^##\s+(?:Section\s+\d+:\s*)?(.+)$/)
    if (headingMatch) {
      return headingMatch[1].trim().substring(0, 60)
    }

    const stripped = trimmed.replace(/^[#\-*\s]+/, '').trim().substring(0, 60)
    return stripped.length > 0 ? stripped : `Section ${fallbackIndex}`
  }
  return `Section ${fallbackIndex}`
}

export function extractSections(text: string, opts?: { maxSections?: number }): ParsedSection[] {
  const maxSections = opts?.maxSections ?? 12
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  const sections: ParsedSection[] = []
  let i = 0
  while (i < lines.length && sections.length < maxSections) {
    if (lines[i].trim() !== SECTION_START_MARKER) { i++; continue }
    let j = i + 1
    while (j < lines.length) {
      const t = lines[j].trim()
      if (t === SECTION_START_MARKER) return [] // nested, reject
      if (t === SECTION_END_MARKER) break
      j++
    }
    if (j >= lines.length) return [] // unterminated
    const inner = lines.slice(i + 1, j)
    const content = inner.join('\n').trim()
    if (content.length === 0) { i = j + 1; continue }
    const title = deriveTitle(inner, sections.length)
    sections.push({ index: sections.length, title, content })
    i = j + 1
  }
  return sections
}
