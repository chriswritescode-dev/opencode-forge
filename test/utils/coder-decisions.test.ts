import { describe, it, expect } from 'vitest'
import {
  CODER_DECISIONS_START_MARKER,
  CODER_DECISIONS_END_MARKER,
  parseCoderDecisions,
  CODER_DECISIONS_INSTRUCTION,
} from '../../src/utils/coder-decisions'

describe('parseCoderDecisions', () => {
  it('returns inner text for a well-formed block (multiline preserved)', () => {
    const text = `some text before
${CODER_DECISIONS_START_MARKER}
### Decisions
- decision 1
### Verification
- pnpm test
### Notes for auditor
- none
${CODER_DECISIONS_END_MARKER}
some text after`
    const result = parseCoderDecisions(text)
    expect(result).toBe(`### Decisions
- decision 1
### Verification
- pnpm test
### Notes for auditor
- none`)
  })

  it('returns null when markers absent', () => {
    expect(parseCoderDecisions('no markers here')).toBeNull()
  })

  it('returns null when inner is empty/whitespace', () => {
    const text = `${CODER_DECISIONS_START_MARKER}   ${CODER_DECISIONS_END_MARKER}`
    expect(parseCoderDecisions(text)).toBeNull()
  })

  it('takes the first block when duplicated', () => {
    const text = `first: ${CODER_DECISIONS_START_MARKER}content1${CODER_DECISIONS_END_MARKER}
second: ${CODER_DECISIONS_START_MARKER}content2${CODER_DECISIONS_END_MARKER}`
    const result = parseCoderDecisions(text)
    expect(result).toBe('content1')
  })

  it('returns null for null input', () => {
    expect(parseCoderDecisions(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseCoderDecisions(undefined)).toBeNull()
  })
})

describe('CODER_DECISIONS_INSTRUCTION', () => {
  it('contains both markers', () => {
    expect(CODER_DECISIONS_INSTRUCTION).toContain(CODER_DECISIONS_START_MARKER)
    expect(CODER_DECISIONS_INSTRUCTION).toContain(CODER_DECISIONS_END_MARKER)
  })

  it('round-trips with parseCoderDecisions', () => {
    const parsed = parseCoderDecisions(CODER_DECISIONS_INSTRUCTION)
    expect(parsed).not.toBeNull()
    expect(parsed).toContain('### Decisions')
    expect(parsed).toContain('### Verification')
    expect(parsed).toContain('### Notes for auditor')
  })

  it('template lists the compact evidence requirements for each check', () => {
    const parsed = parseCoderDecisions(CODER_DECISIONS_INSTRUCTION)
    expect(parsed).toContain('the exact command, the worktree-relative working directory, and the pass/fail/not-run outcome')
    expect(parsed).toContain('relevant non-secret setup only; do not paste credentials or huge logs')
    expect(parsed).toContain('whether any source/test/config changes occurred after those commands ran')
    expect(parsed).toContain('which regression check covers each fixed finding, where applicable')
  })

  it('parses a filled evidence-rich block verbatim (free-text contract)', () => {
    const evidence = `### Decisions
- Chose approach X
### Verification
- FOO=bar pnpm test from repo root — pass
- relevant setup: DATABASE_URL points at the test db
- no source/test/config changes occurred afterward
- src/test.ts:1 → pnpm test --project node test/foo.test.ts
### Notes for auditor
- none`
    const text = `${CODER_DECISIONS_START_MARKER}\n${evidence}\n${CODER_DECISIONS_END_MARKER}`
    expect(parseCoderDecisions(text)).toBe(evidence)
  })

  it('a block without the Verification heading still parses (no evidence, no error)', () => {
    const text = `${CODER_DECISIONS_START_MARKER}\n### Decisions\n- partial notes only\n${CODER_DECISIONS_END_MARKER}`
    expect(parseCoderDecisions(text)).toContain('partial notes only')
  })
})
