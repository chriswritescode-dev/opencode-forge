/**
 * Centralized session title helpers for consistent naming across loop and audit sessions.
 */

export const MAX_SESSION_TITLE_LENGTH = 60

/**
 * Truncates a title to the specified length, adding ellipsis if needed.
 */
export function truncateSessionTitle(title: string, maxLength = MAX_SESSION_TITLE_LENGTH): string {
  return title.length > maxLength ? `${title.substring(0, maxLength - 3)}...` : title
}

/**
 * Formats a loop session title with 'Loop: ' prefix.
 * Idempotent: will not double-prefix if already prefixed.
 */
export function formatLoopSessionTitle(title: string): string {
  const raw = title.startsWith('Loop: ') ? title : `Loop: ${title}`
  return truncateSessionTitle(raw)
}

/**
 * Formats a plan execution session title (non-loop).
 */
export function formatPlanSessionTitle(title: string): string {
  return truncateSessionTitle(title)
}

/**
 * Formats an audit session title with loop name and iteration.
 */
export function formatAuditSessionTitle(loopName: string, iteration: number): string {
  return truncateSessionTitle(`audit: ${loopName} #${iteration}`)
}
