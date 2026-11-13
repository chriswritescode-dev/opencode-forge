const PHASE_LABELS = new Map([
  ['coding', 'Coding'],
  ['auditing', 'Auditing'],
  ['post_action', 'Post-action'],
])

export function phaseLabel(phase: string): string {
  if (phase === '') return 'Unknown'
  return PHASE_LABELS.get(phase) ?? phase
}
