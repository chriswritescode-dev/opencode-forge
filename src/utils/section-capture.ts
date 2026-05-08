export interface ParsedSection {
  index: number
  title: string
  content: string
}

export function extractSections(text: string, opts?: { maxSections?: number }): ParsedSection[] {
  const maxSections = opts?.maxSections ?? 12
  const regex = /<!--\s*forge-section:start\s+index=(\d+)\s+title="([^"]*)"\s*-->\n([\s\S]*?)\n<!--\s*forge-section:end\s*-->/g
  const sections: ParsedSection[] = []
  const seenIndexes = new Set<number>()

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (sections.length >= maxSections) break

    const index = parseInt(match[1], 10)
    const rawTitle = match[2].substring(0, 60)
    const content = match[3].trim()

    if (seenIndexes.has(index) || index !== sections.length) {
      return []
    }

    seenIndexes.add(index)
    sections.push({ index, title: rawTitle, content })
  }

  if (sections.length === 0) return []

  return sections
}
