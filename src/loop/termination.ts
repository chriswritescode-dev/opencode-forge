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
  | { kind: 'handoff_missing' }
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

  const plain = plainTerminationReason(str)
  if (plain) return plain

  return { kind: 'error_max_retries', message: str }
}

function plainTerminationReason(str: string): TerminationReason | null {
  switch (str) {
    case 'completed':
      return { kind: 'completed' }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'user_aborted':
      return { kind: 'user_aborted' }
    case 'shutdown':
      return { kind: 'shutdown' }
    case 'max_iterations':
      return { kind: 'max_iterations' }
    case 'stall_timeout':
      return { kind: 'stall_timeout' }
    case 'missing_worktree_dir':
      return { kind: 'missing_worktree_dir' }
    case 'session_creation_failed':
      return { kind: 'session_creation_failed' }
    case 'handoff_missing':
      return { kind: 'handoff_missing' }
    case 'restart_prompt_failed':
      return { kind: 'restart_prompt_failed' }
    default:
      return null
  }
}
