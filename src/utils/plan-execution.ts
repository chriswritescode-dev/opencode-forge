/**
 * Shared plan execution utilities for TUI and tool-side approval.
 * 
 * This module provides canonical execution labels and title extraction
 * that both the TUI and plan-approval tool can import.
 */

/**
 * Canonical execution mode labels used by both TUI and architect approval.
 * These labels must match exactly to ensure consistent UX across interfaces.
 */
export const PLAN_EXECUTION_LABELS = [
  'New session',
  'Execute here',
  'Loop (worktree)',
  'Loop',
] as const

export type PlanExecutionLabel = typeof PLAN_EXECUTION_LABELS[number]

/**
 * Extracts a title from plan content for display purposes.
 * Uses the first heading if available, otherwise falls back to first line.
 * Truncates to 60 characters with ellipsis if needed.
 */
export function extractPlanTitle(planContent: string): string {
  const headingMatch = planContent.match(/^#+\s+(.+)$/m)
  if (headingMatch?.[1]) {
    const title = headingMatch[1].trim()
    return title.length > 60 ? `${title.substring(0, 57)}...` : title
  }
  const firstLine = planContent.split('\n')[0]?.trim()
  if (firstLine) {
    return firstLine.length > 60 ? `${firstLine.substring(0, 57)}...` : firstLine
  }
  return 'Implementation Plan'
}

/**
 * Result of loop name extraction with both display and sanitized names.
 */
export interface LoopNameResult {
  /** Display name: exactly what should be shown to users */
  displayName: string
  /** Execution/worktree name: sanitized slug for worktree creation, KV keys, and uniqueness */
  executionName: string
}

/**
 * Extracts a short loop name from plan content for worktree/session naming.
 * 
 * Accepts the following markdown formats:
 * - `Loop Name: foo`
 * - `**Loop Name**: foo`
 * - `- **Loop Name**: foo` (with list prefix)
 * - Optional leading whitespace
 * 
 * Priority order:
 * 1. Explicit "Loop Name:" field if present (machine-friendly, intent-based)
 * 2. First heading/title (fallback for older plans)
 * 3. Default "loop" fallback
 * 
 * The result is truncated to 60 characters.
 */
export function extractLoopName(planContent: string): string {
  // Try to find explicit loop name field first
  // Accepts: "Loop Name: foo", "**Loop Name**: foo", "- **Loop Name**: foo"
  // with optional leading whitespace and markdown list prefixes
  const loopNameMatch = planContent.match(/^(?:\s*(?:-\s*)?)?(?:\*\*)?Loop Name(?:\*\*)?:\s*(.+)$/m)
  if (loopNameMatch?.[1]) {
    const name = loopNameMatch[1].trim()
    return name.length > 60 ? name.substring(0, 60) : name
  }
  
  // Fallback to title extraction for older plans
  const title = extractPlanTitle(planContent)
  return title
}

/**
 * Extracts both display and execution names from plan content.
 * 
 * Returns a LoopNameResult with:
 * - displayName: the exact loop name from the plan (for user-facing display)
 * - executionName: sanitized version safe for worktree names and KV keys
 * 
 * This is the preferred way to get loop naming information.
 */
export function extractLoopNames(planContent: string): LoopNameResult {
  const displayName = extractLoopName(planContent)
  const executionName = sanitizeLoopName(displayName)
  return { displayName, executionName }
}

/**
 * Sanitizes a string for use as a worktree/loop name.
 * Converts to lowercase, replaces non-alphanumeric chars with hyphens, removes leading/trailing hyphens.
 */
export function sanitizeLoopName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'loop'
}

/**
 * Normalizes a mode string to lowercase for comparison.
 */
function normalizeModeLabel(label: string): string {
  return label.toLowerCase()
}

/**
 * Checks if a given label matches one of the canonical execution labels.
 * Returns the matched canonical label or null if no match.
 */
export function matchExecutionLabel(input: string): PlanExecutionLabel | null {
  const normalized = normalizeModeLabel(input)
  for (const label of PLAN_EXECUTION_LABELS) {
    if (normalized === label.toLowerCase() || normalized.startsWith(label.toLowerCase())) {
      return label
    }
  }
  return null
}
