import { MAX_TOTAL_SECTIONS } from '../constants/loop'

/** Allowed section id shape: lowercase letters, digits and hyphens, at most 64 characters. */
export const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Id assigned to a section that did not declare one. */
export function generatedSectionId(index: number): string {
  return `section-${index + 1}`
}

export interface SectionGraphNode {
  index: number
  id: string
  after: string[]
}

/** Row subset the graph helpers need; structurally satisfied by `SectionPlanRow`. */
export interface SectionGraphRow {
  sectionIndex: number
  sectionId: string
  dependsOn: string[]
  status: string
}

/**
 * Validates a section graph and returns actionable errors in a stable order:
 * nodes sorted by index, then each node's own id errors before its dependency
 * errors, then the over-cap error. Dependencies may only point at a lower-index
 * section, so cycles are reported as forward/self dependencies.
 */
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

/** Every id reachable from `sectionId` by following `dependsOn`, excluding itself. */
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

/** Open rows (not completed) whose every dependency is completed, by section index. */
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

/** The first ready section, or null when every open section still waits on a dependency. */
export function selectNextSection<T extends SectionGraphRow>(rows: T[]): T | null {
  return readySections(rows)[0] ?? null
}

/** Two planned file lists conflict when both are non-empty and share a repo-relative path; an empty list conflicts with everything. */
function fileListsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true
  const files = new Set(a)
  return b.some((file) => files.has(file))
}

export interface SelectSectionsToStartInput<T> {
  rows: T[]
  /** Section ids of sections that already have a live run. */
  runningIds: Set<string>
  /** Free section slots; zero or less selects nothing. */
  slots: number
  filesOf: (row: T) => string[]
}

/**
 * Ready sections to start in parallel, by section index, up to `slots`.
 * Sections already running are skipped, and a candidate whose planned files
 * overlap a running or already-picked section is skipped too. An empty file
 * list overlaps everything, so such a section starts only when nothing else
 * runs and nothing starts next to it.
 */
export function selectSectionsToStart<T extends SectionGraphRow>(
  input: SelectSectionsToStartInput<T>,
): T[] {
  const { rows, runningIds, slots, filesOf } = input
  if (slots <= 0) return []

  const occupiedFiles = rows
    .filter((row) => runningIds.has(row.sectionId))
    .map((row) => filesOf(row))
  const picked: T[] = []

  for (const row of readySections(rows)) {
    if (picked.length >= slots) break
    if (runningIds.has(row.sectionId)) continue
    const files = filesOf(row)
    if (occupiedFiles.some((occupied) => fileListsOverlap(files, occupied))) continue
    picked.push(row)
    occupiedFiles.push(files)
  }

  return picked
}

/** True when every row other than `currentIndex` is completed. */
export function isLastOpenSectionIndex(rows: SectionGraphRow[], currentIndex: number): boolean {
  return rows.every(
    (row) => row.sectionIndex === currentIndex || row.status === 'completed',
  )
}
