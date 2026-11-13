import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'

export function formatFindingDetails(findings: ReviewFindingRow[], opts?: { includeScope?: boolean }): string {
  return findings.map((finding) => {
    const lines = [
      `- \`${finding.file}:${finding.line}\` (${finding.severity})`,
      `  - Description: ${finding.description}`,
    ]
    if (finding.scenario) {
      lines.push(`  - Scenario: ${finding.scenario}`)
    }
    if (opts?.includeScope) {
      if (finding.loopName) lines.push(`  - Loop: ${finding.loopName}`)
      if (finding.sectionIndex !== null) lines.push(`  - Section: ${String(finding.sectionIndex)}`)
    }
    return lines.join('\n')
  }).join('\n\n')
}
