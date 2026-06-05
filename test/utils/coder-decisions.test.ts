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
})
