import type { WorkspaceCreateResult } from '../client/port'

export type WorkspaceCreateFailureReason =
  | 'experimental-workspaces-disabled'
  | 'no-workspace-id'
  | 'empty-directory'
  | 'unknown'

export interface WorkspaceCreateError {
  reason: WorkspaceCreateFailureReason
  message: string
  cause?: string
}

export const EXPERIMENTAL_WORKSPACES_HINT =
  'Loops require OpenCode 1.17.8+ with OPENCODE_EXPERIMENTAL_WORKSPACES=true. Set it before starting OpenCode (e.g. `export OPENCODE_EXPERIMENTAL_WORKSPACES=true`) and restart.'

function safeStringify(value: WorkspaceCreateResult): string {
  try {
    const text = JSON.stringify(value) ?? ''
    if (text.length > 300) return text.slice(0, 300) + '…'
    return text
  } catch {
    const text = String(value)
    return text.length > 300 ? text.slice(0, 300) + '…' : text
  }
}

const EXPERIMENTAL_HINT_KEYWORDS = [
  'experimental',
  'workspace.create',
  'not enabled',
  'disabled',
]

const SECONDARY_KEYWORDS = ['unknown method', 'not found']

function isExperimentalWorkspacesDisabled(text: string): boolean {
  const lower = text.toLowerCase()
  const hasPrimary = EXPERIMENTAL_HINT_KEYWORDS.some((kw) => lower.includes(kw))
  if (hasPrimary) return true
  const hasSecondary = SECONDARY_KEYWORDS.some((kw) => lower.includes(kw))
  if (hasSecondary && lower.includes('workspace')) return true
  return false
}

export function classifyWorkspaceCreateThrow(cause: unknown): WorkspaceCreateError {
  const text = cause instanceof Error ? cause.message : String(cause)

  if (!text || text === 'undefined' || text === 'null' || isExperimentalWorkspacesDisabled(text)) {
    return {
      reason: 'experimental-workspaces-disabled',
      message: EXPERIMENTAL_WORKSPACES_HINT,
      cause: text || undefined,
    }
  }

  return {
    reason: 'unknown',
    message: `Failed to create worktree workspace: ${text}`,
    cause: text,
  }
}

export function workspaceCreateMissingId(raw: WorkspaceCreateResult): WorkspaceCreateError {
  return {
    reason: 'no-workspace-id',
    message: `Failed to create worktree workspace (no workspace id returned). ${EXPERIMENTAL_WORKSPACES_HINT}`,
    cause: safeStringify(raw),
  }
}

export function workspaceCreateEmptyDirectory(raw: WorkspaceCreateResult): WorkspaceCreateError {
  return {
    reason: 'empty-directory',
    message: 'Worktree workspace was created but reported no directory. Check forge logs and OpenCode version.',
    cause: safeStringify(raw),
  }
}
