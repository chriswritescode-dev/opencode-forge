import { describe, test, expect } from 'vitest'
import { decomposeDeterministically } from '../src/services/deterministic-decomposer'

describe('decomposeDeterministically', () => {
  test('returns empty array when no section markers found', () => {
    expect(decomposeDeterministically('## Phase 1: Setup\n- step')).toEqual([])
    expect(decomposeDeterministically('Just prose')).toEqual([])
    expect(decomposeDeterministically('')).toEqual([])
  })

  test('splits on <!-- forge-section --> markers', () => {
    const plan = ['<!-- forge-section -->', '## Setup', 'a', '<!-- forge-section -->', '## Build', 'b'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(2)
    expect(r[0].title).toBe('Setup'); expect(r[0].index).toBe(0)
    expect(r[1].title).toBe('Build'); expect(r[1].index).toBe(1)
    expect(r[0].content).toContain('a'); expect(r[1].content).toContain('b')
    expect(r[0].content).not.toContain('forge-section')
  })

  test('extracts title from first `## <heading>` inside section', () => {
    const plan = ['<!-- forge-section -->', '## Add auth validation', '### Files', '- src/a.ts'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r[0].title).toBe('Add auth validation')
  })

  test('falls back to "Section N" title when no `## <heading>` inside section', () => {
    const plan = ['<!-- forge-section -->', '### Files', '- src/a.ts'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r[0].title).toBe('Section 1')
  })

  test('ignores structural `## <heading>` candidates as section titles', () => {
    const plan = ['<!-- forge-section -->', '## Verification', '- cmd', '## Real Title', 'body'].join('\n')
    const r = decomposeDeterministically(plan)
    // stops at ## Verification, so this section is empty — verify empty sections are skipped
    expect(r).toEqual([])
  })

  test('respects maxSections cap (default 12)', () => {
    const plan = Array.from({ length: 15 }, () => '<!-- forge-section -->\nbody').join('\n')
    expect(decomposeDeterministically(plan)).toHaveLength(12)
    expect(decomposeDeterministically(plan, { maxSections: 3 })).toHaveLength(3)
  })

  test('strips outer <!-- forge-plan:start/end --> markers', () => {
    const plan = '<!-- forge-plan:start -->\n<!-- forge-section -->\n## Setup\na\n<!-- forge-plan:end -->'
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('Setup')
    expect(r[0].content).not.toContain('forge-plan')
  })

  test('stops section at ## Verification', () => {
    const plan = ['<!-- forge-section -->', '## Setup', '- a', '## Verification', '- check'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].content).toContain('- a')
    expect(r[0].content).not.toContain('Verification')
    expect(r[0].content).not.toContain('- check')
  })

  test('stops section at ## Decisions', () => {
    const plan = ['<!-- forge-section -->', '## Setup', '- a', '## Decisions', '- decide'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].content).toContain('- a')
    expect(r[0].content).not.toContain('Decisions')
  })

  test('stops section at ## Conventions', () => {
    const plan = ['<!-- forge-section -->', '## Setup', '- a', '## Conventions', '- conv'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].content).toContain('- a')
    expect(r[0].content).not.toContain('Conventions')
  })

  test('stops section at ## Key Context', () => {
    const plan = ['<!-- forge-section -->', '## Setup', '- a', '## Key Context', '- ctx'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].content).toContain('- a')
    expect(r[0].content).not.toContain('Key Context')
  })

  test('skips empty section bodies between adjacent markers', () => {
    const plan = ['<!-- forge-section -->', '<!-- forge-section -->', '## Real', 'body'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('Real')
    expect(r[0].index).toBe(0) // index based on emitted sections, not marker count
  })

  test('legacy <!-- forge-section:start --> and <!-- forge-section:end --> are stripped but do NOT trigger sectioning', () => {
    const plan = ['<!-- forge-section:start -->', '## Phase 1: Setup', 'a', '<!-- forge-section:end -->'].join('\n')
    expect(decomposeDeterministically(plan)).toEqual([])
  })

  test('title truncated to 60 chars', () => {
    const plan = '<!-- forge-section -->\n## ' + 'A'.repeat(100) + '\nbody'
    const r = decomposeDeterministically(plan)
    expect(r[0].title).toHaveLength(60)
    expect(r[0].title).toBe('A'.repeat(60))
  })

  test('marker tolerates surrounding whitespace', () => {
    const plan = '<!--  forge-section  -->\n## Setup\nbody'
    expect(decomposeDeterministically(plan)).toHaveLength(1)
  })

  test('marker inside fenced code block is ignored', () => {
    const plan = ['```', '<!-- forge-section -->', '```', '<!-- forge-section -->', '## Real', 'body'].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('Real')
  })
})