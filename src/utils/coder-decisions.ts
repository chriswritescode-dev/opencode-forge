export const CODER_DECISIONS_START_MARKER = '<!-- coder-decisions:start -->'
export const CODER_DECISIONS_END_MARKER = '<!-- coder-decisions:end -->'

export function parseCoderDecisions(text: string | null | undefined): string | null {
  if (!text) return null

  const startIdx = text.indexOf(CODER_DECISIONS_START_MARKER)
  if (startIdx === -1) return null

  const contentStart = startIdx + CODER_DECISIONS_START_MARKER.length
  const endIdx = text.indexOf(CODER_DECISIONS_END_MARKER, contentStart)
  if (endIdx === -1) return null

  const inner = text.slice(contentStart, endIdx).trim()
  return inner.length > 0 ? inner : null
}

export const CODER_DECISIONS_INSTRUCTION: string = `\n\n---
## Required: decisions for the auditor
End your response with this exact block so the auditor can evaluate your work (especially intentional choices and how to reproduce passing verification):

${CODER_DECISIONS_START_MARKER}
### Decisions
- key implementation decisions and why
### Verification
- exact commands you ran and how to reproduce a passing result (include required env vars, e.g. \`FOO=bar pnpm test\`)
### Notes for auditor
- anything needed to judge correctness, or "none"
${CODER_DECISIONS_END_MARKER}`
