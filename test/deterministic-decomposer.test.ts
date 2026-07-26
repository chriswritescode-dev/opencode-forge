import { describe, test, expect } from 'vitest'
import { decomposeDeterministically, decomposePlanSections } from '../src/services/deterministic-decomposer'
import { MAX_TOTAL_SECTIONS } from '../src/constants/loop'

describe('decomposePlanSections', () => {
  test('markerCount reports every unfenced marker, independent of cap and empty bodies', () => {
    const plan30 = Array.from({ length: 30 }, () => '<!-- forge-section -->\nbody').join('\n')
    const capped = decomposePlanSections(plan30)
    expect(capped.markerCount).toBe(30)
    expect(capped.sections).toHaveLength(MAX_TOTAL_SECTIONS)

    // Empty bodies are skipped as sections but still counted as markers.
    const withEmpty = ['<!-- forge-section -->', '<!-- forge-section -->', '## Phase', 'body'].join('\n')
    const r = decomposePlanSections(withEmpty)
    expect(r.markerCount).toBe(2)
    expect(r.sections).toHaveLength(1)

    // Fenced markers are neither counted nor split on.
    const fenced = ['<!-- forge-section -->', '## Phase', '```ts', '<!-- forge-section -->', '```', 'body'].join('\n')
    expect(decomposePlanSections(fenced).markerCount).toBe(1)

    expect(decomposePlanSections('no markers').markerCount).toBe(0)
  })

  test('uncapped sections are the superset the capped run truncates', () => {
    const plan30 = Array.from({ length: 30 }, (_, i) => `<!-- forge-section -->\n## Phase ${i + 1}\nbody`).join('\n')
    const uncapped = decomposePlanSections(plan30, { maxSections: Number.MAX_SAFE_INTEGER }).sections
    expect(uncapped).toHaveLength(30)
    expect(uncapped.slice(0, MAX_TOTAL_SECTIONS)).toEqual(decomposeDeterministically(plan30))
  })
})

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

  test(`respects maxSections cap (default ${MAX_TOTAL_SECTIONS})`, () => {
    const plan20 = Array.from({ length: 20 }, () => '<!-- forge-section -->\nbody').join('\n')
    expect(decomposeDeterministically(plan20)).toHaveLength(20)
    const plan30 = Array.from({ length: 30 }, () => '<!-- forge-section -->\nbody').join('\n')
    expect(decomposeDeterministically(plan30)).toHaveLength(MAX_TOTAL_SECTIONS)
    expect(decomposeDeterministically(plan30, { maxSections: 3 })).toHaveLength(3)
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