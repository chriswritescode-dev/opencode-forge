export const RECURRENCE_ESCALATION_THRESHOLD = 3

export function findingRecurrenceKey(f: { file: string; line: number; sectionIndex: number | null }): string {
  return `${f.sectionIndex ?? 'x'}:${f.file}:${f.line}`
}

/**
 * Whether a finding's recurrence count has reached the escalation threshold
 * that forces escalated remediation (and fresh loop sessions).
 */
export function isRecurrenceEscalated(count: number): boolean {
  return count >= RECURRENCE_ESCALATION_THRESHOLD
}

/**
 * Whether any of `findings` has recurred enough times to escalate. The single
 * threshold check shared by the prompt escalation blocks and the session-reuse
 * predicate.
 */
export function hasEscalatedFindings(
  findings: { file: string; line: number; sectionIndex: number | null }[],
  recurrence: Map<string, number>,
): boolean {
  return findings.some((f) => isRecurrenceEscalated(recurrence.get(findingRecurrenceKey(f)) ?? 0))
}

export function bumpRecurrence(prev: Map<string, number>, currentKeys: string[]): Map<string, number> {
  const next = new Map<string, number>()
  for (const key of currentKeys) {
    next.set(key, (prev.get(key) ?? 0) + 1)
  }
  return next
}
