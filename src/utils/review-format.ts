import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'

/**
 * The single rendering of persisted review findings. Findings are the only
 * channel that carries remediation detail from the auditor to the coding agent,
 * so every surface that shows a finding — the `review-read` tool and every
 * coder prompt — formats it here. `includeScope` adds the loop/section
 * attribution that only matters when reading findings across scopes.
 */
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
