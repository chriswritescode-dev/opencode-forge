export type TerminationStatus = 'completed' | 'cancelled' | 'errored' | 'stalled'

export type TerminationReason =
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'user_aborted' }
  | { kind: 'shutdown' }
  | { kind: 'max_iterations' }
  | { kind: 'stall_timeout' }
  | { kind: 'missing_worktree_dir' }
  | { kind: 'session_creation_failed' }
  | { kind: 'audit_retry_exhausted' }
  | { kind: 'final_audit_retry_exhausted' }
  | { kind: 'coding_no_assistant' }
  | { kind: 'restart_prompt_failed' }
  | { kind: 'worktree_failed'; message: string }
  | { kind: 'error_max_retries'; message: string }
  | { kind: 'provider_limit'; message: string }

export function terminationStatusFor(reason: TerminationReason): TerminationStatus {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'cancelled':
    case 'user_aborted':
    case 'shutdown':
      return 'cancelled'
    case 'stall_timeout':
      return 'stalled'
    default:
      return 'errored'
  }
}

export function terminationReasonToString(reason: TerminationReason): string {
  switch (reason.kind) {
    case 'worktree_failed':
      return `worktree_failed: ${reason.message}`
    case 'error_max_retries':
      return `error_max_retries: ${reason.message}`
    case 'provider_limit':
      return `provider_limit: ${reason.message}`
    default:
      return reason.kind
  }
}

export function parseTerminationReasonString(str: string): TerminationReason {
  const idx = str.indexOf(': ')
  if (idx >= 0) {
    const prefix = str.substring(0, idx)
    const message = str.substring(idx + 2)
    if (prefix === 'worktree_failed') return { kind: 'worktree_failed', message }
    if (prefix === 'error_max_retries') return { kind: 'error_max_retries', message }
    if (prefix === 'provider_limit') return { kind: 'provider_limit', message }
  }

  // For simple kinds without messages
  const knownKinds = [
    'completed', 'cancelled', 'user_aborted', 'shutdown',
    'max_iterations', 'stall_timeout', 'missing_worktree_dir',
    'session_creation_failed', 'audit_retry_exhausted',
    'final_audit_retry_exhausted', 'coding_no_assistant',
    'restart_prompt_failed',
  ] as const

  if ((knownKinds as readonly string[]).includes(str)) {
    return { kind: str as typeof knownKinds[number] }
  }

  return { kind: 'error_max_retries', message: str } as TerminationReason
}
