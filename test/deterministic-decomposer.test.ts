import { describe, test, expect } from 'vitest'
import {
  decomposeDeterministically,
  decomposePlanSections,
  isSectionMarkerLine,
  parseSectionMarker,
} from '../src/services/deterministic-decomposer'
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

  test('strips the leading structural ordinal from a Phase heading', () => {
    const plan = [
      '<!-- forge-section -->', '## Phase 2: Remove the goal tools', 'a',
      '<!-- forge-section -->', '## Step 3 - Update docs', 'b',
      '<!-- forge-section -->', '## Section 4) Run tests', 'c',
    ].join('\n')
    const r = decomposeDeterministically(plan)
    expect(r.map((s) => s.title)).toEqual(['Remove the goal tools', 'Update docs', 'Run tests'])
  })

  test('keeps a heading with a numeric-only phase marker', () => {
    const plan = ['<!-- forge-section -->', '## Phase 1', 'body'].join('\n')
    expect(decomposeDeterministically(plan)[0].title).toBe('Phase 1')
  })

  test('skips a structural heading whose ordinal strip leaves a structural title', () => {
    const plan = ['<!-- forge-section -->', '## Phase 1: Verification', '- cmd', 'body'].join('\n')
    expect(decomposeDeterministically(plan)[0].title).toBe('Section 1')
  })

  test('title truncated to 60 chars', () => {
    const plan = '<!-- forge-section -->\n## ' + 'A'.repeat(100) + '\nbody'
    const r = decomposeDeterministically(plan)
    expect(r[0].title).toHaveLength(60)
    expect(r[0].title).toBe('A'.repeat(60))
  })

  test('title truncation lands on a word boundary, never mid-word', () => {
    const plan = '<!-- forge-section -->\n## Update docs, regenerate API docs, and run the full validation suite\nbody'
    const r = decomposeDeterministically(plan)
    expect(r[0].title.length).toBeLessThanOrEqual(60)
    expect(r[0].title).toBe('Update docs, regenerate API docs, and run the full')
    expect(plan.split('\n')[1]).toContain(r[0].title)
  })

  test('a dotted phase ordinal is stripped whole', () => {
    const r = decomposeDeterministically('<!-- forge-section -->\n## Phase 2.1: Setup\nbody')
    expect(r[0].title).toBe('Setup')
  })

  test('a word ending exactly at the 60-char cap is kept whole', () => {
    const title = `${'x'.repeat(55)} abcd`
    const r = decomposeDeterministically(`<!-- forge-section -->\n## ${title} more words\nbody`)
    expect(r[0].title).toBe(title)
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

describe('section marker attributes', () => {
  test('attribute-free plans get generated ids and a predecessor chain', () => {
    const plan = [
      '<!-- forge-section -->', '## A', 'a',
      '<!-- forge-section -->', '## B', 'b',
      '<!-- forge-section -->', '## C', 'c',
    ].join('\n')
    const r = decomposePlanSections(plan)
    expect(r.graphErrors).toEqual([])
    expect(r.sections.map((s) => [s.id, s.after])).toEqual([
      ['section-1', []],
      ['section-2', ['section-1']],
      ['section-3', ['section-2']],
    ])
  })

  test('parses id and after, including a diamond graph', () => {
    const plan = [
      '<!-- forge-section id="a" -->', '## A', 'a',
      '<!-- forge-section id="b" after="a" -->', '## B', 'b',
      '<!-- forge-section id="c" after="a" -->', '## C', 'c',
      '<!-- forge-section id="d" after="b,c" -->', '## D', 'd',
    ].join('\n')
    const r = decomposePlanSections(plan)
    expect(r.graphErrors).toEqual([])
    expect(r.sections.map((s) => [s.id, s.after])).toEqual([
      ['a', []],
      ['b', ['a']],
      ['c', ['a']],
      ['d', ['b', 'c']],
    ])
  })

  test('an explicit empty after attribute means no dependencies', () => {
    const plan = [
      '<!-- forge-section id="a" -->', '## A', 'a',
      '<!-- forge-section id="b" after="" -->', '## B', 'b',
    ].join('\n')
    const r = decomposePlanSections(plan)
    expect(r.graphErrors).toEqual([])
    expect(r.sections.map((s) => s.after)).toEqual([[], []])
  })

  test('a marker id supplies the default for the next section', () => {
    const plan = [
      '<!-- forge-section id="custom" -->', '## A', 'a',
      '<!-- forge-section -->', '## B', 'b',
    ].join('\n')
    expect(decomposeDeterministically(plan).map((s) => [s.id, s.after])).toEqual([
      ['custom', []],
      ['section-2', ['custom']],
    ])
  })

  test('reports an invalid id', () => {
    const r = decomposePlanSections('<!-- forge-section id="Bad_Id" -->\n## A\na')
    expect(r.graphErrors).toEqual([
      'Section 1 id "Bad_Id" is invalid: use lowercase letters, digits, and hyphens (at most 64 characters), starting with a letter or digit.',
    ])
  })

  test('reports a duplicate id', () => {
    const plan = [
      '<!-- forge-section id="a" -->', '## A', 'a',
      '<!-- forge-section id="a" -->', '## B', 'b',
    ].join('\n')
    expect(decomposePlanSections(plan).graphErrors).toEqual([
      'Section 2 reuses id "a" already used by section 1; ids must be unique.',
    ])
  })

  test('reports an unknown after id', () => {
    const r = decomposePlanSections('<!-- forge-section id="b" after="missing" -->\n## B\nb')
    expect(r.graphErrors).toEqual([
      'Section 1 ("b") depends on unknown id "missing".',
    ])
  })

  test('reports a self dependency', () => {
    const r = decomposePlanSections('<!-- forge-section id="a" after="a" -->\n## A\na')
    expect(r.graphErrors).toEqual([
      'Section 1 ("a") depends on "a", which is section 1: a section may only depend on sections above it. Move "a" above "a".',
    ])
  })

  test('reports a forward dependency', () => {
    const plan = [
      '<!-- forge-section id="a" after="b" -->', '## A', 'a',
      '<!-- forge-section id="b" -->', '## B', 'b',
    ].join('\n')
    expect(decomposePlanSections(plan).graphErrors).toEqual([
      'Section 1 ("a") depends on "b", which is section 2: a section may only depend on sections above it. Move "b" above "a".',
    ])
  })

  test('reports an unknown attribute by plan line while keeping the section', () => {
    const r = decomposePlanSections('<!-- forge-section id="a" foo="x" -->\n## A\na')
    expect(r.graphErrors).toEqual([
      'Plan line 1: Unknown section marker attribute "foo". Allowed attributes are "id" and "after".',
    ])
    expect(r.sections.map((s) => s.id)).toEqual(['a'])
  })

  test('reports a repeated attribute by plan line', () => {
    const r = decomposePlanSections('<!-- forge-section id="a" id="b" -->\n## A\na')
    expect(r.graphErrors).toEqual([
      'Plan line 1: Section marker attribute "id" is repeated.',
    ])
    expect(r.sections.map((s) => s.id)).toEqual(['a'])
  })

  test('reports a malformed marker by plan line and does not split on it', () => {
    const plan = [
      '<!-- forge-section id=a -->',
      '<!-- forge-section -->', '## Real', 'body',
    ].join('\n')
    const r = decomposePlanSections(plan)
    expect(r.graphErrors).toEqual([
      'Plan line 1: Malformed section marker: expected <!-- forge-section id="..." after="..." -->',
    ])
    expect(r.sections.map((s) => s.title)).toEqual(['Real'])
  })

  test('reports the cap even when the returned sections are truncated', () => {
    const plan = Array.from({ length: MAX_TOTAL_SECTIONS + 2 }, (_, i) =>
      `<!-- forge-section -->\n## Phase ${i + 1}\nbody`,
    ).join('\n')
    const r = decomposePlanSections(plan)
    expect(r.sections).toHaveLength(MAX_TOTAL_SECTIONS)
    expect(r.graphErrors).toEqual([
      `${MAX_TOTAL_SECTIONS + 2} sections exceed the cap of ${MAX_TOTAL_SECTIONS}: consolidate phases.`,
    ])
  })

  test('applies a custom cap to both the returned sections and the cap error', () => {
    const plan = Array.from({ length: 5 }, (_, i) => `<!-- forge-section -->\n## Phase ${i + 1}\nbody`).join('\n')
    const r = decomposePlanSections(plan, { maxSections: 3 })
    expect(r.sections).toHaveLength(3)
    expect(r.graphErrors).toEqual(['5 sections exceed the cap of 3: consolidate phases.'])
  })

  test('empty-body markers do not consume ids or become predecessors', () => {
    const plan = [
      '<!-- forge-section id="a" -->', '## A', 'a',
      '<!-- forge-section id="empty" -->',
      '<!-- forge-section id="b" -->', '## B', 'b',
    ].join('\n')
    expect(decomposeDeterministically(plan).map((s) => [s.id, s.after])).toEqual([
      ['a', []],
      ['b', ['a']],
    ])
  })
})

describe('parseSectionMarker', () => {
  test('returns null for non-markers and legacy pairs', () => {
    expect(parseSectionMarker('## Phase 1')).toBeNull()
    expect(parseSectionMarker('<!-- forge-section:start -->')).toBeNull()
  })

  test('tolerates surrounding whitespace and reports attributes', () => {
    expect(parseSectionMarker('  <!--  forge-section id="a" after="b,c" -->  ')).toEqual({
      id: 'a',
      after: ['b', 'c'],
      errors: [],
    })
  })

  test('isSectionMarkerLine matches only valid markers', () => {
    expect(isSectionMarkerLine('<!-- forge-section -->')).toBe(true)
    expect(isSectionMarkerLine('<!-- forge-section id="a" after="b" -->')).toBe(true)
    expect(isSectionMarkerLine('<!-- forge-section id=a -->')).toBe(false)
    expect(isSectionMarkerLine('## Phase 1')).toBe(false)
  })
})