import type { ParsedSection } from '../utils/section-capture'

export function decomposeDeterministically(planText: string, opts?: { maxSections?: number }): ParsedSection[] {
  const maxSections = opts?.maxSections ?? 12
  const text = planText.replace(/<!--\s*forge-plan:start\s*-->\s*\n?/, '').replace(/\n?\s*<!--\s*forge-plan:end\s*-->/, '')
  const lines = text.split('\n')

  const sections: ParsedSection[] = []
  const phaseRegex = /^##\s+Phase\s+(\d+):\s*(.+)$/
  const phaseIndices: { lineIdx: number; phaseNum: number; title: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(phaseRegex)
    if (m) {
      phaseIndices.push({ lineIdx: i, phaseNum: parseInt(m[1], 10), title: m[2].trim() })
    }
  }

  if (phaseIndices.length === 0) return []

  const stopHeadings = ['## Verification', '## Decisions', '## Conventions', '## Key Context']

  for (let i = 0; i < phaseIndices.length && sections.length < maxSections; i++) {
    const startLine = phaseIndices[i].lineIdx
    const endLine = i + 1 < phaseIndices.length
      ? phaseIndices[i + 1].lineIdx
      : lines.length

    const bodyLines: string[] = []
    for (let j = startLine; j < endLine; j++) {
      if (j > startLine && stopHeadings.some(h => lines[j].trim().startsWith(h))) break
      bodyLines.push(lines[j])
    }
    const content = bodyLines.join('\n').trim()
    const title = phaseIndices[i].title.substring(0, 60)
    sections.push({ index: i, title, content })
  }

  return sections
}
