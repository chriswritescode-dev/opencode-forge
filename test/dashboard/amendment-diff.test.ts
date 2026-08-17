import { describe, test, expect } from 'vitest'
import {
  diffAmendmentSnapshots,
  summarizeAmendmentSnapshots,
} from '../../src/dashboard/amendment-diff'

function snapshot(sections: Array<{ index: number; title: string; content?: string }>): string {
  return JSON.stringify(sections.map(s => ({ index: s.index, title: s.title, content: s.content ?? '' })))
}

function texts(lines: Array<{ kind: string; text: string }>, kind: string): string[] {
  return lines.filter(l => l.kind === kind).map(l => l.text)
}

describe('diffAmendmentSnapshots', () => {
  test('an untouched section is unchanged and carries no lines', () => {
    const same = snapshot([{ index: 2, title: 'Wire the repo', content: 'a\nb' }])
    const diff = diffAmendmentSnapshots(same, same)

    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 0 })
    expect(diff.sections).toHaveLength(1)
    expect(diff.sections[0].change).toBe('unchanged')
    expect(diff.sections[0].lines).toEqual([])
    expect(diff.sections[0].previousTitle).toBeNull()
  })

  test('counts added, removed and modified sections', () => {
    const before = snapshot([
      { index: 1, title: 'Keep', content: 'same' },
      { index: 2, title: 'Edit', content: 'old' },
      { index: 3, title: 'Drop', content: 'gone' },
    ])
    const after = snapshot([
      { index: 1, title: 'Keep', content: 'same' },
      { index: 2, title: 'Edit', content: 'new' },
      { index: 4, title: 'Fresh', content: 'added' },
    ])
    const diff = diffAmendmentSnapshots(before, after)

    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1 })
    expect(diff.sections.map(s => [s.index, s.change])).toEqual([
      [1, 'unchanged'],
      [2, 'modified'],
      [3, 'removed'],
      [4, 'added'],
    ])
  })

  test('sections are ordered by index regardless of snapshot order', () => {
    const before = snapshot([{ index: 7, title: 'G' }, { index: 2, title: 'B' }])
    const after = snapshot([{ index: 2, title: 'B' }, { index: 7, title: 'G' }])

    expect(diffAmendmentSnapshots(before, after).sections.map(s => s.index)).toEqual([2, 7])
  })

  test('a removed section keeps its old title and emits its content as removals', () => {
    const diff = diffAmendmentSnapshots(
      snapshot([{ index: 5, title: 'Obsolete', content: 'one\ntwo' }]),
      snapshot([]),
    )

    expect(diff.sections[0].title).toBe('Obsolete')
    expect(diff.sections[0].lines).toEqual([
      { kind: 'remove', text: 'one' },
      { kind: 'remove', text: 'two' },
    ])
  })

  test('an added section emits its content as additions', () => {
    const diff = diffAmendmentSnapshots(
      snapshot([]),
      snapshot([{ index: 0, title: 'New', content: 'one\ntwo' }]),
    )

    expect(diff.sections[0].title).toBe('New')
    expect(diff.sections[0].lines).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ])
  })

  test('a title-only change is modified, reports the old title, and has no line changes', () => {
    const diff = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'Old name', content: 'body' }]),
      snapshot([{ index: 1, title: 'New name', content: 'body' }]),
    )

    expect(diff.summary.modified).toBe(1)
    expect(diff.sections[0].title).toBe('New name')
    expect(diff.sections[0].previousTitle).toBe('Old name')
    expect(diff.sections[0].lines).toEqual([])
  })

  test('a content edit diffs line by line and keeps surrounding context', () => {
    const diff = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'S', content: 'alpha\nbravo\ncharlie' }]),
      snapshot([{ index: 1, title: 'S', content: 'alpha\nbravo replaced\ncharlie' }]),
    )

    expect(diff.sections[0].previousTitle).toBeNull()
    expect(diff.sections[0].lines).toEqual([
      { kind: 'context', text: 'alpha' },
      { kind: 'remove', text: 'bravo' },
      { kind: 'add', text: 'bravo replaced' },
      { kind: 'context', text: 'charlie' },
    ])
  })

  test('an insertion is reported as a pure addition rather than a rewrite', () => {
    const diff = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'S', content: 'a\nb\nc' }]),
      snapshot([{ index: 1, title: 'S', content: 'a\nb\nb2\nc' }]),
    )

    expect(texts(diff.sections[0].lines, 'remove')).toEqual([])
    expect(texts(diff.sections[0].lines, 'add')).toEqual(['b2'])
  })

  test('long unchanged runs collapse into one gap marker', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const before = [...filler, 'target', ...filler].join('\n')
    const after = [...filler, 'replacement', ...filler].join('\n')
    const { lines } = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'S', content: before }]),
      snapshot([{ index: 1, title: 'S', content: after }]),
    ).sections[0]

    const gaps = lines.filter(l => l.kind === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps[0].text).toBe('27 unchanged lines')
    expect(gaps[1].text).toBe('27 unchanged lines')
    expect(texts(lines, 'context')).toHaveLength(6)
    expect(texts(lines, 'remove')).toEqual(['target'])
    expect(texts(lines, 'add')).toEqual(['replacement'])
  })

  test('a short unchanged run is left intact rather than replaced by a gap', () => {
    const before = ['x', 'a', 'b', 'c', 'y'].join('\n')
    const after = ['X', 'a', 'b', 'c', 'Y'].join('\n')
    const { lines } = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'S', content: before }]),
      snapshot([{ index: 1, title: 'S', content: after }]),
    ).sections[0]

    expect(lines.some(l => l.kind === 'gap')).toBe(false)
    expect(texts(lines, 'context')).toEqual(['a', 'b', 'c'])
  })

  test('very large sections fall back to a wholesale replace', () => {
    const before = Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n')
    const { lines } = diffAmendmentSnapshots(
      snapshot([{ index: 1, title: 'S', content: before }]),
      snapshot([{ index: 1, title: 'S', content: after }]),
    ).sections[0]

    expect(texts(lines, 'remove')).toHaveLength(900)
    expect(texts(lines, 'add')).toHaveLength(900)
    expect(lines[0]).toEqual({ kind: 'remove', text: 'old 0' })
    expect(lines[900]).toEqual({ kind: 'add', text: 'new 0' })
  })

  test('malformed and non-array snapshots yield an empty diff instead of throwing', () => {
    expect(diffAmendmentSnapshots('not json', '{"nope":1}')).toEqual({
      sections: [],
      summary: { added: 0, removed: 0, modified: 0 },
    })

    const partial = diffAmendmentSnapshots('[]', '[{"index":"x"},{"index":1,"title":"Ok"}]')
    expect(partial.sections.map(s => s.index)).toEqual([1])
    expect(partial.summary).toEqual({ added: 1, removed: 0, modified: 0 })
  })

  test('entries missing title or content are tolerated', () => {
    const diff = diffAmendmentSnapshots('[{"index":1}]', '[{"index":1,"content":"body"}]')

    expect(diff.sections[0].change).toBe('modified')
    expect(diff.sections[0].title).toBe('')
    expect(diff.sections[0].lines).toEqual([{ kind: 'add', text: 'body' }])
  })
})

describe('summarizeAmendmentSnapshots', () => {
  test('matches the summary of the full diff without computing lines', () => {
    const before = snapshot([
      { index: 1, title: 'A', content: 'x' },
      { index: 2, title: 'B', content: 'y' },
    ])
    const after = snapshot([
      { index: 1, title: 'A', content: 'x' },
      { index: 2, title: 'B2', content: 'y2' },
      { index: 3, title: 'C', content: 'z' },
    ])

    expect(summarizeAmendmentSnapshots(before, after))
      .toEqual(diffAmendmentSnapshots(before, after).summary)
    expect(summarizeAmendmentSnapshots(before, after)).toEqual({ added: 1, removed: 0, modified: 1 })
  })

  test('is zeroed for malformed input', () => {
    expect(summarizeAmendmentSnapshots('oops', 'oops')).toEqual({ added: 0, removed: 0, modified: 0 })
  })
})
