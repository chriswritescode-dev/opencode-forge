import { MAX_TOTAL_SECTIONS } from '../constants/loop'

export const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function generatedSectionId(index: number): string {
  return `section-${index + 1}`
}

export interface SectionGraphNode {
  index: number
  id: string
  after: string[]
}

export interface SectionGraphRow {
  sectionIndex: number
  sectionId: string
  dependsOn: string[]
  status: string
}

export function validateSectionGraph(
  nodes: SectionGraphNode[],
  opts: { maxSections?: number } = {},
): string[] {
  const maxSections = opts.maxSections ?? MAX_TOTAL_SECTIONS
  const errors: string[] = []
  const sorted = [...nodes].sort((a, b) => a.index - b.index)
  const firstIndexById = new Map<string, number>()
  for (const node of sorted) {
    if (!firstIndexById.has(node.id)) firstIndexById.set(node.id, node.index)
  }

  for (const node of sorted) {
    const sectionNumber = node.index + 1
    if (!SECTION_ID_PATTERN.test(node.id)) {
      errors.push(
        `Section ${sectionNumber} id "${node.id}" is invalid: use lowercase letters, digits, and hyphens (at most 64 characters), starting with a letter or digit.`,
      )
    }

    const firstIndex = firstIndexById.get(node.id)
    if (firstIndex !== undefined && firstIndex !== node.index) {
      errors.push(
        `Section ${sectionNumber} reuses id "${node.id}" already used by section ${firstIndex + 1}; ids must be unique.`,
      )
    }

    for (const dependency of node.after) {
      const targetIndex = firstIndexById.get(dependency)
      if (targetIndex === undefined) {
        errors.push(`Section ${sectionNumber} ("${node.id}") depends on unknown id "${dependency}".`)
        continue
      }
      if (targetIndex >= node.index) {
        errors.push(
          `Section ${sectionNumber} ("${node.id}") depends on "${dependency}", which is section ${targetIndex + 1}: a section may only depend on sections above it. Move "${dependency}" above "${node.id}".`,
        )
      }
    }
  }

  if (sorted.length > maxSections) {
    errors.push(`${sorted.length} sections exceed the cap of ${maxSections}: consolidate phases.`)
  }

  return errors
}

export function ancestorSectionIds(rows: SectionGraphRow[], sectionId: string): Set<string> {
  const byId = new Map(rows.map((row) => [row.sectionId, row]))
  const ancestors = new Set<string>()
  const stack = [...(byId.get(sectionId)?.dependsOn ?? [])]

  while (stack.length > 0) {
    const id = stack.pop()!
    if (ancestors.has(id)) continue
    ancestors.add(id)
    const row = byId.get(id)
    if (row) stack.push(...row.dependsOn)
  }

  return ancestors
}

export function readySections<T extends SectionGraphRow>(rows: T[]): T[] {
  const completedIds = new Set(
    rows.filter((row) => row.status === 'completed').map((row) => row.sectionId),
  )
  return rows
    .filter(
      (row) =>
        row.status !== 'completed'
        && row.dependsOn.every((dependency) => completedIds.has(dependency)),
    )
    .sort((a, b) => a.sectionIndex - b.sectionIndex)
}

export function selectNextSection<T extends SectionGraphRow>(rows: T[]): T | null {
  return readySections(rows)[0] ?? null
}

export function isLastOpenSectionIndex(rows: SectionGraphRow[], currentIndex: number): boolean {
  return rows.every(
    (row) => row.sectionIndex === currentIndex || row.status === 'completed',
  )
}
