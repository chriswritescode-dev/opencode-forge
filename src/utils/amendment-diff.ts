import { z } from 'zod'

interface AmendmentSnapshotSection {
  index: number
  title: string
  content: string
}

export type AmendmentSectionChange = 'added' | 'removed' | 'modified' | 'unchanged'

export interface AmendmentDiffLine {
  kind: 'add' | 'remove' | 'context' | 'gap'
  text: string
}

export interface AmendmentSectionDiff {
  index: number
  change: AmendmentSectionChange
  title: string
  previousTitle: string | null
  lines: AmendmentDiffLine[]
}

export interface AmendmentChangeSummary {
  added: number
  removed: number
  modified: number
}

export interface AmendmentDiff {
  sections: AmendmentSectionDiff[]
  summary: AmendmentChangeSummary
}

const CONTEXT_LINES = 3

const MAX_DIFF_LINES = 800

const snapshotSectionSchema = z.object({
  index: z.number(),
  title: z.string().optional(),
  content: z.string().optional(),
})

const snapshotArraySchema = z.array(z.unknown())

function parseSnapshot(json: string): Map<number, AmendmentSnapshotSection> {
  const sections = new Map<number, AmendmentSnapshotSection>()
  let parsed: ReturnType<typeof snapshotArraySchema.safeParse>
  try {
    parsed = snapshotArraySchema.safeParse(JSON.parse(json))
  } catch {
    return sections
  }
  if (!parsed.success) return sections
  for (const entry of parsed.data) {
    const row = snapshotSectionSchema.safeParse(entry)
    if (!row.success) continue
    sections.set(row.data.index, {
      index: row.data.index,
      title: row.data.title ?? '',
      content: row.data.content ?? '',
    })
  }
  return sections
}

interface SectionPair {
  index: number
  before: AmendmentSnapshotSection | null
  after: AmendmentSnapshotSection | null
  change: AmendmentSectionChange
}

function classify(
  before: AmendmentSnapshotSection | null,
  after: AmendmentSnapshotSection | null,
): AmendmentSectionChange {
  if (!before) return 'added'
  if (!after) return 'removed'
  return before.title === after.title && before.content === after.content ? 'unchanged' : 'modified'
}

function pairSections(beforeJson: string, afterJson: string): SectionPair[] {
  const before = parseSnapshot(beforeJson)
  const after = parseSnapshot(afterJson)
  const indexes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)
  return indexes.map(index => {
    const b = before.get(index) ?? null
    const a = after.get(index) ?? null
    return { index, before: b, after: a, change: classify(b, a) }
  })
}

function summarize(pairs: SectionPair[]): AmendmentChangeSummary {
  const summary: AmendmentChangeSummary = { added: 0, removed: 0, modified: 0 }
  for (const pair of pairs) {
    if (pair.change === 'added') summary.added += 1
    else if (pair.change === 'removed') summary.removed += 1
    else if (pair.change === 'modified') summary.modified += 1
  }
  return summary
}

function line(kind: AmendmentDiffLine['kind'], text: string): AmendmentDiffLine {
  return { kind, text }
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split('\n')
}

function lcsDiff(before: string[], after: string[]): AmendmentDiffLine[] {
  const n = before.length
  const m = after.length
  const width = m + 1
  const lengths = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = before[i] === after[j]
        ? lengths[(i + 1) * width + (j + 1)] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + (j + 1)])
    }
  }

  const lines: AmendmentDiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push(line('context', before[i]))
      i += 1
      j += 1
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + (j + 1)]) {
      lines.push(line('remove', before[i]))
      i += 1
    } else {
      lines.push(line('add', after[j]))
      j += 1
    }
  }
  while (i < n) {
    lines.push(line('remove', before[i]))
    i += 1
  }
  while (j < m) {
    lines.push(line('add', after[j]))
    j += 1
  }
  return lines
}

function collapseContext(lines: AmendmentDiffLine[]): AmendmentDiffLine[] {
  const out: AmendmentDiffLine[] = []
  let run: AmendmentDiffLine[] = []

  const flush = (atEnd: boolean): void => {
    if (run.length === 0) return
    const keepBefore = out.length === 0 ? 0 : CONTEXT_LINES
    const keepAfter = atEnd ? 0 : CONTEXT_LINES
    const hidden = run.length - keepBefore - keepAfter
    if (hidden <= 1) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, keepBefore))
      out.push(line('gap', `${hidden} unchanged lines`))
      out.push(...run.slice(run.length - keepAfter))
    }
    run = []
  }

  for (const entry of lines) {
    if (entry.kind === 'context') {
      run.push(entry)
      continue
    }
    flush(false)
    out.push(entry)
  }
  flush(true)
  return out
}

function diffContent(beforeText: string, afterText: string): AmendmentDiffLine[] {
  if (beforeText === afterText) return []
  const before = splitLines(beforeText)
  const after = splitLines(afterText)

  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const middleBefore = before.slice(start, endBefore)
  const middleAfter = after.slice(start, endAfter)
  const middle = middleBefore.length > MAX_DIFF_LINES || middleAfter.length > MAX_DIFF_LINES
    ? [
        ...middleBefore.map(text => line('remove', text)),
        ...middleAfter.map(text => line('add', text)),
      ]
    : lcsDiff(middleBefore, middleAfter)

  return collapseContext([
    ...before.slice(0, start).map(text => line('context', text)),
    ...middle,
    ...before.slice(endBefore).map(text => line('context', text)),
  ])
}

export function summarizeAmendmentSnapshots(beforeJson: string, afterJson: string): AmendmentChangeSummary {
  return summarize(pairSections(beforeJson, afterJson))
}

export function diffAmendmentSnapshots(beforeJson: string, afterJson: string): AmendmentDiff {
  const pairs = pairSections(beforeJson, afterJson)
  const sections = pairs.map(pair => ({
    index: pair.index,
    change: pair.change,
    title: (pair.change === 'removed' ? pair.before?.title : pair.after?.title) ?? '',
    previousTitle: pair.before && pair.after && pair.before.title !== pair.after.title
      ? pair.before.title
      : null,
    lines: pair.change === 'unchanged'
      ? []
      : diffContent(pair.before?.content ?? '', pair.after?.content ?? ''),
  }))
  return { sections, summary: summarize(pairs) }
}
