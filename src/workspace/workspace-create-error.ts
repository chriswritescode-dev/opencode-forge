/**
 * Classifier for workspace-creation failures in the Forge loop lifecycle.
 *
 * OpenCode returns inconsistent errors when the experimental workspace runtime
 * is absent, so this module provides a single source of truth for surfacing
 * actionable guidance to the user in the loop tool result and TUI dialog toast.
 */

export type WorkspaceCreateFailureReason =
  | 'experimental-workspaces-disabled'
  | 'no-workspace-id'
  | 'empty-directory'
  | 'unknown'

export interface WorkspaceCreateError {
  reason: WorkspaceCreateFailureReason
  /** Actionable, user-facing message (single line, safe for toast + tool text). */
  message: string
  /** Raw underlying error text when available, for logs. */
  cause?: string
}

/**
 * Canonical fix instruction — single source of truth for all surfaces.
 */
export const EXPERIMENTAL_WORKSPACES_HINT =
  'Loops require OpenCode 1.17.8+ with OPENCODE_EXPERIMENTAL_WORKSPACES=true. Set it before starting OpenCode (e.g. `export OPENCODE_EXPERIMENTAL_WORKSPACES=true`) and restart.'

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    if (typeof s === 'string' && s.length > 300) return s.slice(0, 300) + '…'
    return s ?? ''
  } catch {
    const s = String(v)
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }
}

/**
 * Keywords that, when present in an error message (case-insensitive), indicate
 * the experimental workspace runtime is not enabled.
 */
const EXPERIMENTAL_HINT_KEYWORDS = [
  'experimental',
  'workspace.create',
  'not enabled',
  'disabled',
]

/**
 * Secondary keywords — only treated as a match if at least one of the primary
 * keywords is ALSO present.
 */
const SECONDARY_KEYWORDS = ['unknown method', 'not found']

function isExperimentalWorkspacesDisabled(text: string): boolean {
  const lower = text.toLowerCase()
  const hasPrimary = EXPERIMENTAL_HINT_KEYWORDS.some((kw) => lower.includes(kw))
  if (hasPrimary) return true
  const hasSecondary = SECONDARY_KEYWORDS.some((kw) => lower.includes(kw))
  if (hasSecondary && lower.includes('workspace')) return true
  return false
}

// ── Public classifiers ────────────────────────────────────────────────────────

/**
 * Classify a thrown error from a workspace.create call.
 *
 * Because OpenCode returns inconsistent errors when the runtime is absent, an
 * unrecognised or empty throw is classified as `experimental-workspaces-disabled`
 * (the dominant cause). A throw with a clearly unrelated message (contains none
 * of the hint keywords AND is non-empty) is `unknown`.
 */
export function classifyWorkspaceCreateThrow(err: unknown): WorkspaceCreateError {
  const text = err instanceof Error ? err.message : String(err)

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

/**
 * Classify a response where `workspace.create` returned but had no `id`.
 * A missing id is the symptom of a no-op adapter when the flag is off.
 */
export function workspaceCreateMissingId(raw: unknown): WorkspaceCreateError {
  return {
    reason: 'no-workspace-id',
    message: `Failed to create worktree workspace (no workspace id returned). ${EXPERIMENTAL_WORKSPACES_HINT}`,
    cause: safeStringify(raw),
  }
}

/**
 * Classify a response where `workspace.create` returned an id but the directory
 * is empty.
 */
export function workspaceCreateEmptyDirectory(raw: unknown): WorkspaceCreateError {
  return {
    reason: 'empty-directory',
    message: 'Worktree workspace was created but reported no directory. Check forge logs and OpenCode version.',
    cause: safeStringify(raw),
  }
}
