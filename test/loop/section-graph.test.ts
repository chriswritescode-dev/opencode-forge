import { describe, test, expect } from 'vitest'
import {
  SECTION_ID_PATTERN,
  ancestorSectionIds,
  generatedSectionId,
  isLastOpenSectionIndex,
  readySections,
  selectNextSection,
  selectSectionsToStart,
  validateSectionGraph,
  type SectionGraphNode,
  type SectionGraphRow,
} from '../../src/loop/section-graph'
import { MAX_TOTAL_SECTIONS } from '../../src/constants/loop'

function node(index: number, id: string, after: string[] = []): SectionGraphNode {
  return { index, id, after }
}

function row(
  sectionIndex: number,
  sectionId: string,
  dependsOn: string[] = [],
  status = 'pending',
): SectionGraphRow {
  return { sectionIndex, sectionId, dependsOn, status }
}

describe('section ids', () => {
  test('accepts lowercase ids and rejects invalid shapes', () => {
    expect(SECTION_ID_PATTERN.test('section-1')).toBe(true)
    expect(SECTION_ID_PATTERN.test('a')).toBe(true)
    expect(SECTION_ID_PATTERN.test('a'.repeat(64))).toBe(true)
    expect(SECTION_ID_PATTERN.test('A')).toBe(false)
    expect(SECTION_ID_PATTERN.test('-a')).toBe(false)
    expect(SECTION_ID_PATTERN.test('a'.repeat(65))).toBe(false)
    expect(SECTION_ID_PATTERN.test('a_b')).toBe(false)
  })

  test('generatedSectionId numbers from one', () => {
    expect(generatedSectionId(0)).toBe('section-1')
    expect(generatedSectionId(23)).toBe('section-24')
  })
})

describe('validateSectionGraph', () => {
  test('accepts a diamond graph', () => {
    const nodes = [
      node(0, 'a'),
      node(1, 'b', ['a']),
      node(2, 'c', ['a']),
      node(3, 'd', ['b', 'c']),
    ]
    expect(validateSectionGraph(nodes)).toEqual([])
  })

  test('reports an invalid id', () => {
    expect(validateSectionGraph([node(0, 'Bad_Id')])).toEqual([
      'Section 1 id "Bad_Id" is invalid: use lowercase letters, digits, and hyphens (at most 64 characters), starting with a letter or digit.',
    ])
  })

  test('reports a duplicate id against its first use', () => {
    const nodes = [node(0, 'a'), node(1, 'b', ['a']), node(2, 'a', ['b'])]
    expect(validateSectionGraph(nodes)).toEqual([
      'Section 3 reuses id "a" already used by section 1; ids must be unique.',
    ])
  })

  test('reports an unknown dependency', () => {
    const nodes = [node(0, 'a'), node(1, 'b', ['missing'])]
    expect(validateSectionGraph(nodes)).toEqual([
      'Section 2 ("b") depends on unknown id "missing".',
    ])
  })

  test('reports self and forward dependencies as a graph-order problem', () => {
    const self = [node(0, 'a', ['a'])]
    expect(validateSectionGraph(self)).toEqual([
      'Section 1 ("a") depends on "a", which is section 1: a section may only depend on sections above it. Move "a" above "a".',
    ])

    const forward = [node(0, 'a', ['b']), node(1, 'b')]
    expect(validateSectionGraph(forward)).toEqual([
      'Section 1 ("a") depends on "b", which is section 2: a section may only depend on sections above it. Move "b" above "a".',
    ])
  })

  test('reports the cap on the emitted section count', () => {
    const nodes = Array.from({ length: MAX_TOTAL_SECTIONS + 2 }, (_, index) => node(index, `s-${index}`))
    expect(validateSectionGraph(nodes)).toEqual([
      `${MAX_TOTAL_SECTIONS + 2} sections exceed the cap of ${MAX_TOTAL_SECTIONS}: consolidate phases.`,
    ])
    expect(validateSectionGraph(nodes.slice(0, 2), { maxSections: 1 })).toEqual([
      '2 sections exceed the cap of 1: consolidate phases.',
    ])
  })

  test('keeps errors in node order, ids before dependencies, then the cap', () => {
    const nodes = [node(0, 'a', ['missing']), node(1, 'a'), node(2, 'b'), node(3, 'c')]
    expect(validateSectionGraph(nodes, { maxSections: 2 })).toEqual([
      'Section 1 ("a") depends on unknown id "missing".',
      'Section 2 reuses id "a" already used by section 1; ids must be unique.',
      '4 sections exceed the cap of 2: consolidate phases.',
    ])
  })
})

describe('ancestorSectionIds', () => {
  test('returns the transitive closure without the section itself', () => {
    const rows = [
      row(0, 'a', [], 'completed'),
      row(1, 'b', ['a'], 'completed'),
      row(2, 'c', ['a'], 'completed'),
      row(3, 'd', ['b', 'c'], 'pending'),
    ]
    expect([...ancestorSectionIds(rows, 'd')].sort()).toEqual(['a', 'b', 'c'])
    expect([...ancestorSectionIds(rows, 'b')]).toEqual(['a'])
    expect([...ancestorSectionIds(rows, 'a')]).toEqual([])
    expect([...ancestorSectionIds(rows, 'unknown')]).toEqual([])
  })
})

describe('readySections and selectNextSection', () => {
  const rows = [
    row(3, 'd', ['b', 'c'], 'pending'),
    row(0, 'a', [], 'completed'),
    row(2, 'c', ['a'], 'pending'),
    row(1, 'b', ['a'], 'in_progress'),
  ]

  test('returns open sections whose dependencies are completed, by index', () => {
    expect(readySections(rows).map((r) => r.sectionId)).toEqual(['b', 'c'])
    expect(selectNextSection(rows)?.sectionId).toBe('b')
  })

  test('excludes completed sections and never treats an unresolved dependency as ready', () => {
    expect(readySections([row(0, 'a', [], 'completed')])).toEqual([])
    expect(readySections([row(0, 'a', ['missing'], 'pending')])).toEqual([])
    expect(selectNextSection([row(0, 'a', ['missing'], 'pending')])).toBeNull()
  })

  test('treats an in-progress section as open', () => {
    expect(selectNextSection([row(0, 'a', [], 'in_progress')])?.sectionId).toBe('a')
  })
})

describe('selectSectionsToStart', () => {
  const diamond = [
    row(0, 'a', [], 'completed'),
    row(1, 'b', ['a'], 'pending'),
    row(2, 'c', ['a'], 'pending'),
    row(3, 'd', ['b', 'c'], 'pending'),
  ]
  const diamondFiles: Record<string, string[]> = {
    a: ['src/a.ts'],
    b: ['src/b.ts'],
    c: ['src/c.ts'],
    d: ['src/d.ts'],
  }
  const filesOf = (r: SectionGraphRow): string[] => diamondFiles[r.sectionId] ?? []

  test('selects the diamond branches in index order while slots remain', () => {
    const picked = selectSectionsToStart({ rows: diamond, runningIds: new Set(), slots: 2, filesOf })
    expect(picked.map((r) => r.sectionId)).toEqual(['b', 'c'])
  })

  test('skips sections that are already running', () => {
    const picked = selectSectionsToStart({
      rows: diamond,
      runningIds: new Set(['b', 'c']),
      slots: 2,
      filesOf,
    })
    expect(picked).toEqual([])
  })

  test('selects the join section once both branches complete', () => {
    const rows = diamond.map((r) =>
      r.sectionId === 'b' || r.sectionId === 'c' ? { ...r, status: 'completed' } : r,
    )
    const picked = selectSectionsToStart({ rows, runningIds: new Set(), slots: 2, filesOf })
    expect(picked.map((r) => r.sectionId)).toEqual(['d'])
  })

  test('never starts overlapping file lists together', () => {
    const rows = [
      row(0, 'a', [], 'completed'),
      row(1, 'b', ['a'], 'pending'),
      row(2, 'c', ['a'], 'pending'),
      row(3, 'd', ['a'], 'pending'),
    ]
    const files: Record<string, string[]> = {
      a: ['src/a.ts'],
      b: ['src/shared.ts'],
      c: ['src/shared.ts'],
      d: ['src/other.ts'],
    }
    const picked = selectSectionsToStart({
      rows,
      runningIds: new Set(),
      slots: 2,
      filesOf: (r) => files[r.sectionId] ?? [],
    })
    expect(picked.map((r) => r.sectionId)).toEqual(['b', 'd'])
  })

  test('an empty file list starts alone', () => {
    const rows = [
      row(0, 'a', [], 'completed'),
      row(1, 'b', ['a'], 'pending'),
      row(2, 'c', ['a'], 'pending'),
    ]
    const files: Record<string, string[]> = { a: ['src/a.ts'], b: [], c: ['src/c.ts'] }
    const picked = selectSectionsToStart({
      rows,
      runningIds: new Set(),
      slots: 2,
      filesOf: (r) => files[r.sectionId] ?? [],
    })
    expect(picked.map((r) => r.sectionId)).toEqual(['b'])
  })

  test('an empty candidate skips a running section and blocks later candidates', () => {
    const rows = [
      row(0, 'a', [], 'completed'),
      row(1, 'b', ['a'], 'pending'),
      row(2, 'c', ['a'], 'pending'),
    ]
    const files: Record<string, string[]> = { a: ['src/shared.ts'], b: [], c: ['src/shared.ts'] }
    const picked = selectSectionsToStart({
      rows,
      runningIds: new Set(['a']),
      slots: 2,
      filesOf: (r) => files[r.sectionId] ?? [],
    })
    expect(picked).toEqual([])
  })

  test('a non-positive slot count selects nothing', () => {
    expect(selectSectionsToStart({ rows: diamond, runningIds: new Set(), slots: 0, filesOf })).toEqual([])
  })
})

describe('isLastOpenSectionIndex', () => {
  test('is true only when every other row is completed', () => {
    const rows = [
      row(0, 'a', [], 'completed'),
      row(1, 'b', ['a'], 'in_progress'),
      row(2, 'c', ['a'], 'completed'),
    ]
    expect(isLastOpenSectionIndex(rows, 1)).toBe(true)
    expect(isLastOpenSectionIndex(rows, 0)).toBe(false)
    expect(isLastOpenSectionIndex(rows, 2)).toBe(false)
    expect(isLastOpenSectionIndex([], 0)).toBe(true)
  })
})
