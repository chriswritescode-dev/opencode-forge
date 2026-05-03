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
 * Structural plan headings that should not be used as titles.
 * These are section markers, not actual plan titles.
 */
const STRUCTURAL_PLAN_HEADINGS = new Set([
  'objective',
  'loop name',
  'phases',
  'verification',
  'decisions',
  'conventions',
  'key context',
])

/**
 * Extracts a title from plan content for display purposes.
 * Skips structural headings like "Objective" and returns the first non-structural heading.
 * Falls back to first line if no suitable heading exists.
 * Truncates to 60 characters with ellipsis if needed.
 */
export function extractPlanTitle(planContent: string): string {
  const headings: Array<{ text: string; line: number }> = []
  const lines = planContent.split('\n')
  
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#+\s+(.+)$/)
    if (match) {
      headings.push({ text: match[1].trim(), line: i })
    }
  }
  
  // Find first non-structural heading
  for (const heading of headings) {
    const normalized = heading.text.toLowerCase()
    if (!STRUCTURAL_PLAN_HEADINGS.has(normalized)) {
      const title = heading.text
      return title.length > 60 ? `${title.substring(0, 57)}...` : title
    }
  }
  
  // If all headings are structural, try explicit Loop Name field
  const loopNameFromHeading = extractLoopNameFromHeading(planContent)
  if (loopNameFromHeading) {
    return loopNameFromHeading.length > 60 ? `${loopNameFromHeading.substring(0, 57)}...` : loopNameFromHeading
  }
  
  // Try first sentence/line under Objective
  const objectiveMatch = planContent.match(/^#+\s+Objective\s*\n+(.+)$/im)
  if (objectiveMatch?.[1]) {
    const firstLine = objectiveMatch[1].trim().split('\n')[0]
    if (firstLine) {
      return firstLine.length > 60 ? `${firstLine.substring(0, 57)}...` : firstLine
    }
  }
  
  // Fall back to first non-empty non-marker line
  const firstLine = planContent.split('\n').find(line => line.trim() && !line.trim().startsWith('---'))
  if (firstLine) {
    const trimmed = firstLine.trim()
    return trimmed.length > 60 ? `${trimmed.substring(0, 57)}...` : trimmed
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
 * Extracts loop name from heading-style field.
 * Handles:
 * - `## Loop Name: approval-main-restore`
 * - `## Loop Name\n\napproval-main-restore`
 */
function extractLoopNameFromHeading(planContent: string): string | null {
  // Try heading with inline value: ## Loop Name: value
  const headingInlineMatch = planContent.match(/^#+\s*Loop Name:\s*(.+)$/im)
  if (headingInlineMatch?.[1]) {
    const name = headingInlineMatch[1].trim()
    return name.length > 60 ? name.substring(0, 60) : name
  }
  
  // Try heading followed by value on next line: ## Loop Name\n\nvalue
  const headingBlockMatch = planContent.match(/^#+\s*Loop Name\s*\n+\s*([^\n#]+)/im)
  if (headingBlockMatch?.[1]) {
    const name = headingBlockMatch[1].trim()
    return name.length > 60 ? name.substring(0, 60) : name
  }
  
  return null
}

/**
 * Extracts a short loop name from plan content for worktree/session naming.
 * 
 * Accepts the following markdown formats:
 * - `Loop Name: foo`
 * - `**Loop Name**: foo`
 * - `- **Loop Name**: foo` (with list prefix)
 * - `## Loop Name: foo` (heading style)
 * - `## Loop Name\n\nfoo` (heading with value on next line)
 * - Optional leading whitespace
 * 
 * Priority order:
 * 1. Inline "Loop Name:" field (machine-friendly, intent-based)
 * 2. Heading-style "## Loop Name:" field
 * 3. Heading-style "## Loop Name" followed by value on next line
 * 4. Non-structural plan title from extractPlanTitle
 * 5. Default "loop" fallback
 * 
 * The result is truncated to 60 characters.
 */
export function extractLoopName(planContent: string): string {
  // Try inline loop name field first
  // Accepts: "Loop Name: foo", "**Loop Name**: foo", "- **Loop Name**: foo"
  // with optional leading whitespace and markdown list prefixes
  const loopNameMatch = planContent.match(/^(?:\s*(?:-\s*)?)?(?:\*\*)?Loop Name(?:\*\*)?:\s*(.+)$/m)
  if (loopNameMatch?.[1]) {
    const name = loopNameMatch[1].trim()
    return name.length > 60 ? name.substring(0, 60) : name
  }
  
  // Try heading-style loop name
  const headingLoopName = extractLoopNameFromHeading(planContent)
  if (headingLoopName) {
    return headingLoopName
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
