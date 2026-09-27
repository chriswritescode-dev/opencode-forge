/** Single source of human phase display text; unknown phases pass through. */
const PHASE_LABELS: Record<string, string> = {
  coding: 'Coding',
  auditing: 'Auditing',
  final_auditing: 'Final audit',
  final_audit_fix: 'Final audit fix',
  post_action: 'Post-action',
}

/** Display label for a loop phase, shared by the dashboard and the TUI sidebar. */
export function phaseLabel(phase: string): string {
  if (phase === '') return 'Unknown'
  return PHASE_LABELS[phase] ?? phase
}
