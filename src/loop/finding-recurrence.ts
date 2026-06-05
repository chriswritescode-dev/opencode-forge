export const RECURRENCE_ESCALATION_THRESHOLD = 3

export function findingRecurrenceKey(f: { file: string; line: number; sectionIndex: number | null }): string {
  return `${f.sectionIndex ?? 'x'}:${f.file}:${f.line}`
}

export function bumpRecurrence(prev: Map<string, number>, currentKeys: string[]): Map<string, number> {
  const next = new Map<string, number>()
  for (const key of currentKeys) {
    next.set(key, (prev.get(key) ?? 0) + 1)
  }
  return next
}
